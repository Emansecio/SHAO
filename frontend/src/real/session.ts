// Sessão real: traduz envelopes do contrato (D:/SHAO/shared) para o store da UI.
// O backend é a fonte da verdade; a UI nunca gera falas de agente neste modo.
import type { CriterionStatus, EventEnvelope, RunEvent as WireEvent, SpecialistProfile } from "../../../shared/contracts";
import { api, ApiError } from "@/api/client";
import { openRunStream } from "@/api/sse";
import { ORCH, USER, type Agent, type CriterionState } from "@/model/types";
import { isTerminal, useRun, type RunMeta } from "@/store/run";

const PALETTE = ["#8fd3b6", "#9db0f5", "#eba98c", "#c4a9ef", "#7fcfe0", "#d6d985", "#e7a3c4", "#a8d58f"];
const ORCH_HUE = "#dcc59a";

const CRITERION: Record<CriterionStatus, CriterionState> = {
  pending: "open",
  in_progress: "progress",
  covered: "met",
  accepted: "met",
  blocked: "blocked",
};
const CRITERION_NOTE: Record<CriterionStatus, string> = {
  pending: "pendente",
  in_progress: "em andamento",
  covered: "coberto",
  accepted: "aceito",
  blocked: "bloqueado",
};

const ROLE_FALLBACK: Record<string, string> = { orchestrator: "Coordenação", supervisor: "Supervisor", system: "Sistema" };

function hueFor(id: string) {
  if (id === ORCH) return ORCH_HUE;
  const known = useRun.getState().agentOrder.filter((a) => a !== ORCH).indexOf(id);
  const i = known === -1 ? useRun.getState().agentOrder.filter((a) => a !== ORCH).length : known;
  return PALETTE[i % PALETTE.length];
}

/** Participante citado antes de existir no grafo (p.ex. orquestrador sem agent.spawned). */
function ensureParticipant(id: string, env: EnvHead) {
  const s = useRun.getState();
  if (id === USER || s.agents[id]) return;
  const agent: Agent = {
    id,
    name: id === ORCH ? "Orquestrador" : (ROLE_FALLBACK[id] ?? id),
    role: ROLE_FALLBACK[id] ?? "Agente",
    engine: "—",
    parentId: id === ORCH ? null : ORCH,
    hue: hueFor(id),
    brief: id === ORCH ? "Coordena o conselho e conversa com você." : "Participante anunciado pelo backend.",
  };
  s.emit({ type: "agent.spawned", agent, by: agent.parentId ?? USER }, metaOf(env));
}

type EnvHead = Pick<EventEnvelope, "id" | "seq" | "ts" | "turnId">;
/** Nomes repetidos (ex.: duas "Lia") ganham sufixo curto do id para ficarem distinguíveis. */
function uniqueName(name: string, id: string) {
  const s = useRun.getState();
  const clash = Object.values(s.agents).some((a) => a.id !== id && a.name === name);
  return clash ? `${name} · ${id.replace(/[^a-z0-9]/gi, "").slice(-4)}` : name;
}

const metaOf = (env: EnvHead) => ({ turnId: env.turnId ?? "—", at: Date.parse(env.ts) || Date.now(), eventId: env.id, seq: env.seq });
const chatChannel = (from: string, recipients: string[]) => (from === USER || recipients.includes(USER) ? "chat" : "peer");

