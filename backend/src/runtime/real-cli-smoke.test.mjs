import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { claudeCodeAdapter, codexCliAdapter } from './adapters.ts';
import cliFinalSchema from '../../../shared/schemas/cli-final.schema.json' with { type: 'json' };

const enabled = process.env.SHAO_RUN_REAL_CLI_SMOKE === '1';
const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureWorkspace = fileURLToPath(new URL('./fixtures/', import.meta.url));
const context = { workspace, fixture: 'backend/src/runtime/fixtures/smoke.txt' };
const smoke = async (name, adapter) => {
  const available = await adapter.capabilities();
  assert.equal(available.available, true, `${name} login/auth preflight must be ready`);
  const run = await adapter.start({ runId: `smoke-${name}`, agentId: 'smoke-agent', turnId: 'smoke-turn', generation: 1, operationIntentId: `smoke-op-${name}`, prompt: 'Read context.fixture as a local text file. Return the exact marker from it. Do not edit, create, or execute files or commands.', context, mcpEndpoint: '', mcpCapability: '' });
  for await (const _ of run.stream) { /* consume without recording provider output */ }
  const result = await run.outcome;
  assert.equal(result.status, 'completed', `${name} failed with ${result.error?.code ?? result.status}`);
  assert.match(result.text, /SHAO_SAFE_SMOKE/);
  assert.ok(result.sessionId, `${name} must provide a resumable session id`);
};

test('official Claude Code CLI real local read-only smoke', { skip: !enabled }, () => smoke('claude-code', claudeCodeAdapter({timeoutMs:40_000})));
test('official Codex CLI real local read-only smoke', { skip: !enabled }, () => smoke('codex-cli', codexCliAdapter({timeoutMs:40_000})));

function assertSchema(value, schema, path = '$') {
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} is outside enum`);
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path} must be object`);
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    if (schema.additionalProperties === false) assert.deepEqual(Object.keys(value).filter(key => !Object.hasOwn(schema.properties ?? {}, key)), [], `${path} has extra fields`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) assertSchema(value[key], child, `${path}.${key}`);
  } else if (schema.type === 'string') assert.equal(typeof value, 'string', `${path} must be string`);
  else if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${path} must be boolean`);
  else if (schema.type === 'integer') { assert.ok(Number.isInteger(value), `${path} must be integer`); if (schema.minimum != null) assert.ok(value >= schema.minimum, `${path} is below minimum`); }
}

test('production Claude AdapterStart accepts shared outcome schema and makes a real MCP call', { skip: process.env.SHAO_RUN_REAL_ADAPTER_MCP_SMOKE !== '1' }, async () => {
  const capability = randomUUID(); const received = []; let persisted;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ path:req.url, authorization:req.headers.authorization, body:JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'content-type':'application/json' });
    res.end(JSON.stringify({ ok:true, result:{ snapshot:{prompt:'benign MCP adapter fixture'}, workspace, evidence:[] } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address();
    const adapter = claudeCodeAdapter({timeoutMs:45_000,persistSession:async(input,provider,sessionId)=>{persisted={runId:input.runId,turnId:input.turnId,generation:input.generation,provider,sessionId};return true;}});
    const run = await adapter.start({
      runId:'real-adapter-smoke',agentId:'orchestrator',turnId:'real-adapter-turn',generation:1,operationIntentId:'real-adapter-intent',
      prompt:'Use the SHAO team get_context tool exactly once, then return only the marker MCP_BRIDGE_USED. Do not edit files or call other tools.',
      context:{workspace:fixtureWorkspace,fixture:'smoke.txt'},
      mcpEndpoint:`http://127.0.0.1:${address.port}/internal/mcp/v1`,mcpCapability:capability,
    });
    const items=[]; for await (const item of run.stream) items.push(item);
    const outcome=await run.outcome;
    assertSchema(outcome,cliFinalSchema);
    assert.equal(outcome.status,'completed',`${outcome.error?.code}: ${outcome.error?.message}`);
    assert.equal(outcome.text,'MCP_BRIDGE_USED');
    assert.equal(received.length,1); assert.equal(received[0].path,'/internal/mcp/v1/get_context');
    assert.equal(received[0].authorization,`Bearer ${capability}`); assert.equal(received[0].body.tool,'get_context');
    assert.ok(received[0].body.operationKey); assert.ok(items.some(item=>item.kind==='tool_call'));
    assert.ok(persisted); assert.equal(persisted.provider,'claude-code'); assert.equal(persisted.sessionId,outcome.sessionId);
    process.stdout.write(JSON.stringify({mcpToolsListAndCall:'one get_context call accepted by loopback fixture',outcomeSchema:'shared cli-final.schema accepted',sessionIdObserved:true,sessionIdUuid:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(outcome.sessionId??''),toolCallObserved:items.some(item=>item.kind==='tool_call')})+'\n');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
