// Gerador local da demo. Avança um relógio próprio; pausar congela o relógio e tudo o que depende dele.
import { useRun } from "@/store/run";
import { DEMO_META, EVIDENCE, INITIAL_CRITERIA, OPENING, SPECIALISTS, demoAt, respondToHuman, specialistSteps, type Step } from "./scenario";
import type { StreamingMessage } from "@/model/types";

const TICK = 40;
const MAX_STEP = 1200;
const WORD_MS = 42;

interface Queued {
  step: Step;
  turnId: string;
}

type Current =
  | { phase: "gap"; item: Queued; remaining: number }
  | { phase: "act"; item: Queued & { step: Extract<Step, { kind: "act" }> }; remaining: number }
  | { phase: "say"; item: Queued & { step: Extract<Step, { kind: "say" }> }; msg: StreamingMessage; words: string[]; shown: number; acc: number };

class Engine {
  private queue: Queued[] = [];
  private current: Current | null = null;
  private keys = new Map<string, string>();
  private msgCounter = 0;
  private turnCounter = 0;
  private timer: ReturnType<typeof setInterval> | Worker | null = null;
  private last = performance.now();

  private meta(turnId: string) {
    return { turnId, at: demoAt(useRun.getState().clock) };
  }

  stop() {
    if (this.timer instanceof Worker) this.timer.terminate();
    else if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    useRun.getState().load("demo", DEMO_META, INITIAL_CRITERIA);
    this.load();
    this.last = performance.now();
    try {
      const worker = new Worker(new URL("./clock.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = () => this.tick();
      this.timer = worker;
    } catch {
      this.timer = setInterval(() => this.tick(), TICK);
    }
  }

  private load() {
    this.queue = OPENING.map((step) => ({ step, turnId: "turn-0" }));
    this.current = null;
    this.keys.clear();
    this.msgCounter = 0;
    this.turnCounter = 0;
  }

  reset() {
    useRun.getState().load("demo", DEMO_META, INITIAL_CRITERIA);
    this.load();
  }

  togglePause() {
    const s = useRun.getState();
    s.setPaused(!s.paused);
  }

  /** Mensagem humana: entra no log na hora; a resposta segue o relógio da simulação. */
  human(text: string) {
    const s = useRun.getState();
    const turnId = `turn-${++this.turnCounter}`;
    const messageId = this.nextMessageId();
    s.emit(
      {
        type: "message.completed",
        message: { messageId, turnId, from: "user", recipients: ["orchestrator"], channel: "chat", text, evidenceIds: [], seq: s.seq + 1, at: demoAt(s.clock) },
      },
      this.meta(turnId),
    );
    s.setAwaitingReply(turnId);
    s.setIdle(false);

    const added = s.agentOrder.filter((id) => s.agents[id]?.dynamic);
    const res = respondToHuman(text, {
      addedSpecialists: added,
      contractState: s.criteria.find((c) => c.id === "c-contract")!.state,
      criteria: s.criteria,
      names: Object.fromEntries(Object.values(s.agents).map((a) => [a.id, a.name])),
    });
    let steps = res.steps;
    if (res.addSpecialist) {
      const agent = SPECIALISTS.find((a) => a.id === res.addSpecialist)!;
      steps = [...steps, ...specialistSteps(agent, false)];
    }
    this.prioritize(steps, turnId);
  }

  addSpecialist(id: string) {
    const s = useRun.getState();
    if (s.agents[id] || this.queue.some((q) => q.step.kind === "spawn" && q.step.agent.id === id)) return;
    const agent = SPECIALISTS.find((a) => a.id === id);
    if (!agent) return;
    s.setIdle(false);
    this.prioritize(specialistSteps(agent), `turn-${++this.turnCounter}`);
  }

  isQueued(id: string) {
    return this.queue.some((q) => q.step.kind === "spawn" && q.step.agent.id === id);
  }

  /** Interrompe a resposta ao humano em curso (botão parar do composer). */
  cancelReply() {
    const s = useRun.getState();
    const turnId = s.awaitingReply;
    if (!turnId) return;
    this.queue = this.queue.filter((q) => q.turnId !== turnId);
    const cur = this.current;
    const replying = cur?.phase === "say" && cur.item.turnId === turnId && cur.msg.channel === "chat";
    if (cur && cur.item.turnId === turnId) {
      if (cur.phase === "say") this.finishSay(cur, true);
      if (cur.phase === "act") s.setActing(cur.item.step.agentId, null);
      this.current = null;
    }
    if (!replying) {
      // interrompida antes de começar: deixa rastro no chat em vez de sumir
      useRun.getState().emit(
        {
          type: "message.completed",
          message: { messageId: this.nextMessageId(), turnId, from: "orchestrator", recipients: ["user"], channel: "chat", text: "Ok, parei antes de responder.", evidenceIds: [], seq: s.seq + 1, at: demoAt(s.clock), interrupted: true },
        },
        this.meta(turnId),
      );
    }
    useRun.getState().setAwaitingReply(null);
  }

  // Passos humanos e de especialista entram à frente do roteiro restante.
  private prioritize(steps: Step[], turnId: string) {
    const items = steps.map((step) => ({ step, turnId }));
    const firstScripted = this.queue.findIndex((q) => q.turnId === "turn-0");
    if (firstScripted === -1) this.queue.push(...items);
    else this.queue.splice(firstScripted, 0, ...items);
  }

  private nextMessageId() {
    return `${(useRun.getState().meta?.runId ?? "demo")}:m${++this.msgCounter}`;
  }

  // Avança pelo tempo real decorrido (limitado), então timers estrangulados em painel oculto ainda progridem.
  private tick() {
    const now = performance.now();
    let budget = Math.min(now - this.last, MAX_STEP);
    this.last = now;
    if (useRun.getState().paused) return;
    useRun.getState().setClock(useRun.getState().clock + budget);

    for (let guard = 0; budget > 0 && guard < 64; guard++) {
      const s = useRun.getState();
      if (!this.current) {
        const item = this.queue.shift();
        if (!item) {
          if (!s.idle) s.setIdle(true);
          return;
        }
        if (s.idle) s.setIdle(false);
        this.current = { phase: "gap", item, remaining: item.step.gap };
      }

      const cur = this.current;
      switch (cur.phase) {
        case "gap": {
          const use = Math.min(budget, cur.remaining);
          cur.remaining -= use;
          budget -= use;
          if (cur.remaining <= 0) this.begin(cur.item);
          break;
        }
        case "act": {
          const use = Math.min(budget, cur.remaining);
          cur.remaining -= use;
          budget -= use;
          if (cur.remaining <= 0) {
            const { step, turnId } = cur.item;
            s.setActing(step.agentId, null);
            s.emit(
              {
                type: "action.completed",
                action: { actionId: `${s.meta?.runId ?? "demo"}:a${s.seq + 1}`, agentId: step.agentId, label: step.label, detail: step.detail, evidenceIds: step.evidence ? [step.evidence] : [], simulated: true },
              },
              this.meta(turnId),
            );
            if (step.evidence) useRun.getState().emit({ type: "evidence.published", evidence: { ...EVIDENCE[step.evidence], simulated: true } }, this.meta(turnId));
            this.current = null;
          }
          break;
        }
        case "say": {
          const use = Math.min(budget, cur.words.length * WORD_MS - cur.acc);
          cur.acc += use;
          budget -= use;
          const target = Math.min(cur.words.length, Math.floor(cur.acc / WORD_MS));
          if (target !== cur.shown) {
            cur.shown = target;
            s.streamDelta(cur.msg.messageId, cur.words.slice(0, target).join(""));
          }
          if (cur.shown >= cur.words.length) {
            this.finishSay(cur, false);
            this.current = null;
          }
          break;
        }
      }
    }
  }

  private begin(item: Queued) {
    const s = useRun.getState();
    const { step, turnId } = item;
    switch (step.kind) {
      case "spawn":
        if (!s.agents[step.agent.id]) s.emit({ type: "agent.spawned", agent: step.agent, by: step.by }, this.meta(turnId));
        this.current = null;
        return;
      case "criterion": {
        const prev = s.criteria.find((c) => c.id === step.id)!;
        s.emit({ type: "criterion.updated", criterion: { ...prev, state: step.state, note: step.note } }, this.meta(turnId));
        this.current = null;
        return;
      }
      case "act":
        s.setActing(step.agentId, step.label);
        this.current = { phase: "act", item: { ...item, step }, remaining: step.duration };
        return;
      case "say": {
        const messageId = this.nextMessageId();
        if (step.key) this.keys.set(step.key, messageId);
        const msg: StreamingMessage = {
          messageId,
          turnId,
          from: step.from,
          recipients: step.to,
          channel: step.to.includes("user") ? "chat" : "peer",
          text: "",
          tone: step.tone,
          replyTo: step.replyTo ? this.keys.get(step.replyTo) : undefined,
          evidenceIds: step.evidence ?? [],
        };
        s.streamStart(msg);
        this.current = { phase: "say", item: { ...item, step }, msg, words: step.text.match(/\S+\s*/g) ?? [step.text], shown: 0, acc: 0 };
        return;
      }
    }
  }

  private finishSay(cur: Extract<Current, { phase: "say" }>, interrupted: boolean) {
    const s = useRun.getState();
    const text = interrupted ? cur.words.slice(0, cur.shown).join("").trimEnd() : cur.item.step.text;
    s.streamEnd(cur.msg.messageId);
    s.emit(
      {
        type: "message.completed",
        message: {
          messageId: cur.msg.messageId,
          turnId: cur.msg.turnId,
          from: cur.msg.from,
          recipients: cur.msg.recipients,
          channel: cur.msg.channel,
          text: text || "…",
          tone: cur.msg.tone,
          replyTo: cur.msg.replyTo,
          evidenceIds: cur.msg.evidenceIds,
          seq: s.seq + 1,
          at: demoAt(s.clock),
          interrupted: interrupted || undefined,
        },
      },
      this.meta(cur.msg.turnId),
    );
    if (cur.msg.channel === "chat" && cur.msg.from === "orchestrator" && s.awaitingReply === cur.msg.turnId) s.setAwaitingReply(null);
  }
}

export const engine = new Engine();
