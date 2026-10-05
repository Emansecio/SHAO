import { useMemo } from "react";
import { ArrowDownLeft, ArrowUpRight, Network, SquareTerminal, X } from "lucide-react";
import { Avatar, EngineTag, EvidenceChip, ToneTag } from "@/features/common";
import { Button } from "@/components/ui/button";
import { STATUS_LABEL, clockLabel, selectStatus, useRun } from "@/store/run";
import type { RunEvent } from "@/model/types";
import { cn } from "@/lib/utils";

/** Painel contextual: o que um agente disse, recebeu e fez neste run. */
export function ContextPanel({ onClose, className }: { onClose: () => void; className?: string }) {
  const id = useRun((s) => s.selectedAgent);
  const agent = useRun((s) => (id ? s.agents[id] : undefined));
  const parent = useRun((s) => (agent?.parentId ? s.agents[agent.parentId] : undefined));
  const status = useRun((s) => (id ? selectStatus(s, id) : "idle"));
  const events = useRun((s) => s.events);
  const live = useRun((s) => (id ? Object.values(s.streaming).find((m) => m.from === id)?.text : undefined));
  const acting = useRun((s) => (id ? s.acting[id] : undefined));
  const agents = useRun((s) => s.agents);
  const view = useRun((s) => s.view);
  const mode = useRun((s) => s.mode);

  const activity = useMemo(
    () =>
      id
        ? events.filter(
            (e): e is Extract<RunEvent, { type: "message.completed" | "action.completed" }> =>
              (e.type === "message.completed" && (e.message.from === id || e.message.recipients.includes(id))) ||
              (e.type === "action.completed" && e.action.agentId === id),
          )
        : [],
    [events, id],
  );
  const sent = activity.filter((e) => e.type === "message.completed" && e.message.from === id).length;
  const received = activity.filter((e) => e.type === "message.completed" && e.message.from !== id).length;
  const actions = activity.filter((e) => e.type === "action.completed").length;

  if (!id || !agent) return null;
  const name = (pid: string) => (pid === "user" ? "você" : (agents[pid]?.name ?? pid));

  return (
    <aside className={cn("flex h-full min-h-0 flex-col bg-ink-900", className)} aria-label={`Contexto de ${agent.name}`}>
      <header className="flex items-start gap-3 px-5 pb-4 pt-5">
        <Avatar id={id} size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-baseline gap-2">
            <span className="font-serif text-[22px] leading-none text-fg">{agent.name}</span>
            <span className="text-[12.5px] text-fg-muted">{agent.role}</span>
          </h2>
          <p className="mt-1.5 text-[12.5px] leading-snug text-fg-muted">{agent.brief}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fechar painel">
          <X />
        </Button>
      </header>

      <dl className="mx-5 grid grid-cols-2 gap-x-4 gap-y-2.5 border-y border-line py-3.5 text-[12px]">
        <div>
          <dt className="text-fg-faint">Motor</dt>
          <dd><EngineTag engine={agent.engine} className="text-[11.5px] text-fg-muted" /></dd>
        </div>
        <div>
          <dt className="text-fg-faint">Estado</dt>
          <dd className={status === "waiting" ? "text-warn" : "text-fg-muted"}>{STATUS_LABEL[status]}</dd>
        </div>
        <div>
          <dt className="text-fg-faint">Criado por</dt>
          <dd className="text-fg-muted">{agent.parentId ? (parent?.name ?? agent.parentId) : "você (início do run)"}</dd>
        </div>
        <div>
          <dt className="text-fg-faint">Custo</dt>
          <dd className="text-fg-muted">{agent.costUsd != null ? `US$ ${agent.costUsd.toFixed(2)}` : "desconhecido"}</dd>
        </div>
        <div className="col-span-2 flex gap-4 font-mono text-[11px] text-fg-faint tabular">
          <span>{sent} enviadas</span>
          <span>{received} recebidas</span>
          <span>{actions} ações</span>
        </div>
      </dl>

      {(live || acting) && (
        <div className="mx-5 mt-4 rounded-lg border border-line-strong bg-white/[0.02] px-3 py-2.5">
          <div className="mb-1 text-[11px] uppercase tracking-[0.08em] text-fg-faint">{acting ? (mode === "demo" ? "Executando agora · simulado" : "Executando agora") : "Falando agora"}</div>
          <p className={cn("text-[13px] leading-relaxed text-fg/85", live && "stream-caret")}>{acting ?? live}</p>
        </div>
      )}

      <div className="flex items-center justify-between px-5 pb-2 pt-5">
        <h3 className="text-[11px] uppercase tracking-[0.08em] text-fg-faint">Mensagens e ações</h3>
        {view === "conversa" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const s = useRun.getState();
              s.setAgentFilter(id);
              s.setView("conselho");
            }}
          >
            <Network className="size-3.5" /> No conselho
          </Button>
        )}
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {activity.length === 0 && <li className="py-6 text-[12.5px] text-fg-faint">Ainda sem atividade.</li>}
        {[...activity].reverse().map((e) => {
          if (e.type === "action.completed") {
            return (
              <li key={e.eventId} className="relative border-l border-line py-2.5 pl-4">
                <span className="absolute -left-[5px] top-[15px] grid size-[9px] place-items-center rounded-full bg-ink-900 ring-1 ring-line-strong" />
                <div className="flex items-center gap-2 text-[12px]">
                  <SquareTerminal className="size-3.5 text-fg-faint" />
                  <span className="text-fg-muted">{e.action.label}</span>
                  <time className="ml-auto font-mono text-[10.5px] text-fg-faint tabular">{clockLabel(e.at)}</time>
                </div>
                <p className="mt-0.5 text-[12px] text-fg-faint">{e.action.detail}</p>
                {e.action.evidenceIds.map((ev) => <EvidenceChip key={ev} id={ev} className="mr-1.5 mt-1.5" />)}
              </li>
            );
          }
          const m = e.message;
          const out = m.from === id;
          return (
            <li key={e.eventId} className="relative border-l border-line py-2.5 pl-4">
              <span className="absolute -left-[4px] top-[15px] size-[7px] rounded-full" style={{ background: out ? agent.hue : "#4a4b50" }} />
              <div className="flex items-center gap-1.5 text-[12px]">
                {out ? <ArrowUpRight className="size-3.5 text-fg-faint" /> : <ArrowDownLeft className="size-3.5 text-fg-faint" />}
                <span className="text-fg-muted">{out ? `para ${m.recipients.map(name).join(", ")}` : `de ${name(m.from)}`}</span>
                <ToneTag tone={m.tone} />
                <time className="ml-auto font-mono text-[10.5px] text-fg-faint tabular">{clockLabel(e.at)}</time>
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-fg/80">{m.text}</p>
              {m.evidenceIds.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {m.evidenceIds.map((ev) => (
                    <EvidenceChip key={ev} id={ev} />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
