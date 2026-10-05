import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { TurnBroker } from '../src/broker.js';
import { Core } from '../src/core.js';

function setup() {
  const store = new Store(':memory:');
  const run = store.createRun({ prompt: 'Review the supplied source and preserve the root goal.', workspace: process.cwd(), runtime: 'claude-code' });
  const turn = store.startTurn({ runId: run.runId, agentId: 'orchestrator', taskId: run.tasks[0].taskId, prompt: 'review', context: { workspace: process.cwd() } });
  const broker = new TurnBroker({ store, workspaceForRun: id => store.getRun(id).workspace, runtimeForParent: () => 'claude-code' });
  return { store, run, turn, broker };
}

test('human clientMessageId retries reconcile exactly and reject changed content', () => {
  const { store, run, turn } = setup();
  try {
    const message = { body: 'Please inspect the parser.', format: 'text', contextRefs: [], clientMessageId: 'client-12345678' };
    const first = store.humanMessage(run.runId, message);
    const retry = store.humanMessage(run.runId, message);
    assert.equal(retry.messageId, first.messageId);
    assert.equal(retry.turnId, first.turnId);
    assert.equal(store.listEvents(run.runId).filter(e => e.messageId === first.messageId).length, 1);
    assert.throws(() => store.humanMessage(run.runId, { ...message, body: 'Different text' }), { message: 'client_message_conflict' });
  } finally { store.close(); }
});

test('inbox is acknowledged only with a completed accepted turn envelope', () => {
  const { store, run, turn } = setup();
  try {
    const accepted = store.humanMessage(run.runId, { body: 'Review.', clientMessageId: 'client-abcdefgh' });
    const queued = store.getTurn(run.runId, accepted.turnId);
    assert.equal(store.db.prepare('SELECT included_turn_id FROM inbox WHERE client_message_id=?').get('client-abcdefgh').included_turn_id, queued.turnId);
    assert.equal(store.finishTurn({ runId: run.runId, turnId: turn.turnId, generation: turn.generation, outcome: { status: 'completed', text: 'Previous turn.' }, actorId: 'orchestrator' }), true);
    const active = store.activateQueued(run.runId, 'orchestrator');
    assert.equal(active.turnId, queued.turnId);
    assert.equal(store.finishTurn({ runId: run.runId, turnId: active.turnId, generation: active.generation, outcome: { status: 'outcome_uncertain', error: { code: 'test', message: 'uncertain', retryable: false } }, actorId: 'orchestrator' }), true);
    assert.equal(store.db.prepare('SELECT acked_at FROM inbox WHERE client_message_id=?').get('client-abcdefgh').acked_at, null);
    store.setRunStatus(run.runId, 'running', 'test resume');
    const next = store.startTurn({ runId: run.runId, agentId: 'orchestrator', prompt: 'reconcile', context: { workspace: process.cwd() } });
    assert.deepEqual(next.inboxIds, queued.inboxIds);
    assert.equal(store.finishTurn({ runId: run.runId, turnId: next.turnId, generation: next.generation, outcome: { status: 'completed', text: 'Reviewed.' }, actorId: 'orchestrator' }), true);
    assert.ok(store.db.prepare('SELECT acked_at FROM inbox WHERE client_message_id=?').get('client-abcdefgh').acked_at);
  } finally { store.close(); }
});

