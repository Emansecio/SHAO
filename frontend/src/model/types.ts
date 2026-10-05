// Modelo normalizado da UI. Alimentado pelo backend real (src/real) ou pela demo explícita (src/demo).
// Ids de participante seguem o contrato: "user", "orchestrator" ou o id persistido do agente.

export const USER = "user";
export const ORCH = "orchestrator";

export type ParticipantId = string;

/** Estado exibido de um agente (derivado de streaming/ação + status do backend). */
export type AgentStatus = "idle" | "queued" | "speaking" | "acting" | "waiting" | "paused" | "done" | "failed";

export interface Agent {
  id: string;
  name: string;
  role: string;
  engine: string; // runtime: claude-code, codex-cli, local
  parentId: string | null;
  hue: string;
  brief: string;
  dynamic?: boolean;
  costUsd?: number | null; // ausente = desconhecido
}

export type Tone = "brief" | "finding" | "counterpoint" | "agree" | "question" | "decision";

export interface Message {
  messageId: string;
  turnId: string;
  from: ParticipantId;
  recipients: ParticipantId[];
  channel: "chat" | "peer";
  text: string;
  format?: "text" | "markdown";
  tone?: Tone;
  replyTo?: string;
  evidenceIds: string[];
  seq: number;
  at: number; // epoch ms
  interrupted?: boolean;
  clientMessageId?: string; // eco do id gerado pelo cliente no POST
}

export interface Evidence {
  evidenceId: string;
  agentId: string;
  kind: string; // diff | lockfile | lab | note | file | command_result | artifact
  title: string;
  path: string;
  summary: string;
  body: string;
  provenance?: string;
  sha256?: string | null;
  claims?: string[];
  simulated?: boolean;
}

export interface Action {
  actionId: string;
  agentId: string;
  label: string;
  detail: string;
  evidenceIds: string[];
  ok?: boolean;
  simulated?: boolean;
}

export type CriterionState = "open" | "progress" | "met" | "blocked";

export interface Criterion {
  id: string;
  label: string;
  owner?: ParticipantId;
  state: CriterionState;
  note: string;
}

export interface Task {
  taskId: string;
  title: string;
  objective: string;
  status: string;
  assigneeId?: string;
  reviewerId?: string;
  result?: string;
  criterionIds: string[];
  submittedBy?: string; // quem entregou para revisão (encaminhamento automático do supervisor)
  decidedBy?: string; // ator que concluiu/decidiu (ex.: revisor distinto)
}

export interface Artifact {
  artifactId: string;
  agentId: string;
  name: string;
  mime: string;
  size: number;
}

export type IssueKind = "unavailable" | "quota" | "auth" | "error" | "stalled";

export interface Issue {
  id: string;
  kind: IssueKind;
  agentId?: string;
  runtime?: string;
  message: string;
  resetAt?: string;
  retryable?: boolean;
}

interface EventBase {
  eventId: string;
  seq: number;
  runId: string;
  at: number;
  turnId: string;
}

export type RunEvent = EventBase &
  (
    | { type: "agent.spawned"; agent: Agent; by: ParticipantId }
    | { type: "message.completed"; message: Message }
    | { type: "action.completed"; action: Action }
    | { type: "evidence.published"; evidence: Evidence }
    | { type: "criterion.updated"; criterion: Criterion }
    | { type: "task.updated"; task: Task; started: boolean }
    | { type: "artifact.published"; artifact: Artifact }
    | { type: "issue.raised"; issue: Issue }
    | { type: "run.status"; status: string; reason?: string }
    | { type: "report.updated"; revision: number; summary: string; afterTerminal?: boolean }
  );

export type RunEventInput = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, keyof EventBase>
    : never
  : never;

/** Mensagem em streaming: estado de UI, não entra no log até completar. */
export interface StreamingMessage {
  messageId: string;
  turnId: string;
  from: ParticipantId;
  recipients: ParticipantId[];
  channel: "chat" | "peer";
  text: string;
  tone?: Tone;
  replyTo?: string;
  evidenceIds: string[];
}
