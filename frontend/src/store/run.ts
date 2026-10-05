import { create } from "zustand";
import {
  ORCH,
  type Agent,
  type AgentStatus,
  type Artifact,
  type Criterion,
  type Evidence,
  type Issue,
  type Message,
  type RunEvent,
  type RunEventInput,
  type StreamingMessage,
  type Task,
} from "@/model/types";

export type View = "conversa" | "conselho" | "relatorio";
export type TimelineFilter = "all" | "message" | "action" | "evidence";
export type Mode = "real" | "demo";
export type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "closed" | "error";

export interface PendingHuman {
  localId: string; // = clientMessageId enviado no POST (estável entre tentativas)
  text: string;
  messageId?: string;
  error?: string;
}

export interface RunMeta {
  runId: string;
  title: string;
  workspace: string;
  createdAt: string;
}

interface RunState {
  mode: Mode;
  meta: RunMeta | null;
  seq: number;
  lastEnvelopeSeq: number; // último seq do backend aplicado (real)
  clock: number; // demo: ms de simulação
  paused: boolean; // demo: gerador congelado
  idle: boolean; // demo: roteiro esgotado
  runStatus: string; // contrato RunStatus no modo real
  runReason?: string;
  stream: { state: StreamState; detail?: string };
  events: RunEvent[];
  pairCounts: Record<string, number>; // "from>to" -> mensagens completas (arestas do grafo)
  lineage: { by: string; id: string }[]; // quem criou quem
  agents: Record<string, Agent>;
  agentOrder: string[];
  backendStatus: Record<string, string>; // agentId -> AgentStatus do contrato
  messages: Record<string, Message>;
  evidence: Record<string, Evidence>;
  criteria: Criterion[];
  tasks: Record<string, Task>;
  artifacts: Record<string, Artifact>;
  issues: Issue[];
  report: { revision: number; summary: string } | null;
  streaming: Record<string, StreamingMessage>;
  acting: Record<string, string>;
  awaitingReply: string | null; // turnId do humano aguardando resposta
  pendingHuman: PendingHuman[]; // mensagens enviadas ainda não confirmadas pelo stream
  replaying: boolean;

  view: View;
  selectedAgent: string | null;
  panelOpen: boolean;
  openEvidence: string | null;
  openArtifact: string | null;
  timelineFilter: TimelineFilter;
  agentFilter: string | null;
  navOpen: boolean;
}

interface RunActions {
  emit: (input: RunEventInput, meta?: { turnId?: string; at?: number; eventId?: string; seq?: number }) => void;
  setClock: (clock: number) => void;
  setPaused: (paused: boolean) => void;
  setIdle: (idle: boolean) => void;
  streamStart: (msg: StreamingMessage) => void;
  streamDelta: (messageId: string, text: string) => void;
  streamEnd: (messageId: string) => void;
  setActing: (agentId: string, label: string | null) => void;
  setAwaitingReply: (turnId: string | null) => void;
  setBackendStatus: (agentId: string, status: string) => void;
  setStream: (state: StreamState, detail?: string) => void;
  setLastEnvelopeSeq: (seq: number) => void;
  dismissIssue: (id: string) => void;
  setPendingHuman: (fn: (p: PendingHuman[]) => PendingHuman[]) => void;
  setRunStatus: (status: string) => void;
  setReplaying: (replaying: boolean) => void;
  /** Começa um run limpo (novo, replay ou troca de modo). */
  load: (mode: Mode, meta: RunMeta | null, criteria?: Criterion[]) => void;

  setView: (view: View) => void;
  selectAgent: (id: string | null) => void;
  setPanelOpen: (open: boolean) => void;
  setOpenEvidence: (id: string | null) => void;
  setOpenArtifact: (id: string | null) => void;
  setTimelineFilter: (f: TimelineFilter) => void;
  setAgentFilter: (id: string | null) => void;
  setNavOpen: (open: boolean) => void;
}