function apply(raw: EventEnvelope) {
  const s = useRun.getState();
  if (raw.seq <= s.lastEnvelopeSeq) return; // replay já aplicado
  s.setLastEnvelopeSeq(raw.seq);
  const env = raw as WireEvent;
  const m = metaOf(env);
  const actor = env.actorId;
  if (actor !== USER && actor !== "system" && actor !== "supervisor" && env.type !== "agent.spawned") ensureParticipant(actor, env);

  switch (env.type) {
    case "run.status":
      s.emit({ type: "run.status", status: env.payload.status, reason: env.payload.reason }, m);
      if (isTerminal(env.payload.status)) {
        terminalAt = Date.now();
        s.setAwaitingReply(null);
        // turnos ainda em execução podem emitir eventos tardios; só limpa o transitório se ninguém trabalha
        const busy = Object.values(s.backendStatus).some((v) => v === "running" || v === "queued");
        if (busy) return;
        for (const id of Object.keys(s.streaming)) s.streamEnd(id);
        for (const id of Object.keys(s.acting)) s.setActing(id, null);
        openActions.clear();
      }
      return;
    case "agent.spawned": {
      const p = env.payload;
      if (p.parentId) ensureParticipant(p.parentId, env);
      s.emit(
        {
          type: "agent.spawned",
          agent: {
            id: p.agentId,
            name: uniqueName(p.displayName, p.agentId),
            role: p.role,
            engine: p.runtime,
            parentId: p.parentId,
            hue: hueFor(p.agentId),
            brief: p.profile ? `Perfil ${p.profile} · ${p.role}` : p.role,
            dynamic: p.dynamic,
          },
          // linhagem honesta: pai declarado; senão quem emitiu (orquestrador raiz = aberto por você)
          by: p.parentId ?? (p.agentId === ORCH || actor === "system" ? USER : actor),
        },
        m,
      );
      return;
    }
    case "agent.status": {
      const { agentId, status } = env.payload;
      ensureParticipant(agentId, env);
      s.setBackendStatus(agentId, status);
      // agente ocioso/encerrado não está mais falando nem agindo
      if (status !== "running" && status !== "queued") {
        endStreams(agentId);
        for (const id of [...(openActions.get(agentId)?.keys() ?? [])]) closeAction(agentId, id);
      }
      return;
    }
    case "message.delta": {
      if (!env.messageId) return;
      const cur = s.streaming[env.messageId];
      if (cur) s.streamDelta(env.messageId, cur.text + env.payload.delta);
      else
        s.streamStart({
          messageId: env.messageId,
          turnId: env.turnId ?? "—",
          from: actor,
          recipients: env.recipients,
          channel: chatChannel(actor, env.recipients),
          text: env.payload.delta,
          evidenceIds: [],
        });
      return;
    }
    case "message.completed": {
      // tolera completed sem messageId: id estável do envelope; encerra streams do mesmo ator+turno
      const messageId = env.messageId ?? `${env.turnId ?? "—"}:${env.id}`;
      if (env.messageId) s.streamEnd(env.messageId);
      endStreams(actor, env.turnId);
      const p = env.payload;
      const channel = chatChannel(actor, env.recipients);
      s.emit(
        {
          type: "message.completed",
          message: {
            messageId,
            turnId: env.turnId ?? "—",
            from: actor,
            recipients: env.recipients,
            channel,
            text: p.body,
            format: p.format,
            replyTo: p.inReplyTo,
            evidenceIds: p.evidenceIds ?? [],
            clientMessageId: p.clientMessageId,
            seq: env.seq,
            at: m.at,
          },
        },
        m,
      );
      // turno humano aberto até o orquestrador responder no chat (sobrevive a reload/replay)
      if (actor === USER && env.turnId) s.setAwaitingReply(env.turnId);
      else if (actor !== USER && channel === "chat" && s.awaitingReply && s.awaitingReply === env.turnId) s.setAwaitingReply(null);
      return;
    }
    case "action.started":
      openAction(actor, env.payload.actionId, env.payload.label);
      return;
    case "action.completed": {
      const p = env.payload;
      closeAction(actor, p.actionId);
      s.emit({ type: "action.completed", action: { actionId: p.actionId, agentId: actor, label: p.label, detail: p.detail ?? "", evidenceIds: p.evidenceIds, ok: p.ok } }, m);
      return;
    }
    case "task.started": {
      const p = env.payload;
      s.emit(
        {
          type: "task.updated",
          started: true,
          task: { taskId: p.taskId, title: p.title, objective: p.objective, status: p.status, assigneeId: p.assigneeId, reviewerId: p.reviewerId, criterionIds: p.criterionIds },
        },
        m,
      );
      return;
    }
    case "task.completed": {
      const p = env.payload;
      const prev = s.tasks[p.taskId];
      s.emit(
        {
          type: "task.updated",
          started: false,
          task: { taskId: p.taskId, title: prev?.title ?? p.taskId, objective: prev?.objective ?? "", criterionIds: prev?.criterionIds ?? [], status: p.status, result: p.result, reviewerId: p.reviewerId ?? prev?.reviewerId, assigneeId: prev?.assigneeId, decidedBy: actor !== "supervisor" && actor !== "system" ? actor : undefined },
        },
        m,
      );
      return;
    }
    case "task.status": {
      // mudança de status pelo supervisor; 'review' é encaminhamento automático, não conversa entre pares
      const p = env.payload;
      if (!p.taskId || !p.status) return; // payload fora do contrato (observado seq 98): ignora sem criar tarefa fantasma
      const prev = s.tasks[p.taskId];
      s.emit(
        {
          type: "task.updated",
          started: false,
          task: {
            taskId: p.taskId,
            title: prev?.title ?? p.taskId,
            objective: prev?.objective ?? "",
            criterionIds: prev?.criterionIds ?? [],
            assigneeId: prev?.assigneeId,
            status: p.status,
            result: p.result ?? prev?.result,
            reviewerId: p.reviewerId ?? prev?.reviewerId,
            submittedBy: p.submittedBy,
          },
        },
        m,
      );
      return;
    }
    case "evidence.published": {
      const p = env.payload;
      s.emit(
        {
          type: "evidence.published",
          evidence: {
            evidenceId: p.id,
            agentId: actor,
            kind: p.kind,
            title: p.label,
            path: p.uri ?? "",
            summary: p.claims?.[0] ?? (p.excerpt ? p.excerpt.split("\n")[0].slice(0, 160) : ""),
            body: p.excerpt ?? "",
            provenance: p.provenance,
            sha256: p.sha256,
            claims: p.claims,
          },
        },
        m,
      );
      return;
    }
    case "artifact.published":
      s.emit({ type: "artifact.published", artifact: { ...env.payload, agentId: actor } }, m);
      return;
    case "criterion.status": {
      const p = env.payload;
      s.emit({ type: "criterion.updated", criterion: { id: p.criterionId, label: p.description, state: CRITERION[p.status] ?? "open", note: CRITERION_NOTE[p.status] ?? p.status } }, m);
      return;
    }
    case "report.updated":
      // resumo emitido depois do run encerrado (turno tardio) pode contradizer o estado final
      s.emit({ type: "report.updated", revision: env.payload.revision, summary: env.payload.summary, afterTerminal: isTerminal(s.runStatus) }, m);
      return;
    case "runtime.unavailable":
    case "runtime.auth":
    case "runtime.quota": {
      const p = env.payload;
      const kind = env.type === "runtime.unavailable" ? "unavailable" : env.type === "runtime.auth" ? "auth" : "quota";
      const resetAt = env.type === "runtime.quota" ? (env.payload.resetAt ?? env.payload.retryAfter) : undefined;
      s.emit({ type: "issue.raised", issue: { id: `${kind}:${p.agentId}:${p.runtime}`, kind, agentId: p.agentId, runtime: p.runtime, message: p.message, resetAt } }, m);
      return;
    }
    case "error":
      s.emit({ type: "issue.raised", issue: { id: env.id, kind: "error", message: `${env.payload.message} (${env.payload.code})`, retryable: env.payload.retryable } }, m);
      return;
    case "turn.stalled": {
      const p = env.payload;
      s.emit({ type: "issue.raised", issue: { id: `stalled:${p.turnId}`, kind: "stalled", agentId: p.agentId, message: `${p.reason} · ${p.attempts} tentativa(s)` } }, m);
      if (s.awaitingReply === p.turnId) s.setAwaitingReply(null);
      return;
    }
  }
}

