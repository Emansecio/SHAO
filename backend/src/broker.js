import { createHash, randomBytes } from 'node:crypto';
import { realpathSync, statSync, createReadStream, readFileSync } from 'node:fs';
import { basename, extname, relative, resolve, sep } from 'node:path';

const ok = result => ({ ok: true, result });
const fail = (code,message,retryable=false) => ({ok:false,error:{code,message,retryable}});
const str = (v,n=4000) => typeof v==='string'&&v.trim().length>0&&v.length<=n;
const canonical = value => Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`:JSON.stringify(value);
const hashFile = path => new Promise((resolveHash,reject)=>{const h=createHash('sha256');createReadStream(path).on('data',b=>h.update(b)).on('error',reject).on('end',()=>resolveHash(h.digest('hex')))});

/** Per-turn capabilities map to identity server-side; no tool argument can select an actor. */
export class TurnBroker {
  /** @type {import('./store.js').Store} */
  store;
  workspaceForRun; runtimeForParent; wake; endpoint; maxEvidenceBytes; capabilities;
  /** @param {{store: import('./store.js').Store, workspaceForRun: (runId:string)=>string, runtimeForParent:(runId:string,agentId:string)=>string, wake?:(runId:string,agentId:string)=>void, endpoint?:string, maxEvidenceBytes?:number}} options */
  constructor({store,workspaceForRun,runtimeForParent,wake=()=>{},endpoint='http://127.0.0.1:4317/internal/mcp/v1',maxEvidenceBytes=10*1024*1024}) {
    this.store=store;this.workspaceForRun=workspaceForRun;this.runtimeForParent=runtimeForParent;this.wake=wake;this.endpoint=endpoint;this.maxEvidenceBytes=maxEvidenceBytes;this.capabilities=new Map();
  }
  bindTurn({runId,agentId,turnId,generation}) {
    if(!this.store.isTurnActive(runId,turnId,generation))throw new Error('stale_generation');
    const token=randomBytes(32).toString('base64url');
    this.capabilities.set(token,{runId,agentId,turnId,generation});
    return {endpoint:this.endpoint,token};
  }
  revokeTurn(turnId,generation) { for(const [token,b] of this.capabilities)if(b.turnId===turnId&&b.generation===generation)this.capabilities.delete(token); }
  async handle(token,tool,request) {
    const binding=this.capabilities.get(token);
    if(!binding||!this.store.isTurnActive(binding.runId,binding.turnId,binding.generation))return fail('capability_expired','Turn capability is missing, expired, or fenced.');
    if(!request||!str(request.operationKey,160)||!request.input||typeof request.input!=='object'||Array.isArray(request.input))return fail('invalid_request','Invalid broker request.');
    try {
      const input=request.input;
      if(tool==='get_context')return ok(this.context(binding));
      if(!['send','propose_task','request_specialist','evidence','report_progress','task_decision'].includes(tool))return fail('unknown_tool','Unknown MCP tool.');
      // operationKey identifies one intended action; identical payloads may be separate intentional actions.
      const logicalKey=`mcp:${binding.agentId}:${tool}:${request.operationKey}`;
      const intended=this.store.getOrCreateIntent({runId:binding.runId,turnId:binding.turnId,logicalKey,request:{tool,input}});
      if(intended.status==='committed')return ok(intended.outcome);
      let result;
      switch(tool){
        case 'send': result=await this.send(binding,intended.id,input);break;
        case 'propose_task': result=this.propose(binding,intended.id,input);break;
        case 'request_specialist': result=this.specialist(binding,intended.id,input);break;
        case 'evidence': result=await this.evidence(binding,intended.id,input);break;
        case 'report_progress': result=this.progress(binding,intended.id,input);break;
        case 'task_decision': result=this.taskDecision(binding,intended.id,input);break;
      }
      return ok(result);
    } catch(e) { return fail(e instanceof Error?e.message:'broker_failure',this.safeMessage(e),false); }
  }
  safeMessage(error) { const code=error?.message??'';const known={stale_generation:'Turn is no longer active.',turn_not_active:'Turn is no longer active.',intent_conflict:'Operation key was reused with different input.',outcome_uncertain:'The prior operation has an uncertain result and will not be retried.',run_not_found:'Run not found.',agent_not_found:'Agent not found.',criterion_not_found:'Criterion not found.',evidence_not_found:'Evidence not found.',reviewer_must_differ:'Reviewer must differ from author and assignee.',task_no_assignee:'No eligible agent can be assigned this task.',invalid_scope:'Requested path is outside the run workspace.',file_too_large:'Evidence file exceeds the local size limit.',unsupported_evidence:'Evidence kind is not supported.',invalid_request:'Invalid request.'};return known[code]??'Broker operation failed validation.'; }
  context(binding) {
    const turn=this.store.getTurn(binding.runId,binding.turnId);if(!turn||turn.generation!==binding.generation)throw new Error('stale_generation');
    const run=this.store.getRun(binding.runId);const rows=this.store.db.prepare('SELECT id,kind,label,uri,sha256,provenance,verified_at,related_task_id FROM evidence WHERE run_id=? ORDER BY created_at DESC LIMIT 100').all(binding.runId);
    return {snapshot:turn.context,run:{runId:run.runId,prompt:run.prompt,workspace:run.workspace,status:run.status,criteria:run.criteria},evidence:rows};
  }
  async send(binding,intentId,input) {
    const body=input.body,recipients=[...new Set(input.recipients??[])];
    if(!str(body,12000)||!recipients.length||recipients.length>12)throw new Error('invalid_request');
    const run=this.store.getRun(binding.runId);for(const r of recipients)if(r!=='orchestrator'&&!run.agents.some(a=>a.agentId===r))throw new Error('agent_not_found');
    if(recipients.includes(binding.agentId))throw new Error('invalid_request');
    const result=this.store.sendPeer({runId:binding.runId,intentId,turnId:binding.turnId,generation:binding.generation,senderId:binding.agentId,recipients,body,inReplyTo:input.inReplyTo,contextRefs:Array.isArray(input.contextRefs)?input.contextRefs.slice(0,30):[]});
    for(const recipient of recipients)this.wake(binding.runId,recipient);return result;
  }
  propose(binding,intentId,input) {
    if(!str(input.title,160)||!str(input.objective,4000)||!Array.isArray(input.criterionIds)||input.criterionIds.length>40)throw new Error('invalid_request');
    const run=this.store.getRun(binding.runId);for(const c of input.criterionIds)if(!run.criteria.some(x=>x.id===c))throw new Error('criterion_not_found');
    if(input.parentTaskId&&!run.tasks.some(t=>t.taskId===input.parentTaskId))throw new Error('invalid_request');
    let assignee=input.assigneeId??run.agents.find(a=>a.agentId!==binding.agentId&&a.status!=='failed'&&a.status!=='cancelled')?.agentId;
    if(!assignee||!run.agents.some(a=>a.agentId===assignee))throw new Error('task_no_assignee');
    // Reviewer is assigned by the deterministic supervisor (least loaded), not the proposing model.
    let reviewer=run.agents.filter(a=>a.agentId!==binding.agentId&&a.agentId!==assignee&&a.status!=='failed'&&a.status!=='cancelled')
      .sort((a,b)=>run.tasks.filter(t=>t.reviewerId===a.agentId).length-run.tasks.filter(t=>t.reviewerId===b.agentId).length||a.agentId.localeCompare(b.agentId))[0]?.agentId;
    if(!reviewer||reviewer===binding.agentId||reviewer===assignee||!run.agents.some(a=>a.agentId===reviewer))throw new Error('reviewer_must_differ');
    const result=this.store.proposeTask({runId:binding.runId,intentId,turnId:binding.turnId,generation:binding.generation,authorId:binding.agentId,proposal:{title:input.title.trim(),objective:input.objective.trim(),criterionIds:input.criterionIds,parentTaskId:input.parentTaskId,contextRefs:input.contextRefs??[]},assigneeId:assignee,reviewerId:reviewer});
    this.wake(binding.runId,assignee);return result;
  }
  specialist(binding,intentId,input) {
    const profiles=['code-review','architecture','testing','product','performance','custom'];if(!str(input.name,80)||!profiles.includes(input.profile)||input.scope!=null&&!str(input.scope,1000)||input.budget!=null&&(!Number.isInteger(input.budget)||input.budget<1||input.budget>5))throw new Error('invalid_request');
    const parent=this.store.getAgent(binding.runId,binding.agentId);if(!parent)throw new Error('agent_not_found');
    const scope=[parent.scope,input.scope].filter(Boolean).join('\n--- narrower request ---\n');
    const result=this.store.addSpecialistForIntent({runId:binding.runId,intentId,turnId:binding.turnId,generation:binding.generation,actorId:binding.agentId,name:input.name.trim(),profile:input.profile,scope,budget:input.budget??2,runtime:this.runtimeForParent(binding.runId,binding.agentId)});
    this.wake(binding.runId,'orchestrator');return result;
  }
  async evidence(binding,intentId,input) {
    if(!['file','note','command_result','artifact'].includes(input.kind)||!str(input.label,240))throw new Error('unsupported_evidence');
    let record;
    if(input.kind==='artifact') {
      if(!str(input.uri,2048))throw new Error('invalid_request');
      const root=realpathSync(this.workspaceForRun(binding.runId)),candidate=realpathSync(resolve(root,input.uri)),rel=relative(root,candidate);
      if(rel==='..'||rel.startsWith(`..${sep}`)||resolve(candidate)===resolve(root)||!rel)throw new Error('invalid_scope');
      const stat=statSync(candidate);if(!stat.isFile())throw new Error('invalid_scope');if(stat.size>this.maxEvidenceBytes)throw new Error('file_too_large');
      const ext=extname(candidate).toLowerCase(),mime=({'.md':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8','.csv':'text/csv; charset=utf-8','.json':'application/json; charset=utf-8','.pdf':'application/pdf'}[ext]??'application/octet-stream');
      const bytes=readFileSync(candidate);
      return this.store.publishArtifact({runId:binding.runId,intentId,turnId:binding.turnId,generation:binding.generation,actorId:binding.agentId,name:basename(candidate),mime,bytes,label:input.label,relatedTaskId:input.relatedTaskId,claims:input.claims});
    }
    if(input.kind==='file') {
      if(!str(input.uri,2048))throw new Error('invalid_request');
      const root=realpathSync(this.workspaceForRun(binding.runId)),candidate=realpathSync(resolve(root,input.uri)),rel=relative(root,candidate);
      if(rel==='..'||rel.startsWith(`..${sep}`)||resolve(candidate)===resolve(root)||!rel)throw new Error('invalid_scope');
      const stat=statSync(candidate);if(!stat.isFile())throw new Error('invalid_scope');if(stat.size>this.maxEvidenceBytes)throw new Error('file_too_large');
      const sha256=await hashFile(candidate),excerpt=input.excerpt===true?(await (await import('node:fs/promises')).readFile(candidate,'utf8')).slice(0,4000):undefined;
      record={id:`evi_${intentId}`,kind:'file',label:input.label.trim(),uri:rel.split(sep).join('/'),...(excerpt?{excerpt}:{}),relatedTaskId:input.relatedTaskId,claims:Array.isArray(input.claims)?input.claims.slice(0,30):[],sha256,provenance:'supervisor_verified',verifiedAt:new Date().toISOString()};
    } else {
      if(!str(input.excerpt,12000))throw new Error('invalid_request');
      record={id:`evi_${intentId}`,kind:input.kind,label:input.label.trim(),excerpt:input.excerpt,relatedTaskId:input.relatedTaskId,claims:Array.isArray(input.claims)?input.claims.slice(0,30):[],sha256:null,provenance:'model_asserted',verifiedAt:null};
    }
    return this.store.recordEvidence({runId:binding.runId,intentId,turnId:binding.turnId,generation:binding.generation,record,actorId:binding.agentId});
  }
  progress(binding,intentId,input) {
    if(input.taskId) {
      if(!['submit','accept','reject'].includes(input.taskDecision)||!str(input.result,12000)||!Array.isArray(input.evidenceIds)||input.evidenceIds.length>40)throw new Error('invalid_request');
      const result=this.store.taskDecision({runId:binding.runId,intentId,turnId:binding.turnId,generation:binding.generation,actorId:binding.agentId,taskId:input.taskId,decision:input.taskDecision,result:input.result,evidenceIds:input.evidenceIds});
      const recipient=result.status==='review'?result.reviewerId:result.status==='ready'?this.store.getRun(binding.runId).tasks.find(t=>t.taskId===result.taskId)?.assigneeId:'orchestrator';
      if(recipient)this.wake(binding.runId,recipient);else this.wake(binding.runId,'orchestrator');
      return result;
    }
    if(!str(input.criterionId,160)||!Array.isArray(input.evidenceIds)||input.evidenceIds.length>40)throw new Error('invalid_request');
    const result=this.store.progress({runId:binding.runId,intentId,turnId:binding.turnId,generation:binding.generation,criterionId:input.criterionId,description:input.description,evidenceIds:input.evidenceIds});
    this.wake(binding.runId,'orchestrator');return result;
  }
  taskDecision(binding,intentId,input) {
    if(!str(input.taskId,160)||!['submit','accept','reject'].includes(input.decision)||input.result!=null&&!str(input.result,12000)||input.evidenceIds!=null&&(!Array.isArray(input.evidenceIds)||input.evidenceIds.length>40||input.evidenceIds.some(x=>!str(x,160))))throw new Error('invalid_request');
    const decision=this.store.taskDecision({runId:binding.runId,intentId,turnId:binding.turnId,generation:binding.generation,actorId:binding.agentId,taskId:input.taskId,decision:input.decision,result:input.result,evidenceIds:input.evidenceIds??[]});
    if(decision.status==='review')this.wake(binding.runId,decision.reviewerId);
    else if(decision.status==='ready'){const task=this.store.getRun(binding.runId)?.tasks.find(x=>x.taskId===input.taskId);if(task?.assigneeId)this.wake(binding.runId,task.assigneeId);}
    return decision;
  }
}
