import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCli, redact, classifyFailure } from './process.ts';

const workspace = fileURLToPath(new URL('./fixtures/', import.meta.url));
const userRoot = process.env.USERPROFILE ?? '';
const safe = text => {
  let clean = userRoot ? text.split(userRoot).join('[REDACTED_USER_HOME]') : text;
  clean = redact(clean).replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/[A-Z]:\\Users\\[^\\"']+/gi, '[REDACTED_USER_PATH]')
    .replace(/https?:\/\/[^\s"']+/gi, '[REDACTED_URL]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[REDACTED_ID]');
  return clean;
};
async function run(name, command, args, timeoutMs = 40_000, tempDir, schema = false) {
  const proc = spawnCli(command, args, workspace, {}, timeoutMs);
  const startedAt = performance.now(); const events = []; let deltas = 0; let final = false; let schemaAccepted = false; let reportedError;
  proc.onLine(line => {
    try {
      const event = JSON.parse(line); if (events.length < 12 && event.type) events.push({type:event.type,atMs:Math.round(performance.now()-startedAt)});
      if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') deltas++;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        final = true;
        try { schemaAccepted = JSON.parse(event.item.text).body === 'OK'; } catch { /* fixture reports shape only */ }
      }
      if (event.type === 'result' && typeof event.result === 'string') {
        try { schemaAccepted = JSON.parse(event.result).body === 'OK'; } catch { /* no result content is printed */ }
      }
      if (event.type === 'result' && event.is_error === true) reportedError = classifyFailure(String(event.error ?? event.result ?? ''), 1, false).error.code;
      if (event.type === 'turn.failed') reportedError = classifyFailure(JSON.stringify(event.error ?? {}), 1, false).error.code;
    } catch { /* diagnostics intentionally keep only recognized public event metadata */ }
  });
  proc.write(schema ? 'Reply with exactly the JSON object {"body":"OK"}. Do not use tools.' : 'Reply exactly OK. Do not use tools.'); proc.end();
  const result = await proc.outcome;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  const status = result.timedOut ? 'timeout_uncertain' : result.code === 0 ? 'exit_ok' : classifyFailure(result.stderr, result.code, false).error.code;
  const hint = status !== 'exit_ok' && result.stderr ? safe(result.stderr.split(/\r?\n/).find(Boolean) ?? '').slice(0, 180) : '';
  process.stdout.write(JSON.stringify({ name, status, exitCode: result.code, signal: result.signal, terminated: result.terminated, elapsedMs:Math.round(performance.now()-startedAt), events, textDeltaEvents: deltas, finalEvent: final, schemaAccepted, reportedError: reportedError ?? null, stderrHint: hint }) + '\n');
}

const configDir = await mkdtemp(join(tmpdir(), 'shao-claude-empty-mcp-'));
const mcpFile = join(configDir, 'mcp.json'); await writeFile(mcpFile, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
const selected = process.argv[2];
const claudeBase = ['--print','--verbose','--output-format','stream-json','--restricted','--permission-prompts','none','--strict-mcp-config','--mcp-config',mcpFile];
const schema = JSON.stringify({ type:'object',additionalProperties:false,properties:{body:{type:'string'}},required:['body'] });
if (selected === 'claude-production-preflight') {
  const dir = await mkdtemp(join(tmpdir(), 'shao-claude-mcp-preflight-'));
  const file = join(dir, 'config.json');
  const shim = fileURLToPath(new URL('../mcp/stdio.ts', import.meta.url));
  await writeFile(file, JSON.stringify({mcpServers:{shao:{command:process.execPath,args:['--experimental-strip-types',shim],env:{SHAO_MCP_ENDPOINT:'http://127.0.0.1:4317/internal/mcp/v1',SHAO_MCP_CAPABILITY:'diagnostic-placeholder-capability'}}}}), {mode:0o600});
  const args=['--print','--verbose','--output-format','stream-json','--include-partial-messages','--restricted','--permission-prompts','none','--strict-mcp-config','--json-schema',schema,'--tools','Read,Glob,Grep','--mcp-config',file];
  const proc=spawnCli('claude',args,workspace,{},8000,['diagnostic-placeholder-capability']);
  const startedAt=performance.now(); proc.end(); const result=await proc.outcome;
  const status=result.timedOut?'timeout':result.code===0?'exit_ok':classifyFailure(result.stderr,result.code,false).error.code;
  const hint=status!=='exit_ok'&&result.stderr?safe(result.stderr.split(/\r?\n/).find(Boolean)??'').slice(0,180):'';
  await rm(dir,{recursive:true,force:true}); await rm(configDir,{recursive:true,force:true});
  process.stdout.write(JSON.stringify({name:'claude-production-no-prompt',status,exitCode:result.code,elapsedMs:Math.round(performance.now()-startedAt),stderrHint:hint})+'\n');
  process.exit(0);
}
if (selected === 'claude') await run('claude-minimal', 'claude', [...claudeBase,'--tools',''], 40_000, configDir);
if (selected === 'claude-schema') await run('claude-schema', 'claude', [...claudeBase,'--json-schema',schema,'--tools',''], 40_000, configDir, true);
if (selected === 'codex') await run('codex-minimal', 'codex', ['--ask-for-approval','never','--cd',workspace,'exec','--json','--sandbox','read-only','--ignore-user-config','--ignore-rules','-'], 40_000);
if (selected === 'codex-schema') {
  const dir = await mkdtemp(join(tmpdir(), 'shao-codex-schema-')); const file = join(dir,'schema.json');
  await writeFile(file,schema,{mode:0o600});
  await run('codex-schema','codex',['--ask-for-approval','never','--cd',workspace,'exec','--json','--sandbox','read-only','--ignore-user-config','--ignore-rules','--output-schema',file,'-'],40_000,dir,true);
}