test('broker deduplicates only the same operation key and fences stale capabilities', async () => {
  const { store, run, turn, broker } = setup();
  try {
    const cap = broker.bindTurn({ runId: run.runId, agentId: turn.agentId, turnId: turn.turnId, generation: turn.generation });
    const input = { body: 'Same intentional peer note.', recipients: ['reviewer'] };
    const call = key => broker.handle(cap.token, 'send', { operationKey: key, input });
    const first = await call('action-one');
    const retry = await call('action-one');
    const distinct = await call('action-two');
    assert.equal(retry.result.messageId, first.result.messageId);
    assert.notEqual(distinct.result.messageId, first.result.messageId);
    assert.equal(store.listEvents(run.runId).filter(e => e.type === 'message.completed' && e.actorId === 'orchestrator').length, 2);
    const conflict = await broker.handle(cap.token, 'send', { operationKey: 'action-one', input: { ...input, body: 'changed under same key' } });
    assert.equal(conflict.error.code, 'intent_conflict');

    const committedAction = store.db.prepare("SELECT status FROM intents WHERE logical_key='mcp:orchestrator:send:action-one'").get();
    assert.equal(committedAction.status, 'committed');
    store.finishTurn({ runId: run.runId, turnId: turn.turnId, generation: turn.generation, outcome: { status: 'outcome_uncertain', error: { code: 'test', message: 'turn uncertain', retryable: false } }, actorId: 'orchestrator' });
    assert.equal(store.db.prepare("SELECT status FROM intents WHERE logical_key='mcp:orchestrator:send:action-one'").get().status, 'committed');
    const stale = await call('action-three');
    assert.equal(stale.error.code, 'capability_expired');
  } finally { store.close(); }
});

test('process recovery marks the turn invocation uncertain but preserves committed MCP effects', async () => {
  const { store, run, turn, broker } = setup();
  try {
    const cap = broker.bindTurn({ runId: run.runId, agentId: turn.agentId, turnId: turn.turnId, generation: turn.generation });
    const sent = await broker.handle(cap.token, 'send', { operationKey: 'durable-action', input: { body: 'Stored once.', recipients: ['reviewer'] } });
    assert.equal(sent.ok, true);
    store.recoverInterrupted();
    assert.equal(store.getIntentByKey(run.runId, `turn:orchestrator:${turn.turnId}`).status, 'outcome_uncertain');
    assert.equal(store.getIntentByKey(run.runId, 'mcp:orchestrator:send:durable-action').status, 'committed');
    assert.equal(store.listEvents(run.runId).filter(e => e.type === 'message.completed' && e.actorId === 'orchestrator').length, 1);
  } finally { store.close(); }
});

test('failed turns block their active task and resume makes it schedulable again', () => {
  const { store, run, turn } = setup();
  try {
    assert.equal(store.finishTurn({ runId: run.runId, turnId: turn.turnId, generation: turn.generation, outcome: { status: 'failed', error: { code: 'runtime_exit', message: 'Exited', retryable: false } }, actorId: 'orchestrator' }), true);
    assert.equal(store.getRun(run.runId).tasks[0].status, 'blocked');
    assert.equal(store.listEvents(run.runId).filter(e => e.type === 'task.status' && e.payload.status === 'blocked').length, 1);
    store.prepareResumeTasks(run.runId);
    assert.equal(store.nextReadyTask(run.runId, 'orchestrator'), run.tasks[0].taskId);
  } finally { store.close(); }
});

test('paused cancellation and restart recovery requeue tasks, while terminal run cancellation stays terminal', () => {
  for (const kind of ['pause','restart','cancel']) {
    const { store, run, turn } = setup();
    try {
      if (kind === 'pause') {
        store.setRunStatus(run.runId, 'paused', 'test pause');
        store.finishTurn({ runId:run.runId,turnId:turn.turnId,generation:turn.generation,outcome:{status:'cancelled'},actorId:'orchestrator' });
        assert.equal(store.getRun(run.runId).status, 'paused');
      } else if (kind === 'restart') {
        store.recoverInterrupted();
      } else {
        store.setRunStatus(run.runId, 'cancelled', 'test cancel');
        store.finishTurn({ runId:run.runId,turnId:turn.turnId,generation:turn.generation,outcome:{status:'cancelled'},actorId:'orchestrator' });
      }
      const expected = kind === 'cancel' ? 'cancelled' : 'blocked';
      assert.equal(store.getRun(run.runId).tasks[0].status, expected);
      if (kind !== 'cancel') {
        store.setRunStatus(run.runId, 'running', 'test resume');
        assert.equal(store.prepareResumeTasks(run.runId), 1);
        assert.equal(store.nextReadyTask(run.runId, 'orchestrator'), run.tasks[0].taskId);
      } else assert.equal(store.prepareResumeTasks(run.runId), 0);
    } finally { store.close(); }
  }
});

