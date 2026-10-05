/** Shared backend/runtime contract. No runtime dependencies. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const ACTOR = { user: 'user', orchestrator: 'orchestrator', supervisor: 'supervisor', system: 'system' } as const;
export type ActorKind = keyof typeof ACTOR | (string & {}); // Agent actors use their persisted agent id.
export type RunStatus = 'created' | 'running' | 'paused' | 'paused_quota' | 'paused_auth' | 'stalled' | 'failed' | 'completed' | 'cancelled';
export type AgentStatus = 'idle' | 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type TaskStatus = 'pending' | 'ready' | 'running' | 'review' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type CriterionStatus = 'pending' | 'in_progress' | 'covered' | 'accepted' | 'blocked';
export type RuntimeName = 'claude-code' | 'codex-cli' | 'local';
export type EventType = keyof EventPayloads;
export interface EventEnvelope<T = JsonValue> {
  id: string; seq: number; runId: string; type: string; ts: string;
  actorId: string; turnId: string | null; messageId: string | null;
  recipients: string[]; taskId: string | null; causation: string | null; payload: T;
}
export interface TypedEventEnvelope<K extends EventType> extends EventEnvelope<EventPayloads[K]> { type: K }
export type RunEvent = { [K in EventType]: TypedEventEnvelope<K> }[EventType];
export interface EventPayloads {
  'run.status': { status: RunStatus; reason?: string };
  'agent.spawned': { agentId: string; displayName: string; role: string; runtime: RuntimeName; parentId: string | null; profile: SpecialistProfile | null; dynamic: boolean };
  'agent.status': { agentId: string; status: AgentStatus; detail?: string };
  'message.delta': { delta: string };
  'message.completed': { body: string; format: 'text' | 'markdown'; inReplyTo?: string; clientMessageId?: string; contextRefs: string[]; evidenceIds: string[] };
  'action.started': { actionId: string; label: string; detail?: string; operationIntentId: string };
  'action.completed': { actionId: string; label: string; ok: boolean; detail?: string; evidenceIds: string[] };
  'task.started': TaskProposal & { taskId: string; status: 'running' };
  'task.status': { taskId: string; status: TaskStatus; result?: string; reviewerId?: string; submittedBy?: string };
  'task.completed': { taskId: string; status: Extract<TaskStatus, 'completed' | 'failed' | 'blocked'>; result?: string; reviewerId?: string };
  'evidence.published': EvidenceRecord;
  'artifact.published': { artifactId: string; name: string; mime: string; size: number };
  'criterion.status': { criterionId: string; description: string; status: CriterionStatus; evidenceIds: string[] };
  'report.updated': { revision: number; format: 'markdown'; summary: string };
  'runtime.unavailable': { agentId: string; runtime: RuntimeName; message: string };
  'runtime.quota': { agentId: string; runtime: RuntimeName; message: string; retryAfter?: string; resetAt?: string };
  'runtime.auth': { agentId: string; runtime: RuntimeName; message: string };
  error: { code: string; message: string; retryable: boolean };
  'turn.stalled': { agentId: string; turnId: string; reason: string; attempts: number };
}
export interface AgentMessage { body: string; format?: 'text' | 'markdown'; inReplyTo?: string; contextRefs?: string[]; clientMessageId: string }
export interface TaskProposal { title: string; objective: string; criterionIds: string[]; assigneeId?: string; reviewerId?: string; parentTaskId?: string; contextRefs?: string[] }
export interface EvidenceInput { kind: 'file' | 'note' | 'command_result' | 'artifact'; label: string; uri?: string; excerpt?: string; relatedTaskId?: string; claims?: string[] }
export interface EvidenceRecord extends EvidenceInput { id: string; sha256: string | null; provenance: 'supervisor_verified' | 'model_asserted' | 'user_supplied'; verifiedAt: string | null }
export type SpecialistProfile = 'code-review' | 'architecture' | 'testing' | 'product' | 'performance' | 'custom';
export interface SpecialistRequest { name: string; profile: SpecialistProfile; scope?: string; budget?: number }
export interface AdapterCapabilities { available: boolean; streaming: boolean; resume: boolean; cancel: boolean; tools: string[]; auth: 'ready' | 'missing' | 'unknown'; mode: string; reason?: string }
export interface RuntimeAvailability { runtime: RuntimeName; available: boolean; auth: 'ready' | 'missing' | 'unknown'; mode: string; reason?: string }
export interface HealthResponse { status: 'ok'; version: string; capabilities: RuntimeAvailability[] }
export interface AdapterStart { runId: string; agentId: string; turnId: string; generation: number; operationIntentId: string; prompt: string; context: JsonValue; resumeSessionId?: string; mcpEndpoint: string; mcpCapability: string; signal?: AbortSignal }
export type AdapterStreamItem = { kind: 'text'; text: string } | { kind: 'tool_call'; callId: string; name: string; input: JsonValue } | { kind: 'tool_result'; callId: string; output: JsonValue; isError?: boolean } | { kind: 'status'; status: string; detail?: string };
export interface AdapterOutcome { status: 'completed' | 'cancelled' | 'failed' | 'outcome_uncertain'; text?: string; sessionId?: string; error?: { code: string; message: string; retryable: boolean }; usage?: { inputTokens?: number; outputTokens?: number } }
/** Provider-facing JSON schema for the single public final response object. */
export const CLI_RESPONSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { body: { type: 'string' } }, required: ['body'],
} as const;
export interface CliResponse { body: string }
export interface RuntimeAdapter { capabilities(): Promise<AdapterCapabilities>; start(input: AdapterStart): Promise<{ stream: AsyncIterable<AdapterStreamItem>; outcome: Promise<AdapterOutcome> }>; cancel(runId: string, turnId: string, generation: number): Promise<void> }
export interface CreateRunRequest { prompt: string; workspace: string; criteria?: { id: string; description: string }[] }
export interface RunResponse { runId: string; status: RunStatus; createdAt: string; lastSeq: number }
export interface RunSummary extends RunResponse { title: string; workspace: string; updatedAt: string }
export interface RunProjection extends RunSummary { agents: AgentSummary[]; tasks: TaskSummary[]; criteria: { id: string; description: string; status: CriterionStatus; evidenceIds: string[] }[]; evidence: EvidenceRecord[] }
export interface AgentSummary { agentId: string; displayName: string; role: string; runtime: RuntimeName; parentId: string | null; profile: SpecialistProfile | null; dynamic: boolean; status: AgentStatus }
export interface TaskSummary extends TaskProposal { taskId: string; status: TaskStatus; result?: string; authorId: string; createdAt: string }
export interface AcceptedMessage { messageId: string; turnId: string | null; status: 'accepted'; clientMessageId: string }
export interface ControlResponse { runId: string; status: RunStatus }
export interface SpecialistResponse { agent: AgentSummary }
export interface ArtifactResponse { artifactId: string; name: string; mime: string; size: number; sha256: string; content?: string; downloadUrl: string }
export interface ExportResponse { runId: string; format: 'json' | 'markdown'; content: string }
export interface SseEvent<T = JsonValue> { id: string; event: string; data: EventEnvelope<T> }

/** Internal authenticated MCP broker transport. The token is per turn and never a user argument. */
export const BROKER_TOOLS = ['get_context','send','propose_task','request_specialist','evidence','report_progress','task_decision'] as const;
export type BrokerTool = typeof BROKER_TOOLS[number];
export interface BrokerRequest { tool: BrokerTool; operationKey: string; input: JsonValue }
export interface BrokerResponse { ok: boolean; result?: JsonValue; error?: { code: string; message: string; retryable: boolean } }
