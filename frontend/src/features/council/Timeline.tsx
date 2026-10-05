import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, CheckCircle2, CircleDashed, CornerDownRight, FileBox, FileText, GitBranchPlus, ListChecks, Radio, SquareTerminal, XCircle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Avatar, evidenceIcon, EvidenceChip, Recipients, ToneTag, useParticipant } from "@/features/common";
import type { RunEvent } from "@/model/types";
import { RUN_STATUS_LABEL, clockLabel, useRun, type TimelineFilter } from "@/store/run";
import { cn } from "@/lib/utils";
import { Markdown } from "@/features/report/Markdown";

type Row = { kind: "event"; event: RunEvent } | { kind: "live"; messageId: string };

const FILTERS: { id: TimelineFilter; label: string }[] = [
  { id: "all", label: "Tudo" },
  { id: "message", label: "Mensagens" },
  { id: "action", label: "Ações" },
  { id: "evidence", label: "Evidências" },
];

function involves(e: RunEvent, id: string) {
  switch (e.type) {
    case "message.completed":
      return e.message.from === id || e.message.recipients.includes(id);
    case "action.completed":
      return e.action.agentId === id;
    case "evidence.published":
      return e.evidence.agentId === id;
    case "agent.spawned":
      return e.agent.id === id || e.by === id;
    case "criterion.updated":
      return e.criterion.owner === id;
    case "task.updated":
      return e.task.assigneeId === id || e.task.reviewerId === id;
    case "artifact.published":
      return e.artifact.agentId === id;
    case "issue.raised":
      return e.issue.agentId === id;
    case "run.status":
    case "report.updated":
      return false;
  }
}

export function useFilteredEvents(filter: TimelineFilter, agentId: string | null) {
  const events = useRun((s) => s.events);
  return useMemo(
    () =>
      events.filter((e) => {
        if (agentId && !involves(e, agentId)) return false;
        if (filter === "message") return e.type === "message.completed";
        if (filter === "action") return e.type === "action.completed" || e.type === "task.updated";
        if (filter === "evidence") return e.type === "evidence.published" || e.type === "artifact.published";
        // Em "Tudo", a evidência aparece como chip da ação que a produziu.
        return e.type !== "evidence.published";
      }),
    [events, filter, agentId],
  );
}