const freshRun = (mode: Mode, meta: RunMeta | null, criteria: Criterion[] = []) => ({
  mode,
  meta,
  seq: 0,
  lastEnvelopeSeq: 0,
  clock: 0,
  paused: false,
  idle: false,
  runStatus: mode === "demo" ? "running" : "created",
  runReason: undefined as string | undefined,
  stream: { state: "idle" as StreamState },
  events: [] as RunEvent[],
  pairCounts: {} as Record<string, number>,
  lineage: [] as { by: string; id: string }[],
  agents: {} as Record<string, Agent>,
  agentOrder: [] as string[],
  backendStatus: {} as Record<string, string>,
  messages: {} as Record<string, Message>,
  evidence: {} as Record<string, Evidence>,
  criteria,
  tasks: {} as Record<string, Task>,
  artifacts: {} as Record<string, Artifact>,
  issues: [] as Issue[],
  report: null as RunState["report"],
  streaming: {} as Record<string, StreamingMessage>,
  acting: {} as Record<string, string>,
  awaitingReply: null as string | null,
  pendingHuman: [] as PendingHuman[],
  replaying: false,
});

export const useRun = create<RunState & RunActions>()((set) => ({
  ...freshRun("real", null),
  view: "conversa",
  selectedAgent: null,
  panelOpen: false,
  openEvidence: null,
  openArtifact: null,
  timelineFilter: "all",
  agentFilter: null,
  navOpen: false,

  emit: (input, m = {}) =>
    set((s) => {
      const seq = m.seq ?? s.seq + 1;
      const runId = s.meta?.runId ?? "demo";
      const event = { ...input, eventId: m.eventId ?? `${runId}:e${seq}`, seq, runId, at: m.at ?? Date.now(), turnId: m.turnId ?? "turn-0" } as RunEvent;
      const next: Partial<RunState> = { seq: Math.max(s.seq, seq), events: [...s.events, event] };
      switch (event.type) {
        case "agent.spawned":
          next.agents = { ...s.agents, [event.agent.id]: event.agent };
          if (!s.agentOrder.includes(event.agent.id)) {
            next.agentOrder = [...s.agentOrder, event.agent.id];
            next.lineage = [...s.lineage, { by: event.by, id: event.agent.id }];
          }
          break;
        case "message.completed": {
          next.messages = { ...s.messages, [event.message.messageId]: event.message };
          const pc = { ...s.pairCounts };
          for (const r of event.message.recipients) pc[`${event.message.from}>${r}`] = (pc[`${event.message.from}>${r}`] ?? 0) + 1;
          next.pairCounts = pc;
          {
            // reconciliação exata: clientMessageId ecoado ou messageId do 202; nunca por texto
            const { messageId, clientMessageId } = event.message;
            const done = (p: PendingHuman) => p.messageId === messageId || (!!clientMessageId && p.localId === clientMessageId);
            if (s.pendingHuman.some(done)) next.pendingHuman = s.pendingHuman.filter((p) => !done(p));
          }
          break;
        }
        case "evidence.published":
          next.evidence = { ...s.evidence, [event.evidence.evidenceId]: event.evidence };
          break;
        case "criterion.updated": {
          const exists = s.criteria.some((c) => c.id === event.criterion.id);
          next.criteria = exists ? s.criteria.map((c) => (c.id === event.criterion.id ? event.criterion : c)) : [...s.criteria, event.criterion];
          break;
        }
        case "task.updated":
          next.tasks = { ...s.tasks, [event.task.taskId]: { ...s.tasks[event.task.taskId], ...event.task } };
          break;
        case "artifact.published":
          next.artifacts = { ...s.artifacts, [event.artifact.artifactId]: event.artifact };
          break;
        case "issue.raised":
          next.issues = [...s.issues.filter((i) => i.id !== event.issue.id), event.issue];
          break;
        case "run.status":
          next.runStatus = event.status;
          next.runReason = event.reason;
          // ao retomar, problemas de quota/auth anteriores deixam de ser o estado atual
          if (event.status === "running") next.issues = s.issues.filter((i) => i.kind === "error");
          break;
        case "report.updated":
          next.report = { revision: event.revision, summary: event.summary };
          break;
      }
      return next;
    }),
  setClock: (clock) => set({ clock }),
  setPaused: (paused) => set({ paused }),
  setIdle: (idle) => set({ idle }),
  streamStart: (msg) => set((s) => ({ streaming: { ...s.streaming, [msg.messageId]: msg } })),
  streamDelta: (messageId, text) =>
    set((s) => {
      const cur = s.streaming[messageId];
      return cur ? { streaming: { ...s.streaming, [messageId]: { ...cur, text } } } : {};
    }),
  streamEnd: (messageId) =>
    set((s) => {
      if (!s.streaming[messageId]) return {};
      const { [messageId]: _, ...rest } = s.streaming;
      return { streaming: rest };
    }),
  setActing: (agentId, label) =>
    set((s) => {
      const acting = { ...s.acting };
      if (label) acting[agentId] = label;
      else delete acting[agentId];
      return { acting };
    }),
  setAwaitingReply: (awaitingReply) => set({ awaitingReply }),
  setBackendStatus: (agentId, status) => set((s) => ({ backendStatus: { ...s.backendStatus, [agentId]: status } })),
  setStream: (state, detail) => set({ stream: { state, detail } }),
  setLastEnvelopeSeq: (lastEnvelopeSeq) => set({ lastEnvelopeSeq }),
  dismissIssue: (id) => set((s) => ({ issues: s.issues.filter((i) => i.id !== id) })),
  setPendingHuman: (fn) => set((s) => ({ pendingHuman: fn(s.pendingHuman) })),
  setRunStatus: (runStatus) => set({ runStatus }),
  setReplaying: (replaying) => set({ replaying }),
  load: (mode, meta, criteria) =>
    set((s) => ({ ...freshRun(mode, meta, criteria), selectedAgent: null, panelOpen: false, openEvidence: null, openArtifact: null, agentFilter: null, timelineFilter: "all", view: s.view })),

  setView: (view) => set({ view }),
  selectAgent: (id) => set({ selectedAgent: id, panelOpen: id !== null }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setOpenEvidence: (openEvidence) => set({ openEvidence }),
  setOpenArtifact: (openArtifact) => set({ openArtifact }),
  setTimelineFilter: (timelineFilter) => set({ timelineFilter }),
  setAgentFilter: (agentFilter) => set({ agentFilter }),
  setNavOpen: (navOpen) => set({ navOpen }),
}));

export type RunStore = RunState & RunActions;

// ----- seletores -----

const BACKEND_STATUS: Record<string, AgentStatus> = {
  idle: "idle",
  queued: "queued",
  running: "acting",
  waiting: "waiting",
  paused: "paused",
  completed: "done",
  failed: "failed",
  cancelled: "done",
};

export function selectStatus(s: RunState, agentId: string): AgentStatus {
  if (Object.values(s.streaming).some((m) => m.from === agentId)) return "speaking";
  if (s.acting[agentId]) return "acting";
  if (s.mode === "demo") return agentId === ORCH && s.idle ? "waiting" : "idle";
  return BACKEND_STATUS[s.backendStatus[agentId]] ?? "idle";
}

/** Chave estável dos pares em trânsito: muda só quando a topologia ativa muda, não a cada token. */
export function selectActivePairs(s: RunState): string {
  return Object.values(s.streaming)
    .flatMap((m) => m.recipients.map((r) => `${m.from}>${r}`))
    .sort()
    .join("|");
}

export function selectMetCount(s: RunState) {
  return s.criteria.filter((c) => c.state === "met").length;
}

/** O run aceita controle e mensagens? (estados terminais não) */
export function isTerminal(status: string) {
  return status === "completed" || status === "cancelled" || status === "failed";
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "disponível",
  queued: "na fila",
  speaking: "falando",
  acting: "em ação",
  waiting: "aguardando",
  paused: "pausado",
  done: "concluído",
  failed: "falhou",
};

export const RUN_STATUS_LABEL: Record<string, string> = {
  created: "criado",
  running: "em andamento",
  paused: "pausado",
  paused_quota: "pausado · quota",
  paused_auth: "pausado · autenticação",
  stalled: "travado",
  failed: "falhou",
  completed: "concluído",
  cancelled: "cancelado",
};

// Um formatador só (criar Intl a cada chamada custava >1 s/12 s sob carga) + cache por segundo.
const TIME_FMT = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const timeCache = new Map<number, string>();
export function clockLabel(at: number) {
  const sec = Math.floor(at / 1000);
  let label = timeCache.get(sec);
  if (label === undefined) {
    if (timeCache.size > 2000) timeCache.clear();
    label = TIME_FMT.format(at);
    timeCache.set(sec, label);
  }
  return label;
}