// ações abertas por agente (o mesmo agente pode ter várias em paralelo)
const openActions = new Map<string, Map<string, string>>();
function openAction(agentId: string, actionId: string, label: string) {
  const m = openActions.get(agentId) ?? new Map<string, string>();
  m.set(actionId, label);
  openActions.set(agentId, m);
  useRun.getState().setActing(agentId, label);
}
function closeAction(agentId: string, actionId: string) {
  const m = openActions.get(agentId);
  m?.delete(actionId);
  const rest = m ? [...m.values()] : [];
  useRun.getState().setActing(agentId, rest.length ? rest[rest.length - 1] : null);
}
/** Encerra streams de UI de um ator (opcionalmente só de um turno). */
function endStreams(actor: string, turnId?: string | null) {
  const s = useRun.getState();
  for (const m of Object.values(s.streaming)) if (m.from === actor && (turnId == null || m.turnId === turnId)) s.streamEnd(m.messageId);
}

// momento do último run.status terminal (limita reconexões por eventos tardios)
let terminalAt = 0;
const LATE_EVENTS_WINDOW_MS = 120_000;

const REPLAY_STEP_MS = 140;

class RealSession {
  private stop: (() => void) | null = null;
  private log: EventEnvelope[] = [];
  private replayTimer: ReturnType<typeof setTimeout> | null = null;
  private meta: RunMeta | null = null;

  get runId() {
    return this.meta?.runId ?? null;
  }

  open(meta: RunMeta) {
    this.close();
    this.meta = meta;
    this.log = [];
    openActions.clear();
    terminalAt = 0;
    useRun.getState().load("real", meta);
    this.connect(0);
  }

  close() {
    this.stop?.();
    this.stop = null;
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = null;
    useRun.getState().setReplaying(false);
  }

  private connect(after: number) {
    if (!this.meta) return;
    const runId = this.meta.runId;
    this.stop = openRunStream(runId, after, {
      onEvent: (env) => {
        if (env.runId !== runId) return;
        if (!this.log.length || env.seq > this.log[this.log.length - 1].seq) this.log.push(env);
        apply(env);
      },
      onState: (state, detail) => {
        const s = useRun.getState();
        // terminal + stream encerrado pelo servidor: reconecta só enquanto algum agente ainda está
        // trabalhando (o backend pode emitir eventos tardios após o terminal); senão encerra
        const busy =
          Object.values(s.backendStatus).some((v) => v === "running" || v === "queued") && Date.now() - terminalAt < LATE_EVENTS_WINDOW_MS;
        if (state === "reconnecting" && isTerminal(s.runStatus) && !busy) {
          this.stop?.();
          this.stop = null;
          s.setStream("closed", "run encerrado");
          return;
        }
        s.setStream(state, detail);
      },
    });
  }

