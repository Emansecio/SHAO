import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CliAdapter } from './adapters.ts';
import { childEnv, classifyFailure, parseJsonLine, redact } from './process.ts';
import { BROKER_TOOLS } from '../../../shared/contracts.ts';

const fixture = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const make = (provider = 'claude-code', extra = {}) => new CliAdapter(provider, { command: process.execPath, argsPrefix: [fixture], environment: { TEST_AUTH: 'ready', ANTHROPIC_API_KEY: 'sk-should-never-be-passed', OPENAI_API_KEY: 'sk-should-never-be-passed', ...extra }, timeoutMs: 4000 });
const startInput = (context = {}) => ({ runId: 'run-a', agentId: 'agent-a', turnId: 'turn-a', generation: 1, operationIntentId: 'op-a', prompt: 'Read fixture and summarize.', context: { workspace: process.cwd(), ...context }, mcpEndpoint: 'http://127.0.0.1:4317/internal/mcp/v1', mcpCapability: 'opaque-test-capability' });

test('environment filtering and redaction remove API auth material', () => {
  assert.equal(childEnv({ OPENAI_API_KEY: 'sk-private', okay: 'x' }, { ANTHROPIC_API_KEY: 'sk-private', SAFE: 'y' }).OPENAI_API_KEY, undefined);
  assert.equal(childEnv({ OPENAI_API_KEY: 'sk-private' }, { SAFE: 'y' }).SAFE, 'y');
  const sanitized = childEnv({ TYPESAFE_API_KEY:'secret', AO_BROWSER_RUNTIME_TOKEN:'secret', CODEX_SESSION_ID:'nested', CODEX_THREAD_ID:'nested', CLAUDECODE:'nested', PATH:'safe' });
  assert.equal(sanitized.TYPESAFE_API_KEY, undefined); assert.equal(sanitized.AO_BROWSER_RUNTIME_TOKEN, undefined);
  assert.equal(sanitized.CODEX_SESSION_ID, undefined); assert.equal(sanitized.CODEX_THREAD_ID, undefined); assert.equal(sanitized.CLAUDECODE, undefined); assert.ok(sanitized.PATH);
  assert.match(redact('Bearer eyJsecret sk-abcdefghijk'), /\[REDACTED_SECRET\]/);
  assert.equal(parseJsonLine('{bad'), undefined);
  assert.equal(classifyFailure('Unknown provider failure', 1, false).error.code, 'runtime_exit_1');
  assert.equal(classifyFailure('', null, true).status, 'outcome_uncertain');
});

test('Claude adapter authenticates without exposing status fields and normalizes stream/session', async () => {
  const adapter = make();
  assert.equal((await adapter.capabilities()).auth, 'ready');
  const result = await adapter.start(startInput({ fixture }));
  const streamed = []; for await (const item of result.stream) streamed.push(item);
  const outcome = await result.outcome;
  assert.equal(outcome.status, 'completed'); assert.equal(outcome.sessionId, 'fixture-session');
  assert.match(outcome.text, /apiKeyAbsent=true/); assert.equal(streamed.some(x => x.kind === 'text'), true);
});

