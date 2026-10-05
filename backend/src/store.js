import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const iso = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;
const json = (value) => JSON.stringify(value);
const parse = (value, fallback = []) => value == null ? fallback : JSON.parse(value);

export class Store {
  db;
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
    this.temporaryArtifacts=filename===':memory:';
    this.artifactsDir=this.temporaryArtifacts?mkdtempSync(join(tmpdir(),'shao-artifacts-')):join(dirname(resolve(filename)),'artifacts');
    mkdirSync(this.artifactsDir,{recursive:true});
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, title TEXT NOT NULL, workspace TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0,
        root_criterion_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, id TEXT NOT NULL, display_name TEXT NOT NULL,
        role TEXT NOT NULL, runtime TEXT NOT NULL, parent_id TEXT, profile TEXT, dynamic INTEGER NOT NULL,
        status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, scope TEXT NOT NULL DEFAULT '', budget INTEGER, operation_intent_id TEXT UNIQUE,
        PRIMARY KEY(run_id,id)
      );
      CREATE TABLE IF NOT EXISTS criteria (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, id TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', evidence_ids TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(run_id,id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, id TEXT NOT NULL, title TEXT NOT NULL,
        objective TEXT NOT NULL, criterion_ids TEXT NOT NULL, assignee_id TEXT, reviewer_id TEXT, parent_task_id TEXT,
        context_refs TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, result TEXT, author_id TEXT NOT NULL,
        created_at TEXT NOT NULL, operation_intent_id TEXT UNIQUE, PRIMARY KEY(run_id,id)
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL, ts TEXT NOT NULL, actor_id TEXT NOT NULL, turn_id TEXT, message_id TEXT,
        recipients TEXT NOT NULL, task_id TEXT, causation TEXT, payload TEXT NOT NULL, PRIMARY KEY(run_id,seq)
      );
      CREATE TABLE IF NOT EXISTS turns (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, id TEXT NOT NULL, agent_id TEXT NOT NULL,
        task_id TEXT, generation INTEGER NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL,
        operation_intent_id TEXT NOT NULL, included_inbox_ids TEXT NOT NULL, context_snapshot TEXT NOT NULL,
        resume_session_id TEXT, session_id TEXT, output TEXT, error TEXT, created_at TEXT NOT NULL,
        committed_at TEXT, PRIMARY KEY(run_id,id), UNIQUE(run_id,agent_id,generation)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_turn_per_agent ON turns(run_id,agent_id) WHERE status IN ('running','cancelling');
      CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, turn_id TEXT NOT NULL,
        logical_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id,logical_key)
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL, sender_id TEXT NOT NULL, message_id TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', included_turn_id TEXT, created_at TEXT NOT NULL, acked_at TEXT, operation_intent_id TEXT UNIQUE, client_message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(run_id,recipient_id,status,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS inbox_client_message ON inbox(run_id,client_message_id) WHERE client_message_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS evidence (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, id TEXT NOT NULL, kind TEXT NOT NULL,
        label TEXT NOT NULL, uri TEXT, excerpt TEXT, related_task_id TEXT, claims TEXT NOT NULL,
        sha256 TEXT, provenance TEXT NOT NULL, verified_at TEXT, created_at TEXT NOT NULL, operation_intent_id TEXT UNIQUE, PRIMARY KEY(run_id,id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, content_path TEXT NOT NULL, sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(run_id,id)
      );
    `);
  }
  close() { this.db.close();if(this.temporaryArtifacts)rmSync(this.artifactsDir,{recursive:true,force:true}); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  emit(runId, type, actorId, payload, options = {}) {
    const run = this.db.prepare('SELECT last_seq FROM runs WHERE id=?').get(runId);
    if (!run) throw new Error('run_not_found');
    const seq = run.last_seq + 1, eventId = id('evt'), ts = iso();
    const event = { id: eventId, seq, runId, type, ts, actorId, turnId: options.turnId ?? null,
      messageId: options.messageId ?? null, recipients: options.recipients ?? [], taskId: options.taskId ?? null,
      causation: options.causation ?? null, payload };
    this.db.prepare('INSERT INTO events(run_id,seq,id,type,ts,actor_id,turn_id,message_id,recipients,task_id,causation,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(runId, seq, eventId, type, ts, actorId, event.turnId, event.messageId, json(event.recipients), event.taskId, event.causation, json(payload));
    this.db.prepare('UPDATE runs SET last_seq=?,updated_at=? WHERE id=?').run(seq, ts, runId);
    return event;
  }
  createRun({ prompt, workspace, criteria = [], runtime = null, reviewerRuntime = runtime }) {
    const runId = id('run'), now = iso(), rootId = 'root-goal', rootTaskId = id('task');
    const initialStatus = runtime ? 'running' : 'paused_auth';
    return this.tx(() => {
      this.db.prepare('INSERT INTO runs(id,prompt,title,workspace,status,created_at,updated_at,root_criterion_id) VALUES(?,?,?,?,?,?,?,?)')
        .run(runId, prompt, prompt.trim().split(/\s+/).slice(0,8).join(' ').slice(0,80), workspace, initialStatus, now, now, rootId);
      this.db.prepare('INSERT INTO criteria(run_id,id,description,status) VALUES(?,?,? ,?)').run(runId, rootId, prompt, 'pending');
      const seen = new Set([rootId]);
      for (const item of criteria) {
        if (!item || typeof item.id !== 'string' || !item.id || typeof item.description !== 'string' || !item.description.trim() || seen.has(item.id)) throw new Error('invalid_criteria');
        seen.add(item.id);
        this.db.prepare('INSERT INTO criteria(run_id,id,description,status) VALUES(?,?,?,?)').run(runId, item.id, item.description.trim(), 'pending');
      }
      this.db.prepare(`INSERT INTO tasks(run_id,id,title,objective,criterion_ids,assignee_id,reviewer_id,status,author_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(runId, rootTaskId, 'Objetivo raiz', prompt, json([rootId, ...criteria.map(x => x.id)]), runtime?'orchestrator':null, runtime?'reviewer':null, runtime?'running':'pending', 'user', now);
      if (runtime) {
        this.db.prepare(`INSERT INTO agents(run_id,id,display_name,role,runtime,parent_id,profile,dynamic,status)
          VALUES(?, 'orchestrator','Orquestrador','Facilitação e análise',?,NULL,NULL,0,'idle')`).run(runId, runtime);
        this.emit(runId, 'agent.spawned', 'supervisor', { agentId: 'orchestrator', displayName: 'Orquestrador', role: 'Facilitação e análise', runtime, parentId: null, profile: null, dynamic: false });
        this.db.prepare("INSERT INTO agents(run_id,id,display_name,role,runtime,parent_id,profile,dynamic,status) VALUES(?,'reviewer','Revisor independente','Revisão por critérios',?,NULL,NULL,0,'idle')").run(runId,reviewerRuntime??runtime);
        this.emit(runId, 'agent.spawned', 'supervisor', { agentId: 'reviewer', displayName: 'Revisor independente', role: 'Revisão por critérios', runtime:reviewerRuntime??runtime, parentId: null, profile: null, dynamic: false });
        this.emit(runId, 'task.started', 'supervisor', { taskId: rootTaskId, title: 'Objetivo raiz', objective: prompt, criterionIds: [rootId, ...criteria.map(x=>x.id)], assigneeId:'orchestrator', reviewerId:'reviewer', status:'running' }, {taskId:rootTaskId, recipients:['orchestrator']});
      }
      this.emit(runId, 'run.status', 'supervisor', { status: initialStatus, ...(runtime ? {} : { reason: 'Nenhum runtime autenticado disponível no preflight.' }) });
      for (const row of this.db.prepare('SELECT id,description,status,evidence_ids FROM criteria WHERE run_id=?').all(runId))
        this.emit(runId, 'criterion.status', 'supervisor', { criterionId: row.id, description: row.description, status: row.status, evidenceIds: parse(row.evidence_ids) });
      return this.getRun(runId);
    });
  }
  getAgent(runId,agentId) { const a=this.db.prepare('SELECT * FROM agents WHERE run_id=? AND id=?').get(runId,agentId);return a?{agentId:a.id,displayName:a.display_name,role:a.role,runtime:a.runtime,parentId:a.parent_id,profile:a.profile,dynamic:!!a.dynamic,status:a.status,generation:a.generation,scope:a.scope,budget:a.budget}:null; }
  recordTurnEvent(runId,turnId,generation,type,actorId,payload,options={}) { return this.tx(()=>{if(!this.isTurnActive(runId,turnId,generation))return null;return this.emit(runId,type,actorId,payload,{...options,turnId});}); }
  isTurnActive(runId,turnId,generation) { return !!this.db.prepare(`SELECT 1 FROM turns t JOIN agents a ON a.run_id=t.run_id AND a.id=t.agent_id WHERE t.run_id=? AND t.id=? AND t.generation=? AND t.status='running' AND a.generation=?`).get(runId,turnId,generation,generation); }
  observeCliSession({runId,turnId,generation,provider,sessionId}) { return this.tx(()=>{if(typeof sessionId!=='string'||!sessionId.trim()||!this.isTurnActive(runId,turnId,generation))return false;const turn=this.db.prepare('SELECT agent_id FROM turns WHERE run_id=? AND id=?').get(runId,turnId);if(!turn)return false;this.db.prepare("UPDATE turns SET session_id=? WHERE run_id=? AND id=? AND generation=? AND status='running'").run(sessionId,runId,turnId,generation);return true;}); }
  getTurn(runId,turnId) { const t=this.db.prepare('SELECT * FROM turns WHERE run_id=? AND id=?').get(runId,turnId);if(!t)return null;return{runId,turnId:t.id,agentId:t.agent_id,taskId:t.task_id,generation:t.generation,status:t.status,operationIntentId:t.operation_intent_id,inboxIds:parse(t.included_inbox_ids),context:parse(t.context_snapshot),resumeSessionId:t.resume_session_id,sessionId:t.session_id}; }
  nextReadyTask(runId,agentId) { return this.db.prepare("SELECT id FROM tasks WHERE run_id=? AND assignee_id=? AND status IN ('pending','ready') ORDER BY created_at LIMIT 1").get(runId,agentId)?.id??null; }
  hasPendingInbox(runId,agentId) { return !!this.db.prepare("SELECT 1 FROM inbox WHERE run_id=? AND recipient_id IN (?, '*') AND acked_at IS NULL").get(runId,agentId); }
  activeTurnCount(runId) { return this.db.prepare("SELECT count(*) AS n FROM turns WHERE run_id=? AND status IN ('running','cancelling')").get(runId).n; }
  ensureRuntimeAgents(runId,runtime,reviewerRuntime=runtime) { return this.tx(()=>{const run=this.db.prepare('SELECT status FROM runs WHERE id=?').get(runId);if(!run)throw new Error('run_not_found');if(!this.db.prepare('SELECT 1 FROM agents WHERE run_id=? AND id=?').get(runId,'orchestrator')){this.db.prepare("INSERT INTO agents(run_id,id,display_name,role,runtime,parent_id,profile,dynamic,status) VALUES(?,'orchestrator','Orquestrador','Facilitação e análise',?,NULL,NULL,0,'idle')").run(runId,runtime);this.emit(runId,'agent.spawned','supervisor',{agentId:'orchestrator',displayName:'Orquestrador',role:'Facilitação e análise',runtime,parentId:null,profile:null,dynamic:false});}if(!this.db.prepare('SELECT 1 FROM agents WHERE run_id=? AND id=?').get(runId,'reviewer')){this.db.prepare("INSERT INTO agents(run_id,id,display_name,role,runtime,parent_id,profile,dynamic,status) VALUES(?,'reviewer','Revisor independente','Revisão por critérios',?,NULL,NULL,0,'idle')").run(runId,reviewerRuntime??runtime);this.emit(runId,'agent.spawned','supervisor',{agentId:'reviewer',displayName:'Revisor independente',role:'Revisão por critérios',runtime:reviewerRuntime??runtime,parentId:null,profile:null,dynamic:false});}this.db.prepare("UPDATE tasks SET assignee_id=COALESCE(assignee_id,'orchestrator'),reviewer_id=COALESCE(reviewer_id,'reviewer') WHERE run_id=? AND title='Objetivo raiz'").run(runId);this.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=?").run(iso(),runId);return this.emit(runId,'run.status','supervisor',{status:'running',reason:'Runtime oficial disponível; executa em nova sessão se turno anterior não commitou.'});}); }
  getRun(runId) {
    const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId); if (!r) return null;
    const agents = this.db.prepare('SELECT * FROM agents WHERE run_id=? ORDER BY rowid').all(runId).map(x => ({agentId:x.id,displayName:x.display_name,role:x.role,runtime:x.runtime,parentId:x.parent_id,profile:x.profile,dynamic:!!x.dynamic,status:x.status}));
    const tasks = this.db.prepare('SELECT * FROM tasks WHERE run_id=? ORDER BY created_at').all(runId).map(x => ({taskId:x.id,title:x.title,objective:x.objective,criterionIds:parse(x.criterion_ids),assigneeId:x.assignee_id??undefined,reviewerId:x.reviewer_id??undefined,parentTaskId:x.parent_task_id??undefined,contextRefs:parse(x.context_refs),status:x.status,result:x.result??undefined,authorId:x.author_id,createdAt:x.created_at}));
    const criteria = this.db.prepare('SELECT * FROM criteria WHERE run_id=? ORDER BY rowid').all(runId).map(x => ({id:x.id,description:x.description,status:x.status,evidenceIds:parse(x.evidence_ids)}));
    const evidence = this.db.prepare('SELECT * FROM evidence WHERE run_id=? ORDER BY created_at').all(runId).map(x => ({id:x.id,kind:x.kind,label:x.label,uri:x.uri??undefined,excerpt:x.excerpt??undefined,relatedTaskId:x.related_task_id??undefined,claims:parse(x.claims),sha256:x.sha256??null,provenance:x.provenance,verifiedAt:x.verified_at??null}));
    return {runId:r.id,title:r.title,prompt:r.prompt,workspace:r.workspace,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at,lastSeq:r.last_seq,agents,tasks,criteria,evidence};
  }
  listRuns(limit = 100) { return this.db.prepare('SELECT id,prompt,title,workspace,status,created_at,updated_at,last_seq FROM runs ORDER BY created_at DESC LIMIT ?').all(limit).map(r=>({runId:r.id,prompt:r.prompt,title:r.title,workspace:r.workspace,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at,lastSeq:r.last_seq})); }
  listEvents(runId, after = 0, limit = 1000) { return this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId,after,limit).map(r=>({id:r.id,seq:r.seq,runId:r.run_id,type:r.type,ts:r.ts,actorId:r.actor_id,turnId:r.turn_id,messageId:r.message_id,recipients:parse(r.recipients),taskId:r.task_id,causation:r.causation,payload:parse(r.payload)})); }
  eventSeq(runId,eventId) { return this.db.prepare('SELECT seq FROM events WHERE run_id=? AND id=?').get(runId,eventId)?.seq ?? null; }
  addMessage(runId, body, options = {}) {
    const messageId=id('msg'), inboxId=id('inbox'), now=iso();
    return this.tx(()=>{
      if(!this.db.prepare('SELECT 1 FROM runs WHERE id=?').get(runId)) throw new Error('run_not_found');
      const recipient=options.recipientId??'orchestrator';
      this.db.prepare('INSERT INTO inbox(id,run_id,recipient_id,sender_id,message_id,body,status,created_at) VALUES(?,?,? ,?,?,? ,\'pending\',?)').run(inboxId,runId,recipient,options.senderId??'user',messageId,body,now);
      const event=this.emit(runId,'message.completed',options.senderId??'user',{body,format:options.format??'text',...(options.inReplyTo?{inReplyTo:options.inReplyTo}:{}),contextRefs:options.contextRefs??[],evidenceIds:[]},{messageId,recipients:[recipient]});
      return {messageId,turnId:null,status:'accepted',event};
    });
  }
  startTurn({runId,agentId,taskId=null,prompt,context={}}) { return this.tx(()=>this.queueTurnTx({runId,agentId,taskId,prompt,context})); }
  queueTurnTx({runId,agentId,taskId=null,prompt,context={}}) {
    const run=this.db.prepare('SELECT status FROM runs WHERE id=?').get(runId);if(!run)throw new Error('run_not_found');
    if(['paused','paused_quota','paused_auth','stalled','cancelled','completed','failed'].includes(run.status))throw new Error('run_not_runnable');
    const agent=this.db.prepare('SELECT * FROM agents WHERE run_id=? AND id=?').get(runId,agentId);if(!agent)throw new Error('agent_not_found');
    const active=this.db.prepare("SELECT id FROM turns WHERE run_id=? AND agent_id=? AND status IN ('running','cancelling')").get(runId,agentId);
    const queued=this.db.prepare("SELECT * FROM turns WHERE run_id=? AND agent_id=? AND status='queued' ORDER BY created_at LIMIT 1").get(runId,agentId);
    const turnId=queued?.id??id('turn');
    const pending=this.db.prepare(`SELECT id,message_id,sender_id,body FROM inbox WHERE run_id=? AND recipient_id IN (?, '*') AND acked_at IS NULL AND (included_turn_id IS NULL OR included_turn_id=? OR included_turn_id IN (SELECT id FROM turns WHERE run_id=? AND agent_id=? AND status NOT IN ('running','queued'))) ORDER BY created_at,id`).all(runId,agentId,turnId,runId,agentId);
    const inboxIds=[...new Set([...(queued?parse(queued.included_inbox_ids):[]),...pending.map(x=>x.id)])];
    const inboxById=new Map(pending.map(x=>[x.id,x]));
    const inbox=inboxIds.map(x=>inboxById.get(x)).filter(Boolean).map(x=>({inboxId:x.id,messageId:x.message_id,from:x.sender_id,body:x.body}));
    const refs={...(queued?parse(queued.context_snapshot):context),...context,prompt,inbox};
    let generation=queued?.generation;
    if(!queued){generation=agent.generation+1;const intentId=id('op'),now=iso();const requestHash=createHash('sha256').update(json({runId,agentId,taskId,prompt,context:refs})).digest('hex');
      this.db.prepare("INSERT INTO intents(id,run_id,turn_id,logical_key,request_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?)").run(intentId,runId,turnId,`turn:${agentId}:${turnId}`,requestHash,now,now);
      this.db.prepare("INSERT INTO turns(run_id,id,agent_id,task_id,generation,status,attempt,operation_intent_id,included_inbox_ids,context_snapshot,resume_session_id,created_at) VALUES(?,?,?,?,?,? ,1,?,?,?,?,?)")
        .run(runId,turnId,agentId,taskId,generation,active?'queued':'running',intentId,json(inboxIds),json(refs),null,now);
    } else this.db.prepare('UPDATE turns SET task_id=COALESCE(task_id,?),included_inbox_ids=?,context_snapshot=? WHERE run_id=? AND id=?').run(taskId,json(inboxIds),json(refs),runId,turnId);
    for(const inboxId of inboxIds)this.db.prepare('UPDATE inbox SET included_turn_id=? WHERE id=?').run(turnId,inboxId);
    if(!active){this.db.prepare("UPDATE agents SET generation=?,status='running' WHERE run_id=? AND id=?").run(generation,runId,agentId);if(taskId){const changed=this.db.prepare("UPDATE tasks SET status='running' WHERE run_id=? AND id=? AND status IN ('pending','ready')").run(runId,taskId).changes;if(changed)this.emitTaskStarted(runId,taskId,turnId);}this.emit(runId,'agent.status','supervisor',{agentId,status:'running'},{turnId,taskId});}
    const turn=this.db.prepare('SELECT operation_intent_id,resume_session_id FROM turns WHERE run_id=? AND id=?').get(runId,turnId);
    return {runId,turnId,agentId,taskId:queued?.task_id??taskId,generation,operationIntentId:turn.operation_intent_id,resumeSessionId:turn.resume_session_id??null,context:refs,inboxIds,queued:!!active};
  }
  acceptHumanMessage({runId,body,format='text',contextRefs=[],taskId,clientMessageId}) {
    return this.tx(()=>{
      const run=this.db.prepare('SELECT status,workspace FROM runs WHERE id=?').get(runId);if(!run)throw new Error('run_not_found');
      if(typeof clientMessageId!=='string'||clientMessageId.length<8||clientMessageId.length>128)throw new Error('invalid_client_message_id');
      const prior=this.db.prepare('SELECT message_id,included_turn_id FROM inbox WHERE run_id=? AND client_message_id=?').get(runId,clientMessageId);
      if(prior){const e=this.db.prepare('SELECT * FROM events WHERE run_id=? AND message_id=?').get(runId,prior.message_id);if(e){const old=parse(e.payload);if(old.body!==body||old.format!==format||json(old.contextRefs??[])!==json(contextRefs??[]))throw new Error('client_message_conflict');}const ev=e?{id:e.id,seq:e.seq,runId,type:e.type,ts:e.ts,actorId:e.actor_id,turnId:e.turn_id,messageId:e.message_id,recipients:parse(e.recipients),taskId:e.task_id,causation:e.causation,payload:parse(e.payload)}:null;return{messageId:prior.message_id,turnId:prior.included_turn_id??ev?.turnId??null,status:'accepted',clientMessageId,event:ev,queued:false};}
      if(run.status?.startsWith('paused'))throw new Error('run_paused');
      if(['cancelled','completed','failed'].includes(run.status))throw new Error('run_not_runnable');
      const wasStalled=run.status==='stalled';
      if(wasStalled){
        const now=iso();this.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=?").run(now,runId);
        this.emit(runId,'run.status','supervisor',{status:'running',reason:'Nova mensagem recebida; retomada em turno e sessão novos.'});
        for(const row of this.db.prepare("SELECT id,assignee_id FROM tasks WHERE run_id=? AND status='blocked'").all(runId)){
          this.db.prepare("UPDATE tasks SET status='ready' WHERE run_id=? AND id=? AND status='blocked'").run(runId,row.id);
          this.emit(runId,'task.status','supervisor',{taskId:row.id,status:'ready'},{taskId:row.id,recipients:row.assignee_id?[row.assignee_id]:[]});
        }
      }
      const messageId=id('msg'),inboxId=id('inbox'),now=iso();
      this.db.prepare("INSERT INTO inbox(id,run_id,recipient_id,sender_id,message_id,body,status,created_at,client_message_id) VALUES(?,?,'orchestrator','user',?,?,'pending',?,?)").run(inboxId,runId,messageId,body,now,clientMessageId);
      let turn=null;if(['running','created','stalled'].includes(run.status))turn=this.queueTurnTx({runId,agentId:'orchestrator',taskId,prompt:body,context:{workspace:run.workspace,source:'human_message',contextRefs}});
      const event=this.emit(runId,'message.completed','user',{body,format,contextRefs,evidenceIds:[],clientMessageId},{messageId,turnId:turn?.turnId??null,recipients:['orchestrator']});
      if(wasStalled)this.requeuePendingReviews(runId,event.id);
      return {messageId,turnId:turn?.turnId??null,status:'accepted',clientMessageId,event,queued:turn?.queued??true};
    });
  }
  requeuePendingReviews(runId,causation) {
    const tasks=this.db.prepare("SELECT id,title,result,assignee_id,reviewer_id FROM tasks WHERE run_id=? AND status='review'").all(runId);
    for(const task of tasks){if(!task.reviewer_id)continue;const prefix=`Encaminhamento automático para revisão da tarefa: ${task.title}`;const pending=this.db.prepare("SELECT body FROM inbox WHERE run_id=? AND recipient_id=? AND acked_at IS NULL AND sender_id='supervisor'").all(runId,task.reviewer_id).some(row=>row.body.startsWith(prefix));if(pending)continue;
      const inboxId=`inbox_resume_${causation}_${task.id}`,operationIntentId=`resume_${causation}_${task.id}`,messageId=`dispatch_${causation}_${task.id}`,inboxBody=`${prefix}\nRetomada após mensagem humana; a decisão independente ainda está pendente.\nEnviada originalmente pelo agente ${task.assignee_id??'desconhecido'}.\n\n${task.result??''}`;
      this.db.prepare("INSERT OR IGNORE INTO inbox(id,run_id,recipient_id,sender_id,message_id,body,status,created_at,operation_intent_id) VALUES(?,?,?,'supervisor',?,?,'pending',?,?)").run(inboxId,runId,task.reviewer_id,messageId,inboxBody,iso(),operationIntentId);
      this.emit(runId,'task.status','supervisor',{taskId:task.id,status:'review',...(task.result?{result:task.result}:{}),submittedBy:task.assignee_id??undefined},{turnId:null,taskId:task.id,recipients:[task.reviewer_id],causation});
    }
  }
  humanMessage(runId,message) { return this.acceptHumanMessage({runId,...message}); }
  activateQueued(runId,agentId) {
    return this.tx(()=>{
      if(this.db.prepare("SELECT 1 FROM turns WHERE run_id=? AND agent_id=? AND status IN ('running','cancelling')").get(runId,agentId))return null;
      const turn=this.db.prepare("SELECT * FROM turns WHERE run_id=? AND agent_id=? AND status='queued' ORDER BY created_at LIMIT 1").get(runId,agentId);if(!turn)return null;
      const run=this.db.prepare('SELECT status FROM runs WHERE id=?').get(runId);if(!run||run.status!=='running')return null;
      this.db.prepare("UPDATE turns SET status='running' WHERE run_id=? AND id=? AND status='queued'").run(runId,turn.id);
      this.db.prepare("UPDATE agents SET status='running',generation=? WHERE run_id=? AND id=?").run(turn.generation,runId,agentId);
      if(turn.task_id){const changed=this.db.prepare("UPDATE tasks SET status='running' WHERE run_id=? AND id=? AND status IN ('pending','ready')").run(runId,turn.task_id).changes;if(changed)this.emitTaskStarted(runId,turn.task_id,turn.id);}
      this.emit(runId,'agent.status','supervisor',{agentId,status:'running'},{turnId:turn.id,taskId:turn.task_id});
      return {runId,turnId:turn.id,agentId,taskId:turn.task_id,generation:turn.generation,operationIntentId:turn.operation_intent_id,resumeSessionId:turn.resume_session_id,context:parse(turn.context_snapshot),inboxIds:parse(turn.included_inbox_ids),queued:false};
    });
  }
  hasQueuedTurn(runId,agentId) { return !!this.db.prepare("SELECT 1 FROM turns WHERE run_id=? AND agent_id=? AND status='queued'").get(runId,agentId); }
  emitTaskStarted(runId,taskId,turnId) {
    const t=this.db.prepare('SELECT * FROM tasks WHERE run_id=? AND id=?').get(runId,taskId);if(!t)return;
    this.emit(runId,'task.started','supervisor',{taskId,title:t.title,objective:t.objective,criterionIds:parse(t.criterion_ids),assigneeId:t.assignee_id,reviewerId:t.reviewer_id,parentTaskId:t.parent_task_id??undefined,contextRefs:parse(t.context_refs),status:'running'},{turnId,taskId,recipients:[t.assignee_id]});
  }
  getOrCreateIntent({runId,turnId,logicalKey,request}) {
    return this.tx(()=>{
      const turn=this.db.prepare("SELECT status,generation,agent_id FROM turns WHERE run_id=? AND id=?").get(runId,turnId);if(!turn||turn.status!=='running')throw new Error('turn_not_active');
      const capability=this.db.prepare('SELECT generation FROM agents WHERE run_id=? AND id=?').get(runId,turn.agent_id);if(capability?.generation!==turn.generation)throw new Error('stale_generation');
      const hash=createHash('sha256').update(json(request)).digest('hex');
      const found=this.db.prepare('SELECT * FROM intents WHERE run_id=? AND logical_key=?').get(runId,logicalKey);
      if(found){if(found.request_hash!==hash)throw new Error('intent_conflict');if(found.status==='outcome_uncertain')throw new Error('outcome_uncertain');if(found.status==='prepared'&&found.turn_id!==turnId)this.db.prepare('UPDATE intents SET turn_id=?,updated_at=? WHERE id=?').run(turnId,iso(),found.id);return{id:found.id,status:found.status,outcome:parse(found.outcome,null)};}
      const intentId=id('op'),now=iso();this.db.prepare('INSERT INTO intents(id,run_id,turn_id,logical_key,request_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,\'prepared\',?,?)').run(intentId,runId,turnId,logicalKey,hash,now,now);
      return{id:intentId,status:'prepared',outcome:null};
    });
  }
  getIntentByKey(runId, logicalKey) { const r=this.db.prepare('SELECT * FROM intents WHERE run_id=? AND logical_key=?').get(runId,logicalKey); return r?{id:r.id,status:r.status,outcome:parse(r.outcome,null)}:null; }
  applyIntent(runId,intentId,turnId,generation,action) {
    return this.tx(()=>{
      const intent=this.db.prepare('SELECT * FROM intents WHERE id=? AND run_id=?').get(intentId,runId);
      if(!intent)throw new Error('intent_not_found'); if(intent.status==='committed')return parse(intent.outcome,null); if(intent.status==='outcome_uncertain')throw new Error('outcome_uncertain');
      const turn=this.db.prepare('SELECT * FROM turns WHERE run_id=? AND id=?').get(runId,turnId);
      const agent=turn&&this.db.prepare('SELECT generation FROM agents WHERE run_id=? AND id=?').get(runId,turn.agent_id);
      if(!turn||turn.status!=='running'||turn.generation!==generation||turn.generation!==agent?.generation)throw new Error('stale_generation');
      const result=action(this.db,intent,turn);
      this.db.prepare("UPDATE intents SET status='committed',outcome=?,updated_at=? WHERE id=?").run(json(result),iso(),intentId); return result;
    });
  }
  sendPeer({runId,intentId,turnId,generation,senderId,recipients,body,inReplyTo,contextRefs=[]}) {
    return this.applyIntent(runId,intentId,turnId,generation,(db,intent,turn)=>{
      const now=iso(),messageId=`msg_${intent.id}`;
      for(const recipient of recipients)db.prepare("INSERT OR IGNORE INTO inbox(id,run_id,recipient_id,sender_id,message_id,body,status,created_at,operation_intent_id) VALUES(?,?,?,?,?,?,'pending',?,?)").run(`inbox_${intent.id}_${recipient}`,runId,recipient,senderId,messageId,body,now,intent.id);
      if(!db.prepare('SELECT 1 FROM events WHERE run_id=? AND message_id=?').get(runId,messageId))this.emit(runId,'message.completed',senderId,{body,format:'markdown',...(inReplyTo?{inReplyTo}:{}),contextRefs,evidenceIds:[]},{messageId,recipients,turnId:turn.id});
      return {messageId,recipients,status:'sent'};
    });
  }
  proposeTask({runId,intentId,turnId,generation,authorId,proposal,assigneeId,reviewerId}) {
    return this.applyIntent(runId,intentId,turnId,generation,(db,intent,turn)=>{
      const taskId=`task_${intent.id}`,now=iso();
      db.prepare("INSERT OR IGNORE INTO tasks(run_id,id,title,objective,criterion_ids,assignee_id,reviewer_id,parent_task_id,context_refs,status,author_id,created_at,operation_intent_id) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)")
        .run(runId,taskId,proposal.title,proposal.objective,json(proposal.criterionIds),assigneeId,reviewerId,proposal.parentTaskId??null,json(proposal.contextRefs??[]),authorId,now,intentId);
      if(!db.prepare('SELECT 1 FROM events WHERE run_id=? AND task_id=? AND type=?').get(runId,taskId,'task.status'))this.emit(runId,'task.status',authorId,{taskId,status:'pending'},{taskId,recipients:[assigneeId],turnId:turn.id});
      return {taskId,assigneeId,reviewerId,status:'pending'};
    });
  }
  addSpecialistForIntent({runId,intentId,turnId,generation,actorId,name,profile,scope='',budget=2,runtime}) {
    return this.applyIntent(runId,intentId,turnId,generation,(db,intent,turn)=>{
      const agentId=`agent_${intentId}`,parent=actorId==='orchestrator'?null:db.prepare('SELECT parent_id FROM agents WHERE run_id=? AND id=?').get(runId,actorId)?.parent_id??actorId;
      db.prepare("INSERT OR IGNORE INTO agents(run_id,id,display_name,role,runtime,parent_id,profile,dynamic,status,scope,budget,operation_intent_id) VALUES(?,?,?,?,?,?,?,1,'idle',?,?,?)")
        .run(runId,agentId,name,profile,runtime,parent,profile,scope,budget,intentId);
      const agent={agentId,displayName:name,role:profile,runtime,parentId:parent,profile,dynamic:true,status:'idle'};
      if(!db.prepare('SELECT 1 FROM events WHERE run_id=? AND type=? AND json_extract(payload,\'$.agentId\')=?').get(runId,'agent.spawned',agentId))this.emit(runId,'agent.spawned',actorId,agent,{turnId:turn.id}); return {agent};
    });
  }
  recordEvidence({runId,intentId,turnId,generation,record,actorId}) {
    return this.applyIntent(runId,intentId,turnId,generation,(db,intent,turn)=>{
      const now=iso();db.prepare('INSERT OR IGNORE INTO evidence(run_id,id,kind,label,uri,excerpt,related_task_id,claims,sha256,provenance,verified_at,created_at,operation_intent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(runId,record.id,record.kind,record.label,record.uri??null,record.excerpt??null,record.relatedTaskId??null,json(record.claims??[]),record.sha256,record.provenance,record.verifiedAt,now,intentId);
      if(!db.prepare('SELECT 1 FROM events WHERE run_id=? AND type=? AND json_extract(payload,\'$.id\')=?').get(runId,'evidence.published',record.id))this.emit(runId,'evidence.published',actorId,record,{taskId:record.relatedTaskId??null,turnId:turn.id}); return record;
    });
  }
  publishArtifact({runId,intentId,turnId,generation,actorId,name,mime,bytes,label,relatedTaskId,claims=[]}) {
    return this.applyIntent(runId,intentId,turnId,generation,(db,intent,turn)=>{
      const content=Buffer.from(bytes),sha256=createHash('sha256').update(content).digest('hex'),artifactId=`artifact_${intent.id}`;
      const safeName=String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,120)||'artifact.bin';
      const target=join(this.artifactsDir,`${artifactId}.bin`);
      if(existsSync(target)){const prior=readFileSync(target);if(createHash('sha256').update(prior).digest('hex')!==sha256)throw new Error('artifact_conflict');}
      else writeFileSync(target,content,{flag:'wx'});
      const now=iso(),record={id:`evi_${intent.id}`,kind:'artifact',label:String(label).trim(),uri:`/api/runs/${runId}/artifacts/${artifactId}`,relatedTaskId:relatedTaskId??turn.task_id??undefined,claims:Array.isArray(claims)?claims.slice(0,30):[],sha256,provenance:'supervisor_verified',verifiedAt:now};
      db.prepare('INSERT OR IGNORE INTO artifacts(run_id,id,name,mime,size,content_path,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)').run(runId,artifactId,safeName,mime,content.length,target,sha256,now);
      if(!db.prepare('SELECT 1 FROM events WHERE run_id=? AND type=? AND json_extract(payload,\'$.artifactId\')=?').get(runId,'artifact.published',artifactId))this.emit(runId,'artifact.published',actorId,{artifactId,name:safeName,mime,size:content.length},{turnId,taskId:record.relatedTaskId});
      db.prepare('INSERT OR IGNORE INTO evidence(run_id,id,kind,label,uri,related_task_id,claims,sha256,provenance,verified_at,created_at,operation_intent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(runId,record.id,record.kind,record.label,record.uri,record.relatedTaskId??null,json(record.claims),sha256,record.provenance,record.verifiedAt,now,intentId);
      if(!db.prepare('SELECT 1 FROM events WHERE run_id=? AND type=? AND json_extract(payload,\'$.id\')=?').get(runId,'evidence.published',record.id))this.emit(runId,'evidence.published',actorId,record,{turnId,taskId:record.relatedTaskId??null});
      return {artifactId,name:safeName,mime,size:content.length,sha256,evidence:record};
    });
  }
  getArtifact(runId,artifactId) { const a=this.db.prepare('SELECT id,name,mime,size,content_path,sha256 FROM artifacts WHERE run_id=? AND id=?').get(runId,artifactId);return a?{artifactId:a.id,name:a.name,mime:a.mime,size:a.size,contentPath:a.content_path,sha256:a.sha256}:null; }
  progress({runId,intentId,turnId,generation,criterionId,description,evidenceIds}) {
    return this.applyIntent(runId,intentId,turnId,generation,(db,intent,turn)=>{
      const c=db.prepare('SELECT * FROM criteria WHERE run_id=? AND id=?').get(runId,criterionId);if(!c)throw new Error('criterion_not_found');
      for(const evidenceId of evidenceIds)if(!db.prepare('SELECT 1 FROM evidence WHERE run_id=? AND id=?').get(runId,evidenceId))throw new Error('evidence_not_found');
      const status=evidenceIds.some(eid=>db.prepare('SELECT provenance FROM evidence WHERE run_id=? AND id=?').get(runId,eid)?.provenance==='supervisor_verified')?'covered':'in_progress',all=[...new Set([...parse(c.evidence_ids),...evidenceIds])];
      db.prepare('UPDATE criteria SET status=?,evidence_ids=? WHERE run_id=? AND id=?').run(status,json(all),runId,criterionId);
      this.emit(runId,'criterion.status','supervisor',{criterionId,description:description||c.description,status,evidenceIds:all},{turnId:turn.id});return {criterionId,status,evidenceIds:all};
    });
  }
  finishTurn({runId,turnId,generation,outcome,actorId}) {
    return this.tx(()=>{
      const turn=this.db.prepare('SELECT * FROM turns WHERE run_id=? AND id=?').get(runId,turnId);if(!turn)return false;
      const agent=this.db.prepare('SELECT generation FROM agents WHERE run_id=? AND id=?').get(runId,turn.agent_id);
      if(turn.status!=='running'||turn.generation!==generation||agent?.generation!==generation)return false;
      const now=iso(), status=outcome.status;
      if(status==='outcome_uncertain'){
        const priorRunStatus=this.db.prepare('SELECT status FROM runs WHERE id=?').get(runId)?.status;
        const uncertain=outcome.error??{code:'unknown',message:'Outcome uncertain',retryable:false};
        this.db.prepare("UPDATE turns SET status='outcome_uncertain',error=? WHERE run_id=? AND id=?").run(json(uncertain),runId,turnId);
        this.db.prepare("UPDATE intents SET status='outcome_uncertain',outcome=?,updated_at=? WHERE id=?").run(json({status:'outcome_uncertain',error:uncertain}),now,turn.operation_intent_id);
        this.db.prepare("UPDATE agents SET status='waiting' WHERE run_id=? AND id=?").run(runId,turn.agent_id);
        const nextRunStatus=priorRunStatus==='paused'?'paused':'stalled';
        if(nextRunStatus!=='paused')this.db.prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?').run(nextRunStatus,now,runId);
        if(turn.task_id)this.finishFailedTask(runId,turn.task_id,turn.agent_id,turnId,'blocked');
        this.db.prepare("UPDATE intents SET status='outcome_uncertain',outcome=?,updated_at=? WHERE id=?").run(json(outcome),now,turn.operation_intent_id);
        this.emit(runId,'turn.stalled','supervisor',{agentId:turn.agent_id,turnId,reason:outcome.error?.message??'Outcome uncertain',attempts:turn.attempt});
        this.emit(runId,'run.status','supervisor',{status:nextRunStatus,reason:nextRunStatus==='paused'?'Pausado; turno interrompido e tarefa pronta para retomada.':'Resultado externo incerto; exige reconciliação.'},{turnId});
        return true;
      }
      const completed=status==='completed';
      this.db.prepare('UPDATE turns SET status=?,session_id=?,output=?,error=?,committed_at=? WHERE run_id=? AND id=?').run(status, outcome.sessionId??null,outcome.text??null,outcome.error?json(outcome.error):null,now,runId,turnId);
      this.db.prepare('UPDATE agents SET status=? WHERE run_id=? AND id=?').run(completed?'idle':status==='cancelled'?'cancelled':'failed',runId,turn.agent_id);
      if(turn.task_id&&!completed){const runStatus=this.db.prepare('SELECT status FROM runs WHERE id=?').get(runId)?.status;this.finishFailedTask(runId,turn.task_id,turn.agent_id,turnId,status==='cancelled'&&runStatus==='cancelled'?'cancelled':'blocked');}
      if(completed&&outcome.text?.trim())this.emit(runId,'message.completed',actorId,{body:outcome.text,format:'markdown',contextRefs:[],evidenceIds:[]},{turnId,messageId:turnId,taskId:turn.task_id,recipients:['user']});
      // Acknowledge only the exact inbox ids snapshotted into this turn and only with this committed accepted envelope.
      const included=parse(turn.included_inbox_ids);
      if(completed)for(const inboxId of included)this.db.prepare('UPDATE inbox SET acked_at=? WHERE id=? AND run_id=? AND acked_at IS NULL AND included_turn_id=?').run(now,inboxId,runId,turnId);
      this.db.prepare('UPDATE intents SET status=?,outcome=?,updated_at=? WHERE id=?').run(status==='outcome_uncertain'?'outcome_uncertain':'committed',json(outcome),now,turn.operation_intent_id);
      this.emit(runId,'agent.status','supervisor',{agentId:turn.agent_id,status:completed?'idle':status==='cancelled'?'cancelled':'failed'},{turnId,taskId:turn.task_id});
      return true;
    });
  }
  finishFailedTask(runId,taskId,agentId,turnId,status) {
    const changed=this.db.prepare("UPDATE tasks SET status=? WHERE run_id=? AND id=? AND status='running'").run(status,runId,taskId).changes;
    if(changed)this.emit(runId,'task.status','supervisor',{taskId,status},{turnId,taskId,recipients:[agentId]});
  }
  prepareResumeTasks(runId) {
    return this.tx(()=>{const rows=this.db.prepare("SELECT id,assignee_id FROM tasks WHERE run_id=? AND status='blocked'").all(runId);for(const row of rows){this.db.prepare("UPDATE tasks SET status='ready' WHERE run_id=? AND id=? AND status='blocked'").run(runId,row.id);this.emit(runId,'task.status','supervisor',{taskId:row.id,status:'ready'},{taskId:row.id,recipients:row.assignee_id?[row.assignee_id]:[]});}return rows.length;});
  }
  recoverInterrupted() {
    return this.tx(()=>{
      const live=this.db.prepare("SELECT * FROM turns WHERE status IN ('running','cancelling')").all();
      for(const turn of live){const error={code:'process_restarted',message:'Turn interrupted by process restart; start a new CLI session and reconcile inbox.',retryable:false},now=iso();this.db.prepare("UPDATE turns SET status='outcome_uncertain',error=? WHERE run_id=? AND id=?").run(json(error),turn.run_id,turn.id);this.db.prepare("UPDATE intents SET status='outcome_uncertain',outcome=?,updated_at=? WHERE id=? AND status='prepared'").run(json({status:'outcome_uncertain',error}),now,turn.operation_intent_id);this.db.prepare("UPDATE agents SET status='waiting',generation=generation+1 WHERE run_id=? AND id=?").run(turn.run_id,turn.agent_id);this.db.prepare("UPDATE runs SET status='stalled',updated_at=? WHERE id=?").run(now,turn.run_id);if(turn.task_id)this.finishFailedTask(turn.run_id,turn.task_id,turn.agent_id,turn.id,'blocked');this.emit(turn.run_id,'turn.stalled','supervisor',{agentId:turn.agent_id,turnId:turn.id,reason:'Process restarted before a complete commit; inbox retained for a new session.',attempts:turn.attempt});this.emit(turn.run_id,'run.status','supervisor',{status:'stalled',reason:'Turn interrupted; reconciliation required.'},{turnId:turn.id});}
      return live.length;
    });
  }
  addSpecialist({runId,actorId,name,profile,scope='',budget=2,runtime}) {
    return this.tx(()=>{
      const agentId=id('agent'),run=this.db.prepare('SELECT status FROM runs WHERE id=?').get(runId);if(!run)throw new Error('run_not_found');
      if(run.status==='cancelled'||run.status==='completed'||run.status==='failed')throw new Error('run_not_runnable');
      const parent=actorId==='orchestrator'?null:actorId==='user'?'orchestrator':this.db.prepare('SELECT parent_id FROM agents WHERE run_id=? AND id=?').get(runId,actorId)?.parent_id??'orchestrator';
      const effectiveScope=scope.trim();
      this.db.prepare('INSERT INTO agents(run_id,id,display_name,role,runtime,parent_id,profile,dynamic,status,scope,budget) VALUES(?,?,?,?,?,?,?,1,\'idle\',?,?)').run(runId,agentId,name.trim(),profile,runtime,parent,profile,effectiveScope,budget);
      const agent={agentId,displayName:name.trim(),role:profile,runtime,parentId:parent,profile,dynamic:true,status:'idle'};
      this.emit(runId,'agent.spawned',actorId,{...agent});return agent;
    });
  }
  taskDecision({runId,intentId,turnId,generation,actorId,taskId,decision,result,evidenceIds=[]}) {
    return this.applyIntent(runId,intentId,turnId,generation,(db,intent,activeTurn)=>{
      const turn=this.db.prepare('SELECT * FROM turns WHERE run_id=? AND id=?').get(runId,turnId),agent=turn&&this.db.prepare('SELECT generation FROM agents WHERE run_id=? AND id=?').get(runId,turn.agent_id);
      if(!turn||turn.status!=='running'||turn.generation!==generation||agent?.generation!==generation||turn.agent_id!==actorId)throw new Error('stale_generation');
      const task=this.db.prepare('SELECT * FROM tasks WHERE run_id=? AND id=?').get(runId,taskId);if(!task)throw new Error('task_not_found');
      for(const eid of evidenceIds)if(!this.db.prepare('SELECT 1 FROM evidence WHERE run_id=? AND id=?').get(runId,eid))throw new Error('evidence_not_found');
      if(decision==='submit') { if(task.assignee_id!==actorId||task.status!=='running')throw new Error('task_assignee_required');
        this.db.prepare("UPDATE tasks SET status='review',result=? WHERE run_id=? AND id=?").run(result,runId,taskId);
        this.emit(runId,'task.status','supervisor',{taskId,status:'review',result,submittedBy:actorId},{turnId,taskId,recipients:[task.reviewer_id],causation:intent.id});
        const inboxId=`inbox_review_${intent.id}`,body=`Encaminhamento automático para revisão da tarefa: ${task.title}\nEnviada pelo agente ${actorId}.\n\n${result}\n\nEvidence IDs: ${evidenceIds.join(', ')}`;
        this.db.prepare("INSERT OR IGNORE INTO inbox(id,run_id,recipient_id,sender_id,message_id,body,status,created_at,operation_intent_id) VALUES(?,?,?,?,?,?,'pending',?,?)").run(inboxId,runId,task.reviewer_id,'supervisor',`dispatch_${intent.id}`,body,iso(),intent.id);
        return {taskId,status:'review',reviewerId:task.reviewer_id};
      }
      if(decision==='accept') { if(task.reviewer_id!==actorId||task.assignee_id===actorId||task.status!=='review')throw new Error('task_reviewer_required');
        const refs=[...new Set([...parse(task.criterion_ids),...evidenceIds])];
        if(!evidenceIds.length||!evidenceIds.some(eid=>db.prepare('SELECT provenance FROM evidence WHERE run_id=? AND id=?').get(runId,eid)?.provenance==='supervisor_verified'))throw new Error('review_evidence_required');
        this.db.prepare("UPDATE tasks SET status='completed',result=? WHERE run_id=? AND id=?").run(result??task.result,runId,taskId);
        for(const criterionId of parse(task.criterion_ids)){
          const c=this.db.prepare('SELECT * FROM criteria WHERE run_id=? AND id=?').get(runId,criterionId);if(!c)continue;
          const linked=[...new Set([...parse(c.evidence_ids),...evidenceIds])];
          const trusted=linked.filter(eid=>this.db.prepare('SELECT provenance FROM evidence WHERE run_id=? AND id=?').get(runId,eid)?.provenance==='supervisor_verified');
          if(trusted.length){this.db.prepare("UPDATE criteria SET status='accepted',evidence_ids=? WHERE run_id=? AND id=?").run(json(trusted),runId,criterionId);this.emit(runId,'criterion.status','supervisor',{criterionId,description:c.description,status:'accepted',evidenceIds:trusted},{turnId,taskId});}
        }
        this.emit(runId,'task.completed',actorId,{taskId,status:'completed',result:result??task.result,reviewerId:actorId},{turnId,taskId,recipients:[task.assignee_id]});
        return {taskId,status:'completed',reviewerId:actorId};
      }
      if(decision==='reject') { if(task.reviewer_id!==actorId||task.status!=='review')throw new Error('task_reviewer_required');this.db.prepare("UPDATE tasks SET status='ready',result=? WHERE run_id=? AND id=?").run(result,runId,taskId);this.emit(runId,'task.status','supervisor',{taskId,status:'ready',result,reviewerId:actorId},{turnId,taskId,recipients:[task.assignee_id]});return{taskId,status:'ready',reviewerId:actorId};}
      throw new Error('invalid_task_decision');
    });
  }
  completeRunIfReady(runId) {
    return this.tx(()=>{
      const run=this.db.prepare('SELECT status FROM runs WHERE id=?').get(runId);if(!run||run.status!=='running')return false;
      const incomplete=this.db.prepare("SELECT count(*) AS n FROM criteria WHERE run_id=? AND status!='accepted'").get(runId).n;
      const openTasks=this.db.prepare("SELECT count(*) AS n FROM tasks WHERE run_id=? AND status!='completed'").get(runId).n;
      const activeTurns=this.db.prepare("SELECT count(*) AS n FROM turns WHERE run_id=? AND status IN ('queued','running','cancelling')").get(runId).n;
      if(incomplete||openTasks||activeTurns)return false;
      const revision=this.db.prepare("SELECT count(*) AS n FROM events WHERE run_id=? AND type='report.updated'").get(runId).n+1;
      this.emit(runId,'report.updated','supervisor',{revision,format:'markdown',summary:'Objetivo raiz e critérios aceitos pelo revisor com evidências verificadas.'});
      this.db.prepare("UPDATE runs SET status='completed',updated_at=? WHERE id=?").run(iso(),runId);
      this.emit(runId,'run.status','supervisor',{status:'completed',reason:'Objetivo raiz e todos os critérios aceitos com evidência por revisor distinto.'});
      return true;
    });
  }
  setRunStatus(runId,status,reason) { return this.tx(()=>{const r=this.db.prepare('SELECT 1 FROM runs WHERE id=?').get(runId);if(!r)throw new Error('run_not_found');this.db.prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?').run(status,iso(),runId);return this.emit(runId,'run.status','supervisor',{status,reason});}); }
  ackTurnMessages(runId,turnId,generation) { return this.tx(()=>{const t=this.db.prepare('SELECT * FROM turns WHERE run_id=? AND id=?').get(runId,turnId);const a=t&&this.db.prepare('SELECT generation FROM agents WHERE run_id=? AND id=?').get(runId,t.agent_id);if(!t||t.status!=='running'||t.generation!==generation||a?.generation!==generation)throw new Error('stale_generation');const now=iso();let count=0;for(const inboxId of parse(t.included_inbox_ids))count+=this.db.prepare('UPDATE inbox SET acked_at=? WHERE id=? AND run_id=? AND included_turn_id=? AND acked_at IS NULL').run(now,inboxId,runId,turnId).changes;return count;}); }
  eventsJson(runId,after=0) { return this.listEvents(runId,after,100000); }
  closeRun(runId,status,reason) { return this.tx(()=>{const r=this.db.prepare('SELECT status FROM runs WHERE id=?').get(runId);if(!r)throw new Error('run_not_found');this.db.prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?').run(status,iso(),runId);return this.emit(runId,'run.status','supervisor',{status,reason});}); }
}

export const eventId = id;
