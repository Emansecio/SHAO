import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { once } from 'node:events';
import { Store } from '../store.js';
import { TurnBroker } from '../broker.js';

const shim = fileURLToPath(new URL('./stdio.ts', import.meta.url));

test('stdio MCP bridge authenticates to loopback broker and preserves action identity by JSON-RPC id', async () => {
  const received = []; const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { messageId: 'msg_fixture', status: 'sent' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  const child = spawn(process.execPath, ['--experimental-strip-types', shim], { env: { ...process.env, SHAO_MCP_ENDPOINT: `http://127.0.0.1:${address.port}/internal/mcp/v1`, SHAO_MCP_CAPABILITY: 'cap-fixture' }, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => output += chunk);
  child.stdin.write(`${JSON.stringify({ jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'} })}\n`);
  const call = id => `${JSON.stringify({ jsonrpc:'2.0',id,method:'tools/call',params:{name:'send',arguments:{input:{recipients:['peer-a'],body:'hello',actorId:'spoofed',agentId:'spoofed',turnId:'spoofed'}}} })}\n`;
  child.stdin.write(call(2)); child.stdin.write(call(2)); child.stdin.write(call(3));
  const deadline = Date.now()+5000; while ((received.length < 3 || (output.match(/"status":"sent"/g) ?? []).length < 3) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
  child.kill(); server.close();
  assert.equal(received[0].path, '/internal/mcp/v1/send'); assert.equal(received[0].auth, 'Bearer cap-fixture');
  assert.equal(received[0].body.tool, 'send');
  assert.equal(received[0].body.operationKey, received[1].body.operationKey);
  assert.notEqual(received[0].body.operationKey, received[2].body.operationKey);
  assert.equal(received[0].body.input.actorId, 'spoofed'); // opaque input reaches broker, which must ignore identity claims.
  assert.match(output, /"status":"sent"/);
});

test('stdio bridge rejects non-loopback capability endpoints before network use', async () => {
  const child = spawn(process.execPath, ['--experimental-strip-types', shim], { env: { ...process.env, SHAO_MCP_ENDPOINT: 'https://example.invalid/internal/mcp/v1', SHAO_MCP_CAPABILITY: 'cap-fixture' }, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => output += chunk);
  child.stdin.write(`${JSON.stringify({ jsonrpc:'2.0',id:1,method:'initialize',params:{} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'send',arguments:{input:{body:'hello',recipients:['peer']}}} })}\n`);
  const deadline = Date.now()+1500; while (!output.includes('loopback HTTP') && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
  child.kill(); assert.match(output, /loopback HTTP/);
});

test('stdio bridge keeps broker failure code and bounded redacted message in MCP error result', async () => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    res.writeHead(400, { 'content-type':'application/json' });
    res.end(JSON.stringify({ ok:false, error:{ code:'invalid_scope', message:'Denied for user@example.invalid, token=abcdefghijklmnopqrstuvwx1234567890', retryable:false } }));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address();
  const child=spawn(process.execPath,['--experimental-strip-types',shim],{env:{...process.env,SHAO_MCP_ENDPOINT:`http://127.0.0.1:${address.port}/internal/mcp/v1`,SHAO_MCP_CAPABILITY:'cap-fixture'},stdio:['pipe','pipe','pipe'],windowsHide:true});
  let output=''; child.stdout.setEncoding('utf8'); child.stdout.on('data',chunk=>output+=chunk);
  child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})}\n`);
  child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'evidence',arguments:{input:{kind:'file',label:'fixture',uri:'outside.txt'}}}})}\n`);
  const deadline=Date.now()+3000; while(!output.includes('invalid_scope')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  child.kill(); await new Promise(resolve=>server.close(resolve));
  assert.match(output,/invalid_scope \(retryable=false\): .+REDACTED_EMAIL/); assert.match(output,/REDACTED_SECRET/);
  assert.doesNotMatch(output,/user@example|abcdefghijklmnopqrstuvwx1234567890/);
});

test('real Store and TurnBroker complete context, peer send, specialist and evidence through stdio HTTP bridge', async () => {
  const store = new Store(':memory:');
  const run = store.createRun({ prompt: 'Local synthetic fixture review', workspace: process.cwd(), runtime: 'claude-code' });
  const turn = store.startTurn({ runId: run.runId, agentId: 'orchestrator', taskId: run.tasks[0].taskId, prompt: 'Fixture turn', context: { workspace: process.cwd() } });
  const broker = new TurnBroker({ store, workspaceForRun: () => process.cwd(), runtimeForParent: () => 'claude-code' });
  const cap = broker.bindTurn({ runId: turn.runId, agentId: turn.agentId, turnId: turn.turnId, generation: turn.generation });
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    const result = await broker.handle(req.headers.authorization?.slice('Bearer '.length), decodeURIComponent(req.url.split('/').at(-1)), request);
    res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  const child = spawn(process.execPath, ['--experimental-strip-types', shim], { env: { ...process.env, SHAO_MCP_ENDPOINT: `http://127.0.0.1:${address.port}/internal/mcp/v1`, SHAO_MCP_CAPABILITY: cap.token }, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  const pending = new Map(); let buffered = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    buffered += chunk; const lines = buffered.split(/\r?\n/); buffered = lines.pop() ?? '';
    for (const line of lines) { try { const message = JSON.parse(line); const resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message); } } catch {} }
  });
  const rpc = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request ${id} timed out`)); }, 3000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc:'2.0',id,method,params })}\n`);
  });
  try {
    assert.equal((await rpc(1, 'initialize', { protocolVersion:'2024-11-05' })).result.serverInfo.name, 'shao-team-bridge');
    assert.equal((await rpc(2, 'tools/list')).result.tools.length, 7);
    const listedTools = (await rpc(2, 'tools/list')).result.tools;
    assert.equal(listedTools.length, 7);
    assert.ok(listedTools.some(tool => tool.name === 'task_decision'));
    const evidenceSchema = listedTools.find(tool => tool.name === 'evidence').inputSchema;
    assert.ok(evidenceSchema.properties.input.properties.kind.enum.includes('artifact'));
    assert.deepEqual(listedTools.find(tool => tool.name === 'get_context').annotations, {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
    assert.equal(listedTools.find(tool => tool.name === 'send').annotations.readOnlyHint, false);
    assert.equal(listedTools.find(tool => tool.name === 'task_decision').annotations.readOnlyHint, false);
    const call = async (id, name, input = {}) => {
      const response = await rpc(id, 'tools/call', { name, arguments: name === 'get_context' ? {} : { input } });
      assert.equal(response.result.isError, false, JSON.stringify(response));
      return response.result.structuredContent;
    };
    assert.equal((await call(3, 'get_context')).snapshot.prompt, 'Fixture turn');
    const sendInput = { recipients:['reviewer'], body:'Fixture review ready', contextRefs:['evi-fixture'] };
    const sent = await call(4, 'send', sendInput);
    const replayed = await call(4, 'send', sendInput);
    const distinct = await call(7, 'send', sendInput);
    assert.equal(sent.status, 'sent'); assert.equal(replayed.messageId, sent.messageId); assert.notEqual(distinct.messageId, sent.messageId);
    const conflict = await rpc(4, 'tools/call', { name:'send', arguments:{input:{recipients:['reviewer'],body:'different payload'}} });
    assert.equal(conflict.result.isError, true); assert.match(conflict.result.content[0].text, /reused with different input/i);
    const specialist = await call(5, 'request_specialist', { name:'Fixture Reviewer', profile:'code-review', scope:'Review synthetic fixture only', budget:1 });
    assert.equal(specialist.agent.dynamic, true);
    const evidence = await call(6, 'evidence', { kind:'note', label:'Local fixture evidence', excerpt:'Synthetic local evidence only.', claims:['fixture exists'] });
    assert.equal(evidence.provenance, 'model_asserted');
    const artifact = await call(9, 'evidence', { kind:'artifact', label:'Synthetic local artifact', uri:relative(process.cwd(), fileURLToPath(import.meta.url)), claims:['local fixture file'] });
    assert.equal(artifact.evidence.kind, 'artifact');
    assert.equal(artifact.evidence.provenance, 'supervisor_verified');
    const events = store.listEvents(run.runId);
    assert.equal(events.filter(event => event.type === 'message.completed' && event.payload.body === 'Fixture review ready').length, 2);
    assert.ok(events.some(event => event.type === 'agent.spawned' && event.payload.displayName === 'Fixture Reviewer'));
    assert.ok(events.some(event => event.type === 'evidence.published' && event.payload.id === evidence.id));
    assert.ok(events.some(event => event.type === 'artifact.published' && event.payload.artifactId === artifact.artifactId));

    const rootTaskId = run.tasks[0].taskId;
    const submitted = await call(8, 'task_decision', { taskId:rootTaskId, decision:'submit', result:'Synthetic fixture result', evidenceIds:[] });
    assert.equal(submitted.status, 'review');
    const reviewerTurn = store.startTurn({ runId:run.runId, agentId:'reviewer', taskId:rootTaskId, prompt:'Review fixture result', context:{workspace:process.cwd()} });
    const reviewerCap = broker.bindTurn({ runId:reviewerTurn.runId, agentId:reviewerTurn.agentId, turnId:reviewerTurn.turnId, generation:reviewerTurn.generation });
    const reviewerChild = spawn(process.execPath, ['--experimental-strip-types', shim], { env:{...process.env,SHAO_MCP_ENDPOINT:`http://127.0.0.1:${address.port}/internal/mcp/v1`,SHAO_MCP_CAPABILITY:reviewerCap.token}, stdio:['pipe','pipe','pipe'], windowsHide:true });
    const reviewerPending = new Map(); let reviewerBuffered = '';
    reviewerChild.stdout.setEncoding('utf8'); reviewerChild.stdout.on('data', chunk => {
      reviewerBuffered += chunk; const lines = reviewerBuffered.split(/\r?\n/); reviewerBuffered = lines.pop() ?? '';
      for (const line of lines) { try { const message = JSON.parse(line); const resolve = reviewerPending.get(message.id); if (resolve) { reviewerPending.delete(message.id); resolve(message); } } catch {} }
    });
    const reviewerRpc = (id, method, params = {}) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reviewerPending.delete(id); reject(new Error(`Reviewer MCP request ${id} timed out`)); }, 3000);
      reviewerPending.set(id, message => { clearTimeout(timer); resolve(message); });
      reviewerChild.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`);
    });
    try {
      await reviewerRpc(1, 'initialize', {protocolVersion:'2024-11-05'});
      const reviewerSendInput = {recipients:['orchestrator'],body:'Distinct intent from reviewer turn'};
      const reviewerSend = await reviewerRpc(4, 'tools/call', {name:'send',arguments:{input:reviewerSendInput}});
      const reviewerSendReplay = await reviewerRpc(4, 'tools/call', {name:'send',arguments:{input:reviewerSendInput}});
      assert.equal(reviewerSend.result.isError, false, JSON.stringify(reviewerSend));
      assert.equal(reviewerSendReplay.result.isError, false, JSON.stringify(reviewerSendReplay));
      assert.notEqual(reviewerSend.result.structuredContent.messageId, sent.messageId);
      assert.equal(reviewerSendReplay.result.structuredContent.messageId, reviewerSend.result.structuredContent.messageId);
      const verified = await reviewerRpc(2, 'tools/call', {name:'evidence',arguments:{input:{kind:'file',label:'Own test fixture',uri:relative(process.cwd(), fileURLToPath(import.meta.url)),relatedTaskId:rootTaskId}}});
      assert.equal(verified.result.isError, false, JSON.stringify(verified));
      const accepted = await reviewerRpc(3, 'tools/call', {name:'task_decision',arguments:{input:{taskId:rootTaskId,decision:'accept',result:'Accepted synthetic fixture result',evidenceIds:[verified.result.structuredContent.id]}}});
      assert.equal(accepted.result.isError, false, JSON.stringify(accepted));
      assert.equal(accepted.result.structuredContent.status, 'completed');
      assert.ok(store.listEvents(run.runId).some(event => event.type === 'task.completed' && event.payload.taskId === rootTaskId));
    } finally {
      reviewerChild.kill(); broker.revokeTurn(reviewerTurn.turnId, reviewerTurn.generation);
    }
  } finally {
    child.kill(); await new Promise(resolve => server.close(resolve)); broker.revokeTurn(turn.turnId, turn.generation); store.close();
  }
});