test('Claude production MCP allowlist includes task decision tool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shao-claude-argv-'));
  const argvFile = join(directory, 'argv.json');
  try {
    const adapter = make('claude-code', { TEST_MODE:'capture-argv', TEST_ARGV_FILE:argvFile });
    const result = await adapter.start(startInput());
    for await (const _ of result.stream) { /* consume */ }
    assert.equal((await result.outcome).status, 'completed');
    const args = JSON.parse(await readFile(argvFile, 'utf8'));
    assert.ok(args.includes('--allowedTools'));
    assert.ok(args.includes('mcp__shao__task_decision'));
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('Codex invocation forwards only private SHAO MCP env names without changing read-only approval settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shao-codex-argv-'));
  const argvFile = join(directory, 'argv.json');
  try {
    const adapter = make('codex-cli', { TEST_MODE:'capture-argv', TEST_ARGV_FILE:argvFile });
    const result = await adapter.start(startInput());
    for await (const _ of result.stream) { /* consume */ }
    assert.equal((await result.outcome).status, 'completed');
    const args = JSON.parse(await readFile(argvFile, 'utf8'));
    assert.ok(args.includes('--sandbox') && args[args.indexOf('--sandbox') + 1] === 'read-only');
    assert.ok(args.includes('--ask-for-approval') && args[args.indexOf('--ask-for-approval') + 1] === 'never');
    const allowlist = args.find(value => value.startsWith('mcp_servers.shao.enabled_tools='));
    assert.ok(allowlist);
    assert.deepEqual(JSON.parse(allowlist.slice(allowlist.indexOf('=') + 1)), [...BROKER_TOOLS]);
    const envVars = args.find(value => value.startsWith('mcp_servers.shao.env_vars='));
    assert.ok(envVars);
    assert.deepEqual(JSON.parse(envVars.slice(envVars.indexOf('=') + 1)), ['SHAO_MCP_ENDPOINT','SHAO_MCP_CAPABILITY']);
    assert.ok(!args.some(value => value.includes(startInput().mcpCapability) || value.includes(startInput().mcpEndpoint)));
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('Codex configured env_vars pass the per-turn capability through the real stdio shim to loopback HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shao-codex-mcp-env-'));
  const argvFile = join(directory, 'argv.json');
  const received = [];
  const server = createServer(async (req, res) => {
    let body=''; for await (const chunk of req) body += chunk;
    received.push({path:req.url,authorization:req.headers.authorization,body:JSON.parse(body)});
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:true,result:{snapshot:{prompt:'fixture turn'},inbox:[],contextRefs:[]}}));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); const capability='turn-local-secret-capability';
  try {
    const adapter=make('codex-cli',{TEST_MODE:'codex-mcp-forward',TEST_ARGV_FILE:argvFile,TEST_MCP_SHIM:fileURLToPath(new URL('../mcp/stdio.ts',import.meta.url))});
    const input={...startInput(),mcpEndpoint:`http://127.0.0.1:${address.port}/internal/mcp/v1`,mcpCapability:capability};
    const result=await adapter.start(input); const items=[]; for await(const item of result.stream) items.push(item);
    const outcome=await result.outcome;
    assert.equal(outcome.status,'completed');
    assert.equal(received.length,1);
    assert.equal(received[0].path,'/internal/mcp/v1/get_context');
    assert.equal(received[0].authorization,`Bearer ${capability}`);
    assert.equal(received[0].body.tool,'get_context');
    assert.ok(items.some(item=>item.kind==='tool_result'&&!item.isError));
    const args=JSON.parse(await readFile(argvFile,'utf8'));
    const envVars=args.find(value=>value.startsWith('mcp_servers.shao.env_vars='));
    assert.deepEqual(JSON.parse(envVars.slice(envVars.indexOf('=')+1)),['SHAO_MCP_ENDPOINT','SHAO_MCP_CAPABILITY']);
    assert.ok(!args.some(value=>value.includes(capability)||value.includes(input.mcpEndpoint)));
  } finally { await new Promise(resolve=>server.close(resolve)); await rm(directory,{recursive:true,force:true}); }
});

test('Codex adapter uses observed JSON/read-only CLI path and session id', async () => {
  const adapter = make('codex-cli');
  assert.equal((await adapter.capabilities()).auth, 'ready');
  const result = await adapter.start(startInput({ fixture }));
  for await (const _ of result.stream) { /* consume */ }
  const outcome = await result.outcome;
  assert.equal(outcome.status, 'completed'); assert.equal(outcome.sessionId, 'fixture-thread');
  assert.match(outcome.text, /apiKeyAbsent=true/);
});

test('session ids are persisted early with the fenced run, turn and generation', async () => {
  let saved;
  const adapter = new CliAdapter('claude-code', { command: process.execPath, argsPrefix:[fixture], environment:{ TEST_AUTH:'ready' }, timeoutMs:4000,
    persistSession: async (input, provider, sessionId) => { saved = { runId:input.runId, turnId:input.turnId, generation:input.generation, provider, sessionId }; return true; } });
  const result = await adapter.start(startInput({ fixture })); for await (const _ of result.stream) { /* consume */ }
  assert.equal((await result.outcome).status, 'completed');
  assert.deepEqual(saved, { runId:'run-a', turnId:'turn-a', generation:1, provider:'claude-code', sessionId:'fixture-session' });
});

test('production invocations send one prompt source (Claude stdin, Codex stdin sentinel)', async () => {
  for (const provider of ['claude-code','codex-cli']) {
    const result = await make(provider, {TEST_MODE:'capture-prompt'}).start(startInput({fixture}));
    for await (const _ of result.stream) { /* consume */ }
    assert.equal((await result.outcome).text, `stdinPrompt=true;positionalPrompt=false;stdinSentinel=${provider==='codex-cli'}`);
  }
});

