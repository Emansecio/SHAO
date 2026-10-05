import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { BROKER_TOOLS, type BrokerRequest, type BrokerTool, type JsonValue } from '../../../shared/contracts.ts';
import { redact, redactDiagnostic } from '../runtime/process.ts';

const endpoint = process.env.SHAO_MCP_ENDPOINT;
const capability = process.env.SHAO_MCP_CAPABILITY;
const turnNamespace = capability ? createHash('sha256').update(capability).digest('hex').slice(0, 32) : '';
const tools = [
  ['get_context', 'Read team context and inbox messages for this turn.'],
  ['send', 'Send a message to a teammate; delivery is recorded in their inbox.'],
  ['propose_task', 'Propose a scoped task to the supervisor.'],
  ['request_specialist', 'Request a mission-scoped specialist from the supervisor.'],
  ['evidence', 'Publish a local evidence reference for review.'],
  ['report_progress', 'Report concise progress to the supervisor.'],
  ['task_decision', 'Submit an assigned task for review, accept reviewed work with verified evidence, or request changes.'],
] as const;
const annotations = {
  get_context: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  send: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  propose_task: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  request_specialist: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  evidence: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  report_progress: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  task_decision: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
} as const;
let initialized = false;

function send(message: unknown) { process.stdout.write(`${JSON.stringify(message)}\n`); }
const schemas: Record<string, JsonValue> = {
  get_context: { type: 'object', properties: {}, additionalProperties: false },
  send: { type: 'object', properties: { input: { type: 'object', properties: { recipients: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 }, body: { type: 'string', minLength: 1, maxLength: 12000 }, inReplyTo: { type: 'string' }, contextRefs: { type: 'array', items: { type: 'string' }, maxItems: 30 } }, required: ['recipients','body'], additionalProperties: false } }, required: ['input'], additionalProperties: false },
  propose_task: { type: 'object', properties: { input: { type: 'object', properties: { title: { type: 'string', maxLength: 160 }, objective: { type: 'string', maxLength: 4000 }, criterionIds: { type: 'array', items: { type: 'string' }, maxItems: 40 }, assigneeId: { type: 'string' }, reviewerId: { type: 'string' }, parentTaskId: { type: 'string' }, contextRefs: { type: 'array', items: { type: 'string' } }, }, required: ['title','objective','criterionIds'], additionalProperties: false } }, required: ['input'], additionalProperties: false },
  request_specialist: { type: 'object', properties: { input: { type: 'object', properties: { name: { type: 'string', maxLength: 80 }, profile: { type: 'string', enum: ['code-review','architecture','testing','product','performance','custom'] }, scope: { type: 'string', maxLength: 1000 }, budget: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['name','profile'], additionalProperties: false } }, required: ['input'], additionalProperties: false },
  evidence: { type: 'object', properties: { input: { type: 'object', properties: { kind: { type: 'string', enum: ['file','note','command_result','artifact'] }, label: { type: 'string', maxLength: 240 }, uri: { type: 'string', maxLength: 2048 }, excerpt: {}, relatedTaskId: { type: 'string' }, claims: { type: 'array', items: { type: 'string' }, maxItems: 30 } }, required: ['kind','label'], additionalProperties: false } }, required: ['input'], additionalProperties: false },
  report_progress: { type: 'object', properties: { input: { type: 'object', properties: { criterionId: { type: 'string' }, description: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 40 } }, required: ['criterionId','evidenceIds'], additionalProperties: false } }, required: ['input'], additionalProperties: false },
  task_decision: { type: 'object', properties: { input: { type: 'object', properties: { taskId: { type: 'string', minLength: 1, maxLength: 160 }, decision: { type: 'string', enum: ['submit','accept','reject'] }, result: { type: 'string', maxLength: 12000 }, evidenceIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 160 }, maxItems: 40 } }, required: ['taskId','decision'], additionalProperties: false } }, required: ['input'], additionalProperties: false },
};
function clean(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
  return value;
}
function codedError(code: string, message: string, retryable: boolean) {
  return Object.assign(new Error(message), { code, retryable });
}

async function callBroker(name: string, input: JsonValue, rpcId: string | number) {
  if (!endpoint || !capability) throw new Error('MCP broker capability is unavailable for this turn.');
  const target = new URL(endpoint);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(target.hostname)) throw new Error('MCP broker endpoint must be local loopback HTTP.');
  if (!(BROKER_TOOLS as readonly string[]).includes(name)) throw new Error('Unknown SHAO team tool.');
  // The capability is unique to one bound turn and private to this process.
  // Hash both ids so retries are stable while reused transport ids in later
  // turns cannot collide in the run-wide intent table.
  const requestNamespace = createHash('sha256').update(String(rpcId)).digest('hex').slice(0, 32);
  const req: BrokerRequest = { tool: name as BrokerTool, operationKey: `mcp:${turnNamespace}:${name}:${requestNamespace}`, input };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20_000); timer.unref?.();
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(`${endpoint.replace(/\/$/, '')}/${encodeURIComponent(name)}`, {
          method: 'POST', headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
          body: JSON.stringify(req), signal: controller.signal,
        });
        break;
      } catch (error) { if (attempt || controller.signal.aborted) throw error; }
    }
    if (!response) throw new Error('Broker response is unavailable.');
    const body = await response.json() as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string; retryable?: boolean } };
    if (!response.ok || body.ok !== true) {
      const code = typeof body.error?.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(body.error.code) ? body.error.code : 'broker_failure';
      const message = redactDiagnostic(body.error?.message ?? `Broker rejected request (${response.status}).`);
      throw codedError(code, message, body.error?.retryable === true);
    }
    return clean(body.result);
  } finally { clearTimeout(timer); }
}

async function handle(message: any) {
  const id = message?.id;
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  try {
    if (message.method === 'initialize') {
      initialized = true;
      send({ jsonrpc: '2.0', id, result: { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'shao-team-bridge', version: '1.0.0' } } });
    } else if (message.method === 'notifications/initialized') initialized = true;
    else if (message.method === 'ping') send({ jsonrpc: '2.0', id, result: {} });
    else if (message.method === 'tools/list') {
      if (!initialized) throw new Error('MCP initialize is required.');
      send({ jsonrpc: '2.0', id, result: { tools: tools.map(([name, description]) => ({ name, description, inputSchema: schemas[name], annotations: annotations[name] })) } });
    } else if (message.method === 'tools/call') {
      if (!initialized) throw new Error('MCP initialize is required.');
      const name = message.params?.name;
      if (!(BROKER_TOOLS as readonly string[]).includes(name)) throw new Error('Unknown SHAO team tool.');
      const args = message.params?.arguments;
      const input = name === 'get_context' ? {} : args?.input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool input must be an object.');
      if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).length || String(id).length > 120) throw new Error('Tool call requires a bounded JSON-RPC id.');
      const result = await callBroker(name, input as JsonValue, id);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result ?? null) }], structuredContent: result ?? null, isError: false } });
    } else if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } });
  } catch (error) {
    if (id !== undefined) {
      const candidate = error && typeof error === 'object' ? error as { code?: unknown; retryable?: unknown } : {};
      const code = typeof candidate.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(candidate.code) ? candidate.code : 'mcp_call_failed';
      const retryable = typeof candidate.retryable === 'boolean' ? ` (retryable=${candidate.retryable})` : '';
      const message = redactDiagnostic(error instanceof Error ? error.message : 'Broker call failed.');
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${code}${retryable}: ${message}` }], isError: true } });
    }
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => { let message: unknown; try { message = JSON.parse(line); } catch { return; } void handle(message); });
input.on('close', () => process.exit(0));