test('a human message resumes a stalled run transactionally but does not unpause a paused run', () => {
  const { store, run, turn } = setup();
  try {
    store.setRunStatus(run.runId, 'stalled', 'idle');
    const msg = store.humanMessage(run.runId, { body:'Continue with the pending review.', clientMessageId:'client-resume-1234' });
    assert.equal(store.getRun(run.runId).status, 'running');
    assert.equal(store.getTurn(run.runId, msg.turnId).status, 'queued');
    assert.equal(store.getTurn(run.runId, msg.turnId).context.workspace, run.workspace);
    assert.equal(store.hasPendingInbox(run.runId, 'orchestrator'), true);
    store.setRunStatus(run.runId, 'paused', 'pause');
    assert.throws(() => store.humanMessage(run.runId, { body:'Do not accept this yet.', clientMessageId:'client-paused-1234' }), { message:'run_paused' });
    assert.equal(store.db.prepare('SELECT count(*) n FROM inbox WHERE client_message_id=?').get('client-paused-1234').n, 0);
    store.setRunStatus(run.runId, 'completed', 'terminal');
    assert.throws(() => store.humanMessage(run.runId, { body:'Do not accept after completion.', clientMessageId:'client-completed-1234' }), { message:'run_not_runnable' });
    assert.equal(store.db.prepare('SELECT count(*) n FROM inbox WHERE client_message_id=?').get('client-completed-1234').n, 0);
  } finally { store.close(); }
});

test('resuming a stalled run requeues an unaccepted review to the distinct reviewer', async () => {
  const { store,run,turn,broker }=setup();
  try {
    const taskId=run.tasks[0].taskId,cap=broker.bindTurn({runId:run.runId,agentId:'orchestrator',turnId:turn.turnId,generation:turn.generation});
    const submitted=await broker.handle(cap.token,'task_decision',{operationKey:'resume-submit',input:{taskId,decision:'submit',result:'Ready for review.'}});
    assert.equal(submitted.ok,true);
    store.finishTurn({runId:run.runId,turnId:turn.turnId,generation:turn.generation,outcome:{status:'completed',text:'Submitted.'},actorId:'orchestrator'});
    const reviewerTurn=store.startTurn({runId:run.runId,agentId:'reviewer',prompt:'Inspect the submission.',context:{workspace:run.workspace}});
    assert.ok(reviewerTurn.inboxIds.length);
    store.finishTurn({runId:run.runId,turnId:reviewerTurn.turnId,generation:reviewerTurn.generation,outcome:{status:'completed',text:'Review still pending.'},actorId:'reviewer'});
    assert.equal(store.hasPendingInbox(run.runId,'reviewer'),false);
    store.setRunStatus(run.runId,'stalled','review unresolved');
    const human=store.humanMessage(run.runId,{body:'Please continue the pending review.',clientMessageId:'client-review-resume-001'});
    assert.equal(store.getTurn(run.runId,human.turnId).context.workspace,run.workspace);
    const handoff=store.listEvents(run.runId).findLast(e=>e.type==='task.status'&&e.taskId===taskId&&e.payload.status==='review');
    assert.equal(handoff.actorId,'supervisor');assert.equal(handoff.causation,human.event.id);assert.equal(handoff.payload.submittedBy,'orchestrator');
    assert.equal(store.hasPendingInbox(run.runId,'reviewer'),true);
    const pending=store.db.prepare("SELECT sender_id,body FROM inbox WHERE run_id=? AND recipient_id='reviewer' AND acked_at IS NULL AND sender_id='supervisor'").get(run.runId);
    assert.match(pending.body,/Retomada após mensagem humana/);
    assert.equal(store.listEvents(run.runId).filter(e=>e.type==='message.completed'&&e.messageId?.startsWith('dispatch_')).length,0);
  } finally { store.close(); }
});