  /** Reproduz o histórico já recebido em ritmo legível e depois volta ao vivo. */
  replay() {
    if (!this.meta || !this.log.length) return;
    const events = this.log.filter((e) => e.type !== "message.delta");
    const all = this.log;
    this.stop?.();
    this.stop = null;
    useRun.getState().load("real", this.meta);
    openActions.clear();
    useRun.getState().setReplaying(true);
    useRun.getState().setStream("idle", "replay");
    let i = 0;
    const step = () => {
      if (i >= events.length) {
        this.finishReplay(all);
        return;
      }
      apply(events[i++]);
      this.replayTimer = setTimeout(step, REPLAY_STEP_MS);
    };
    step();
  }

  stopReplay() {
    if (!useRun.getState().replaying) return;
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.finishReplay(this.log);
  }

  private finishReplay(all: EventEnvelope[]) {
    this.replayTimer = null;
    const s = useRun.getState();
    for (const e of all) if (e.type !== "message.delta") apply(e);
    s.setReplaying(false);
    if (!isTerminal(s.runStatus)) this.connect(s.lastEnvelopeSeq);
    else s.setStream("closed", "run encerrado");
  }

  async send(text: string) {
    if (!this.runId) return;
    const clientMessageId = crypto.randomUUID();
    useRun.getState().setPendingHuman((p) => [...p, { localId: clientMessageId, text }]);
    await this.post(clientMessageId, text);
  }

  /** Reenvia um pendente que falhou, com o MESMO clientMessageId (POST idempotente no backend). */
  async retry(clientMessageId: string) {
    const p = useRun.getState().pendingHuman.find((x) => x.localId === clientMessageId);
    if (!p) return;
    useRun.getState().setPendingHuman((all) => all.map((x) => (x.localId === clientMessageId ? { ...x, error: undefined } : x)));
    await this.post(clientMessageId, p.text);
  }

  private async post(clientMessageId: string, text: string) {
    const runId = this.runId;
    if (!runId) return;
    // falhas de rede/5xx: até 3 tentativas automáticas com o mesmo id
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await api.sendMessage(runId, { body: text, format: "text", clientMessageId });
        const st = useRun.getState();
        const delivered = st.messages[res.messageId] || !st.pendingHuman.some((x) => x.localId === clientMessageId);
        st.setPendingHuman((p) => (delivered ? p.filter((x) => x.localId !== clientMessageId) : p.map((x) => (x.localId === clientMessageId ? { ...x, messageId: res.messageId } : x))));
        if (res.turnId) st.setAwaitingReply(res.turnId);
        // run terminal/encerrado pode ser acordado pela mensagem: reabre o stream a partir do último seq
        if (!this.stop && !st.replaying) this.connect(st.lastEnvelopeSeq);
        return;
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError("unknown", String(e), 0);
        if (err.retryable && attempt < 2) {
          await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
          continue;
        }
        useRun.getState().setPendingHuman((p) => p.map((x) => (x.localId === clientMessageId ? { ...x, error: `${err.message} (${err.code})` } : x)));
        return;
      }
    }
  }

  async cancelTurn() {
    const s = useRun.getState();
    if (!this.runId || !s.awaitingReply) return;
    const turnId = s.awaitingReply;
    try {
      await api.cancelTurn(this.runId, turnId);
      s.setAwaitingReply(null);
    } catch (e) {
      this.raise(e);
    }
  }

  async control(action: "pause" | "resume" | "cancel") {
    if (!this.runId) return;
    try {
      const res = await api.control(this.runId, action);
      if (res?.status) useRun.getState().setRunStatus(res.status);
    } catch (e) {
      this.raise(e);
    }
  }

  async addSpecialist(name: string, profile: SpecialistProfile, scope?: string) {
    if (!this.runId) return false;
    try {
      await api.addSpecialist(this.runId, { name, profile, ...(scope ? { scope } : {}) });
      return true;
    } catch (e) {
      this.raise(e);
      return false;
    }
  }

  /** Falhas de chamada aparecem como problema visível, não somem em console. */
  private raise(e: unknown) {
    const err = e instanceof ApiError ? e : new ApiError("unknown", String(e), 0);
    const id = `api:${Date.now()}`;
    useRun.getState().emit({ type: "issue.raised", issue: { id, kind: "error", message: `${err.message} (${err.code})`, retryable: err.retryable } }, { seq: useRun.getState().seq, eventId: id });
  }
}

export const realSession = new RealSession();