export function TimelineFilters({ className }: { className?: string }) {
  const filter = useRun((s) => s.timelineFilter);
  const setFilter = useRun((s) => s.setTimelineFilter);
  const agentFilter = useRun((s) => s.agentFilter);
  const setAgentFilter = useRun((s) => s.setAgentFilter);
  const order = useRun((s) => s.agentOrder);
  const agents = useRun((s) => s.agents);
  return (
    <div className={cn("flex items-center gap-3 overflow-x-auto [scrollbar-width:none]", className)}>
      <div role="radiogroup" aria-label="Tipo de evento" className="flex shrink-0 rounded-lg bg-white/[0.03] p-0.5 ring-1 ring-line">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            role="radio"
            aria-checked={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12px] transition-colors",
              filter === f.id ? "bg-white/[0.08] text-fg" : "text-fg-faint hover:text-fg-muted",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Filtrar por agente">
        {order.map((id) => (
          <button
            key={id}
            onClick={() => setAgentFilter(agentFilter === id ? null : id)}
            aria-pressed={agentFilter === id}
            title={`Só ${agents[id]?.name}`}
            className={cn(
              "rounded-full p-0.5 transition-opacity",
              agentFilter && agentFilter !== id ? "opacity-35 hover:opacity-80" : "opacity-100",
              agentFilter === id && "ring-1 ring-white/30",
            )}
          >
            <Avatar id={id} size={20} status={false} />
            <span className="sr-only">Filtrar por {agents[id]?.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Timeline({ className }: { className?: string }) {
  const filter = useRun((s) => s.timelineFilter);
  const agentFilter = useRun((s) => s.agentFilter);
  const events = useFilteredEvents(filter, agentFilter);
  // só os ids das mensagens vivas: a lista re-renderiza quando uma entra/sai, não a cada token
  const liveIds = useRun(
    useShallow((s) =>
      filter === "all" || filter === "message"
        ? Object.values(s.streaming)
            .filter((m) => !agentFilter || m.from === agentFilter || m.recipients.includes(agentFilter))
            .map((m) => m.messageId)
        : [],
    ),
  );
  const rows = useMemo<Row[]>(
    () => [...events.map((event) => ({ kind: "event" as const, event })), ...liveIds.map((messageId) => ({ kind: "live" as const, messageId }))],
    [events, liveIds],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 92,
    overscan: 8,
    getItemKey: (i) => {
      const row = rows[i];
      return row.kind === "event" ? row.event.eventId : row.messageId + ":live";
    },
  });

  // Acompanha o fim enquanto o usuário não rola para cima. Coalescido por frame:
  // deltas chegam a dezenas por segundo e não devem forçar layout a cada token.
  // tamanho total muda quando uma linha viva cresce (medida pelo virtualizador)
  const lastKey = `${rows.length}:${virtualizer.getTotalSize()}`;
  const raf = useRef(0);
  const rowsLen = useRef(0);
  rowsLen.current = rows.length;
  useEffect(() => {
    if (!stick.current || !rows.length || raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (stick.current) virtualizer.scrollToIndex(rowsLen.current - 1, { align: "end" });
    });
  }, [lastKey, rows.length, virtualizer]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <div
      ref={parentRef}
      className={cn("min-h-0 overflow-y-auto", className)}
      onScroll={(e) => {
        const el = e.currentTarget;
        // voltar ao fim reativa o acompanhamento; sair dele só por intenção do usuário (abaixo)
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) stick.current = true;
      }}
      onWheel={(e) => {
        if (e.deltaY < 0) stick.current = false;
      }}
      onTouchMove={() => (stick.current = false)}
      onKeyDown={(e) => {
        if (["ArrowUp", "PageUp", "Home"].includes(e.key)) stick.current = false;
      }}
      onPointerDown={(e) => {
        // clique na própria barra de rolagem (alvo é o contêiner)
        if (e.target === e.currentTarget) stick.current = false;
      }}
      tabIndex={0}
      role="log"
      aria-label="Timeline do conselho"
    >
      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-[12.5px] text-fg-faint">Nada com esse filtro ainda.</p>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index];
            return (
              <div key={v.key} ref={virtualizer.measureElement} data-index={v.index} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
                {row.kind === "live" ? <LiveRow messageId={row.messageId} /> : <EventRow event={row.event} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Name({ id }: { id: string }) {
  const p = useParticipant(id);
  const select = useRun((s) => s.selectAgent);
  const isAgent = useRun((s) => !!s.agents[id]);
  if (id === "user") return <span className="font-medium text-fg">Você</span>;
  if (!isAgent) return <span className="font-medium" style={{ color: p.hue }}>{p.name}</span>;
  return (
    <button onClick={() => select(id)} className="font-medium hover:underline hover:underline-offset-2" style={{ color: p.hue }}>
      {p.name}
    </button>
  );
}

function ReplyHint({ messageId }: { messageId?: string }) {
  const parent = useRun((s) => (messageId ? s.messages[messageId] : undefined));
  const p = useParticipant(parent?.from ?? "");
  if (!parent) return null;
  return (
    <div className="mb-1 flex items-center gap-1 truncate text-[11.5px] text-fg-faint">
      <CornerDownRight className="size-3 shrink-0" />
      responde a <span style={{ color: p.hue }}>{p.name}</span>
      <span className="truncate opacity-70">“{parent.text.slice(0, 64)}…”</span>
    </div>
  );
}

const TASK_STATUS_LABEL: Record<string, string> = {
  pending: "pendente",
  ready: "pronta",
  running: "em execução",
  blocked: "bloqueada",
  completed: "concluída",
  failed: "falhou",
  cancelled: "cancelada",
};

const rowCls = "group flex gap-3 px-4 py-3 sm:px-5";

function EventRow({ event: e }: { event: RunEvent }) {
  switch (e.type) {
    case "message.completed": {
      const m = e.message;
      return (
        <article className={rowCls}>
          <Avatar id={m.from} size={26} status={false} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <ReplyHint messageId={m.replyTo} />
            <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
              <Name id={m.from} />
              <Recipients ids={m.recipients} />
              <ToneTag tone={m.tone} />
              {m.channel === "chat" && <span className="text-[10.5px] text-fg-faint">chat</span>}
              <time className="ml-auto font-mono text-[10.5px] text-fg-faint tabular">{clockLabel(e.at)}</time>
            </header>
            {m.format === "markdown" ? (
              <div className="mt-1 text-[13.5px] leading-[1.6] text-fg/85 [&_p]:my-0 [&_p+p]:mt-2">
                <Markdown text={m.text} />
              </div>
            ) : (
              <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-[1.6] text-fg/85">
                {m.text}
                {m.interrupted && <span className="text-fg-faint"> — interrompida</span>}
              </p>
            )}
            {m.evidenceIds.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {m.evidenceIds.map((id) => (
                  <EvidenceChip key={id} id={id} />
                ))}
              </div>
            )}
          </div>
        </article>
      );
    }
    case "action.completed": {
      const a = e.action;
      return (
        <div className={rowCls}>
          <span className="mt-0.5 grid size-[26px] shrink-0 place-items-center rounded-full border border-dashed border-line-strong text-fg-faint">
            <SquareTerminal className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 text-[12px]">
              <Name id={a.agentId} />
              <span className="text-fg-muted">{a.label}</span>
              {a.simulated && <span className="rounded bg-white/5 px-1.5 py-px font-mono text-[10px] text-fg-faint">ação simulada</span>}
              {a.ok === false && <span className="rounded bg-[#e6a0a0]/10 px-1.5 py-px text-[10.5px] text-[#e8b4b4]">falhou</span>}
              <time className="ml-auto font-mono text-[10.5px] text-fg-faint tabular">{clockLabel(e.at)}</time>
            </div>
            <p className="mt-0.5 text-[12.5px] text-fg-faint">{a.detail}</p>
            {a.evidenceIds.map((ev) => <EvidenceChip key={ev} id={ev} className="mr-1.5 mt-2" />)}
          </div>
        </div>
      );
    }
    case "evidence.published": {
      const ev = e.evidence;
      const Icon = evidenceIcon(ev.kind);
      return (
        <div className={rowCls}>
          <span className="mt-0.5 grid size-[26px] shrink-0 place-items-center rounded-md bg-white/[0.04] text-fg-muted">
            <Icon className="size-3.5" />
          </span>
          <button onClick={() => useRun.getState().setOpenEvidence(ev.evidenceId)} className="min-w-0 flex-1 text-left">
            <div className="flex items-center gap-2 text-[12.5px]">
              <span className="font-medium text-fg">{ev.title}</span>
              <time className="ml-auto font-mono text-[10.5px] text-fg-faint tabular">{clockLabel(e.at)}</time>
            </div>
            <div className="font-mono text-[11px] text-fg-faint">{ev.path}</div>
            <p className="mt-1 text-[12.5px] text-fg-muted">{ev.summary}</p>
          </button>
        </div>
      );
    }
    case "agent.spawned":
      return (
        <div className="flex items-center gap-3 px-4 py-2 text-[12px] text-fg-faint sm:px-5">
          <span className="grid size-[26px] shrink-0 place-items-center">
            <GitBranchPlus className="size-3.5" />
          </span>
          <span>
            <Name id={e.by} /> {e.by === "user" ? "abriu" : "criou"} <Name id={e.agent.id} /> · {e.agent.role}
            {e.agent.dynamic && " · especialista dinâmico"}
          </span>
          <time className="ml-auto font-mono text-[10.5px] tabular">{clockLabel(e.at)}</time>
        </div>
      );
    case "task.updated": {
      const t = e.task;
      const done = t.status === "completed";
      const bad = t.status === "failed" || t.status === "blocked";
      if (t.status === "review")
        return (
          <SystemRow at={e.at} icon={<ListChecks className="size-3.5 text-[#9db0f5]" />}>
            <span className="text-[#9db0f5]">Enviada para revisão</span> · {t.title}
            {t.submittedBy && <> · <Name id={t.submittedBy} /></>}
            {t.reviewerId && <> → <Name id={t.reviewerId} /></>}
            <span className="text-fg-faint"> · encaminhamento automático do supervisor</span>
          </SystemRow>
        );
      return (
        <SystemRow at={e.at} icon={<ListChecks className={cn("size-3.5", done ? "text-ok" : bad ? "text-warn" : "text-fg-faint")} />}>
          <span className={done ? "text-ok" : bad ? "text-warn" : "text-fg-muted"}>{e.started ? "Tarefa iniciada" : `Tarefa ${TASK_STATUS_LABEL[t.status] ?? t.status}`}</span> · {t.title}
          {t.assigneeId && <> · <Name id={t.assigneeId} /></>}
          {t.decidedBy && t.decidedBy !== t.assigneeId && <> · decisão de <Name id={t.decidedBy} /></>}
          {t.result && <span className="text-fg-faint"> — {t.result}</span>}
        </SystemRow>
      );
    }
    case "artifact.published":
      return (
        <SystemRow at={e.at} icon={<FileBox className="size-3.5 text-fg-faint" />}>
          <Name id={e.artifact.agentId} /> publicou{" "}
          <button className="text-fg underline-offset-2 hover:underline" onClick={() => useRun.getState().setOpenArtifact(e.artifact.artifactId)}>
            {e.artifact.name}
          </button>
        </SystemRow>
      );
    case "issue.raised":
      return (
        <SystemRow at={e.at} icon={e.issue.kind === "error" ? <XCircle className="size-3.5 text-[#e8b4b4]" /> : <AlertTriangle className="size-3.5 text-warn" />}>
          <span className={e.issue.kind === "error" ? "text-[#e8b4b4]" : "text-warn"}>
            {{ unavailable: "Runtime indisponível", quota: "Quota", auth: "Autenticação", stalled: "Turno travado", error: "Erro" }[e.issue.kind]}
          </span>
          {e.issue.runtime && <span className="font-mono text-[11px] text-fg-faint"> {e.issue.runtime}</span>} — {e.issue.message}
        </SystemRow>
      );
    case "run.status":
      return (
        <SystemRow at={e.at} icon={<Radio className="size-3.5 text-fg-faint" />}>
          Run {RUN_STATUS_LABEL[e.status] ?? e.status}
          {e.reason && <span className="text-fg-faint"> — {e.reason}</span>}
        </SystemRow>
      );
    case "report.updated":
      if (e.afterTerminal)
        return (
          <SystemRow at={e.at} icon={<FileText className="size-3.5 text-fg-faint" />}>
            <details>
              <summary className="cursor-pointer text-fg-faint hover:text-fg-muted">
                Resumo rev. {e.revision} emitido após o encerramento · histórico, pode estar desatualizado
              </summary>
              <span className="mt-1 block text-fg-faint">{e.summary}</span>
            </details>
          </SystemRow>
        );
      return (
        <SystemRow at={e.at} icon={<FileText className="size-3.5 text-fg-faint" />}>
          <button className="underline-offset-2 hover:underline" onClick={() => useRun.getState().setView("relatorio")}>
            Relatório atualizado (rev. {e.revision})
          </button>
          <span className="text-fg-faint"> — {e.summary}</span>
        </SystemRow>
      );
    case "criterion.updated": {
      const c = e.criterion;
      const met = c.state === "met";
      return (
        <div className="flex items-center gap-3 px-4 py-2 text-[12px] sm:px-5">
          <span className="grid size-[26px] shrink-0 place-items-center">
            {met ? <CheckCircle2 className="size-3.5 text-ok" /> : <CircleDashed className="size-3.5 text-warn" />}
          </span>
          <span className="min-w-0 truncate text-fg-muted">
            <span className={met ? "text-ok" : "text-warn"}>{met ? "Critério coberto" : c.state === "blocked" ? "Critério bloqueado" : c.state === "open" ? "Critério registrado" : "Critério em andamento"}</span> · {c.label}
            <span className="text-fg-faint"> — {c.note}</span>
          </span>
          <time className="ml-auto shrink-0 font-mono text-[10.5px] text-fg-faint tabular">{clockLabel(e.at)}</time>
        </div>
      );
    }
  }
}

function SystemRow({ at, icon, children }: { at: number; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2 text-[12px] text-fg-muted sm:px-5">
      <span className="grid size-[26px] shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1 pt-[5px] leading-snug">{children}</span>
      <time className="shrink-0 pt-[5px] font-mono text-[10.5px] text-fg-faint tabular">{clockLabel(at)}</time>
    </div>
  );
}

/** Texto de uma mensagem em streaming amostrado no máximo a cada ~150 ms. */
function useThrottledStreamText(messageId: string, ms = 150) {
  const [text, setText] = useState(() => useRun.getState().streaming[messageId]?.text ?? "");
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useRun.subscribe((s) => {
      const v = s.streaming[messageId]?.text;
      if (v === undefined || timer) return;
      const wait = Math.max(0, ms - (performance.now() - last));
      timer = setTimeout(() => {
        timer = undefined;
        last = performance.now();
        setText(useRun.getState().streaming[messageId]?.text ?? v);
      }, wait);
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, [messageId, ms]);
  return text;
}

function LiveRow({ messageId }: { messageId: string }) {
  // metadados são estáveis durante o stream; o texto vem amostrado
  const msg = useRun((s) => s.streaming[messageId]);
  const text = useThrottledStreamText(messageId);
  const paused = useRun((s) => s.paused);
  if (!msg) return null;
  return (
    <article className={cn(rowCls, "bg-white/[0.015]")}>
      <Avatar id={msg.from} size={26} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <ReplyHint messageId={msg.replyTo} />
        <header className="flex flex-wrap items-center gap-x-2 text-[12px]">
          <Name id={msg.from} />
          <Recipients ids={msg.recipients} />
          <ToneTag tone={msg.tone} />
          <span className="ml-auto text-[10.5px] text-fg-faint">{paused ? "pausado" : "escrevendo"}</span>
        </header>
        <p className={cn("mt-1 text-[13.5px] leading-[1.6] text-fg/85", !paused && "stream-caret")}>{text}</p>
      </div>
    </article>
  );
}