test('proposed tasks remain pending until an assignee turn starts with a complete task.started envelope', async () => {
  const { store, run, turn, broker } = setup();
  try {
    const third = store.addSpecialist({ runId: run.runId, actorId: 'orchestrator', name: 'Reviewer two', profile: 'testing', runtime: 'claude-code' });
    const cap = broker.bindTurn({ runId: run.runId, agentId: turn.agentId, turnId: turn.turnId, generation: turn.generation });
    const response = await broker.handle(cap.token, 'propose_task', { operationKey: 'proposal-1', input: { title: 'Inspect parser', objective: 'Review parsing behavior.', criterionIds: ['root-goal'] } });
    assert.equal(response.ok, true);
    const { taskId, assigneeId } = response.result;
    assert.equal(store.getRun(run.runId).tasks.find(t => t.taskId === taskId).status, 'pending');
    const proposalEvent=store.listEvents(run.runId).find(e => e.type === 'task.status' && e.taskId === taskId);
    assert.deepEqual(proposalEvent.payload,{taskId,status:'pending'});
    assert.equal(store.listEvents(run.runId).some(e => e.type === 'task.started' && e.taskId === taskId), false);
    store.finishTurn({ runId: run.runId, turnId: turn.turnId, generation: turn.generation, outcome: { status: 'completed', text: 'Delegated.' }, actorId: 'orchestrator' });
    const next = store.startTurn({ runId: run.runId, agentId: assigneeId, taskId, prompt: 'Inspect.', context: { workspace: process.cwd() } });
    assert.equal(next.queued, false);
    const started = store.listEvents(run.runId).find(e => e.type === 'task.started' && e.taskId === taskId);
    assert.equal(started.payload.status, 'running');
    assert.equal(started.payload.title, 'Inspect parser');
    assert.equal(started.payload.reviewerId, third.agentId);
  } finally { store.close(); }
});

test('new runs assign orchestrator and reviewer to both ready providers with single-provider fallback', async () => {
  const { store, run, broker } = setup();
  try {
    const adapters = new Map([
      ['claude-code', { capabilities: async () => ({ available:true, auth:'ready', mode:'restricted-read-only' }) }],
      ['codex-cli', { capabilities: async () => ({ available:true, auth:'ready', mode:'codex-read-only' }) }]
    ]);
    const core = new Core({ store, broker, adapters });
    const selected = await core.chooseRunRuntimes();
    assert.ok(selected.runtime);
    assert.ok(selected.reviewerRuntime);
    assert.notEqual(selected.runtime, selected.reviewerRuntime);
    const mixed = store.createRun({ prompt:'Mixed council test.', workspace:process.cwd(), runtime:selected.runtime, reviewerRuntime:selected.reviewerRuntime });
    assert.equal(mixed.agents.find(a => a.agentId === 'orchestrator').runtime, selected.runtime);
    assert.equal(mixed.agents.find(a => a.agentId === 'reviewer').runtime, selected.reviewerRuntime);
    const single = new Core({ store, broker, adapters:new Map([['claude-code',adapters.get('claude-code')]]) });
    const fallback = await single.chooseRunRuntimes();
    assert.equal(fallback.runtime, 'claude-code');
    assert.equal(fallback.reviewerRuntime, fallback.runtime);
  } finally { store.close(); }
});