test('CLI public tool calls/results, statuses, usage and text normalize to shared events', async () => {
  for (const provider of ['claude-code','codex-cli']) {
    const adapter = make(provider, { TEST_MODE:'tool-events' });
    const result = await adapter.start(startInput({ fixture })); const items=[];
    for await (const item of result.stream) items.push(item);
    const outcome = await result.outcome;
    assert.equal(outcome.status,'completed'); assert.equal(outcome.usage.inputTokens,provider==='claude-code'?10:12);
    assert.ok(items.some(x=>x.kind==='tool_call'&&x.callId==='call-1'));
    assert.ok(items.some(x=>x.kind==='tool_result'&&x.callId==='call-1'));
    assert.ok(items.some(x=>x.kind==='status'));
  }
});

test('malformed CLI output is not accepted as a successful turn', async () => {
  const adapter = make('claude-code', { TEST_MODE: 'malformed' });
  const result = await adapter.start(startInput({ fixture }));
  for await (const _ of result.stream) { /* consume */ }
  assert.equal((await result.outcome).error.code, 'runtime_malformed_output');
});

test('only confirmed auth and quota signals are classified; other failures stay generic', async () => {
  for (const [mode, code] of [['auth','runtime_auth'],['quota','runtime_quota'],['unknown','runtime_exit_2']]) {
    const result = await make('claude-code', { TEST_MODE: mode }).start(startInput({ fixture }));
    for await (const _ of result.stream) { /* consume */ }
    assert.equal((await result.outcome).error.code, code);
  }
});

test('failed CLI outcome retains a bounded diagnostic with credentials, email and user path redacted', async () => {
  const result = await make('claude-code', {TEST_MODE:'diagnostic'}).start(startInput({fixture}));
  for await (const _ of result.stream) { /* drain */ }
  const outcome=await result.outcome;
  assert.equal(outcome.status,'failed'); assert.equal(outcome.error.code,'runtime_cli_arguments');
  assert.match(outcome.error.message,/stderr=Error: Unknown argument/); assert.match(outcome.error.message,/exit=1/);
  assert.doesNotMatch(outcome.error.message,/test@example|Sample User|abcdefghijklmnopqrstuvwx1234567890/);
  assert.match(outcome.error.message,/REDACTED_(?:EMAIL|PATH|SECRET)/);
});

test('CLI timeout returns outcome_uncertain and cancellation stops the child', async () => {
  const timed = new CliAdapter('claude-code', { command: process.execPath, argsPrefix:[fixture], environment:{ TEST_AUTH:'ready', TEST_MODE:'hang' }, timeoutMs:100 });
  const result = await timed.start(startInput({ fixture })); for await (const _ of result.stream) { /* consume */ }
  assert.equal((await result.outcome).status, 'outcome_uncertain');

  const controller = new AbortController();
  const cancel = new CliAdapter('claude-code', { command: process.execPath, argsPrefix:[fixture], environment:{ TEST_AUTH:'ready', TEST_MODE:'hang' }, timeoutMs:5000 });
  const turn = await cancel.start({ ...startInput({ fixture }), signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  for await (const _ of turn.stream) { /* consume */ }
  assert.equal((await turn.outcome).status, 'cancelled');
});

test('Windows cancellation confirms the CLI child process tree has exited', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shao-cli-tree-'));
  const pidFile = join(dir, 'child.pid'); const controller = new AbortController();
  try {
    const adapter = new CliAdapter('claude-code', { command:process.execPath, argsPrefix:[fixture], environment:{TEST_AUTH:'ready',TEST_MODE:'spawn-child',TEST_CHILD_PID_FILE:pidFile}, timeoutMs:5000 });
    const turn = await adapter.start({...startInput({fixture}),signal:controller.signal});
    const deadline=Date.now()+2000;
    while(Date.now()<deadline){try{await readFile(pidFile,'utf8');break;}catch{await new Promise(resolve=>setTimeout(resolve,20));}}
    const childPid=Number((await readFile(pidFile,'utf8')).trim()); assert.ok(Number.isInteger(childPid)&&childPid>0);
    controller.abort(); for await(const _ of turn.stream) { /* drain until process close is confirmed */ }
    assert.equal((await turn.outcome).status,'cancelled');
    let alive=true; try{process.kill(childPid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
    assert.equal(alive,false,'descendant process remained after Windows taskkill tree termination');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