test('a completed task stays available for explicit submit and distinct reviewer acceptance', async () => {
  const { store, run, turn, broker } = setup();
  try {
    const taskId = run.tasks[0].taskId, evidenceId = 'proof-source-1', now = new Date().toISOString();
    store.db.prepare("INSERT INTO evidence(run_id,id,kind,label,uri,claims,sha256,provenance,verified_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(run.runId,evidenceId,'file','Reviewed source','fixture.ts','[]','a'.repeat(64),'supervisor_verified',now,now);
    const orchCap = broker.bindTurn({ runId:run.runId,agentId:'orchestrator',turnId:turn.turnId,generation:turn.generation });
    const submit = await broker.handle(orchCap.token,'task_decision',{operationKey:'submit-root',input:{taskId,decision:'submit',result:'Source reviewed with a verified file reference.',evidenceIds:[evidenceId]}});
    assert.equal(submit.ok,true);
    assert.equal(store.getRun(run.runId).tasks[0].status,'review');
    const submissionEvent=store.listEvents(run.runId).find(e=>e.type==='task.status'&&e.taskId===taskId&&e.payload.status==='review');
    assert.equal(submissionEvent.actorId,'supervisor');
    assert.ok(submissionEvent.causation);
    assert.equal(submissionEvent.payload.submittedBy,'orchestrator');
    assert.deepEqual(submissionEvent.recipients,['reviewer']);
    assert.equal(store.listEvents(run.runId).some(e=>e.type==='message.completed'&&e.messageId?.startsWith('msg_review_')),false);
    assert.equal(store.db.prepare('SELECT sender_id FROM inbox WHERE run_id=? AND recipient_id=? AND operation_intent_id=?').get(run.runId,'reviewer',submissionEvent.causation).sender_id,'supervisor');
    assert.equal(store.finishTurn({runId:run.runId,turnId:turn.turnId,generation:turn.generation,outcome:{status:'completed',text:'Review submitted.'},actorId:'orchestrator'}),true);
    assert.equal(store.getRun(run.runId).tasks[0].status,'review');
    const finalMessage=store.listEvents(run.runId).find(e=>e.type==='message.completed'&&e.actorId==='orchestrator'&&e.messageId===turn.turnId);
    assert.equal(finalMessage.messageId,turn.turnId);
    store.emit(run.runId,'report.updated','supervisor',{revision:1,format:'markdown',summary:'A aceitação ainda não aconteceu.'});
    const background=store.addSpecialist({runId:run.runId,actorId:'orchestrator',name:'Parallel analyst',profile:'testing',runtime:'claude-code'});
    const backgroundTurn=store.startTurn({runId:run.runId,agentId:background.agentId,prompt:'Finish the parallel check.',context:{workspace:run.workspace}});
    const reviewerTurn=store.startTurn({runId:run.runId,agentId:'reviewer',prompt:'Verify the submission.',context:{workspace:run.workspace}});
    const reviewerCap=broker.bindTurn({runId:run.runId,agentId:'reviewer',turnId:reviewerTurn.turnId,generation:reviewerTurn.generation});
    const accepted=await broker.handle(reviewerCap.token,'task_decision',{operationKey:'accept-root',input:{taskId,decision:'accept',result:'Accepted against the verified source.',evidenceIds:[evidenceId]}});
    assert.equal(accepted.result.status,'completed');
    assert.equal(store.getRun(run.runId).status,'running');
    assert.equal(store.listEvents(run.runId).some(e=>e.type==='run.status'&&e.payload.status==='completed'),false);
    store.finishTurn({runId:run.runId,turnId:reviewerTurn.turnId,generation:reviewerTurn.generation,outcome:{status:'completed',text:'Reviewer accepted.'},actorId:'reviewer'});
    assert.equal(store.completeRunIfReady(run.runId),false,'an independent turn is still closing');
    store.finishTurn({runId:run.runId,turnId:backgroundTurn.turnId,generation:backgroundTurn.generation,outcome:{status:'completed',text:'Parallel check finished.'},actorId:background.agentId});
    assert.equal(store.completeRunIfReady(run.runId),true);
    assert.equal(store.getRun(run.runId).status,'completed');
    const events=store.listEvents(run.runId),terminal=events.findLast(e=>e.type==='run.status'&&e.payload.status==='completed');
    assert.ok(terminal);
    assert.equal(events.at(-1).id,terminal.id,'terminal event closes the stream only after the final turn and report');
    const reports=events.filter(e=>e.type==='report.updated');
    assert.equal(reports[0].payload.summary,'A aceitação ainda não aconteceu.','historical report event remains unchanged');
    assert.equal(reports.at(-1).payload.summary,'Objetivo raiz e critérios aceitos pelo revisor com evidências verificadas.');
    const projection=new Core({store,broker,adapters:new Map()}).report(run.runId);
    assert.match(projection.markdown,/Status: \*\*completed\*\*/);
    assert.doesNotMatch(projection.markdown,/A aceitação ainda não aconteceu/i);
  } finally { store.close(); }
});

test('artifact evidence copies only workspace bytes, records the supervisor hash and replays idempotently', async () => {
  const { store, run, turn, broker } = setup();
  try {
    const cap=broker.bindTurn({runId:run.runId,agentId:turn.agentId,turnId:turn.turnId,generation:turn.generation});
    const input={kind:'artifact',label:'Backend package snapshot',uri:'package.json',relatedTaskId:run.tasks[0].taskId};
    const first=await broker.handle(cap.token,'evidence',{operationKey:'publish-package',input});
    assert.equal(first.ok,true);
    const retry=await broker.handle(cap.token,'evidence',{operationKey:'publish-package',input});
    assert.equal(retry.result.artifactId,first.result.artifactId);
    const artifact=store.getArtifact(run.runId,first.result.artifactId);
    assert.equal(artifact.size,readFileSync(artifact.contentPath).length);
    assert.equal(artifact.sha256,first.result.sha256);
    assert.equal(first.result.evidence.provenance,'supervisor_verified');
    assert.equal(first.result.evidence.sha256,artifact.sha256);
    assert.equal(store.listEvents(run.runId).filter(e=>e.type==='artifact.published').length,1);
    assert.equal(store.listEvents(run.runId).filter(e=>e.type==='evidence.published'&&e.payload.kind==='artifact').length,1);
    const escape=await broker.handle(cap.token,'evidence',{operationKey:'escape-artifact',input:{...input,uri:'../README.md'}});
    assert.equal(escape.error.code,'invalid_scope');
  } finally { store.close(); }
});

test('published artifacts and their verified bytes remain available after Store restart', () => {
  const dir=mkdtempSync(join(tmpdir(),'shao-artifact-restart-')),dbPath=join(dir,'state.sqlite'),bytes=Buffer.from('fixture artifact survives restart');
  let store;
  try {
    store=new Store(dbPath);const run=store.createRun({prompt:'Persist one artifact.',workspace:process.cwd(),runtime:'claude-code'});const turn=store.startTurn({runId:run.runId,agentId:'orchestrator',prompt:'publish',context:{workspace:process.cwd()}});
    const intent=store.getOrCreateIntent({runId:run.runId,turnId:turn.turnId,logicalKey:'artifact-restart',request:{kind:'artifact',label:'restart fixture'}});
    const published=store.publishArtifact({runId:run.runId,intentId:intent.id,turnId:turn.turnId,generation:turn.generation,actorId:'orchestrator',name:'fixture.txt',mime:'text/plain; charset=utf-8',bytes,label:'Restart fixture'});
    store.close();store=new Store(dbPath);const artifact=store.getArtifact(run.runId,published.artifactId);
    assert.ok(artifact);assert.equal(readFileSync(artifact.contentPath,'utf8'),bytes.toString('utf8'));assert.equal(artifact.sha256,published.sha256);
    assert.equal(store.listEvents(run.runId).filter(e=>e.type==='artifact.published').length,1);
  } finally { store?.close();rmSync(dir,{recursive:true,force:true}); }
});

test('Core persists the bounded redacted adapter diagnostic as an error event and stalled reason', async () => {
  const { store, run, turn, broker } = setup();
  try {
    const core = new Core({ store, broker, adapters:new Map() });
    const outcome = { error:{ code:'runtime_exit_1', message:'CLI exited. (exit=1 signal=none; stderr=Unknown flag.)', retryable:false } };
    await core.runtimeFailure(turn, outcome);
    const event = store.listEvents(run.runId).find(e => e.type === 'error');
    assert.equal(event.payload.code, 'runtime_exit_1');
    assert.match(event.payload.message, /stderr=Unknown flag/);
    assert.equal(store.getRun(run.runId).status, 'stalled');
    assert.equal(store.listEvents(run.runId).at(-1).payload.reason, event.payload.message);
  } finally { store.close(); }
});

test('Core preserves a nested Codex MCP error code while redacting its first-line detail', () => {
  const { store,run,broker }=setup();
  try {
    const core=new Core({store,broker,adapters:new Map()});
    assert.equal(core.safeToolError({type:'function_call_output',output:{content:[{type:'text',text:'invalid_scope (retryable=false): denied for user@example.invalid at D:\\Users\\Thiago\\case.ts; token=abcdefghijklmnopqrstuvwx1234567890'}]}}),'invalid_scope: denied for [REDACTED_EMAIL] at [REDACTED_PATH] token=[REDACTED_SECRET]');
    assert.equal(core.safeToolError({content:[{type:'text',text:'No detailed code in provider error.'}]}),'No detailed code in provider error.');
  } finally { store.close(); }
});
