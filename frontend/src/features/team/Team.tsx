import { useState } from "react";
import { CheckCircle2, Circle, CircleDashed, Plus, UserPlus, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { Avatar, EngineTag } from "@/features/common";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { engine } from "@/demo/engine";
import { controls } from "@/app/controls";
import type { SpecialistProfile } from "../../../../shared/contracts";
import { SPECIALISTS } from "@/demo/scenario";
import { STATUS_LABEL, isTerminal, selectMetCount, selectStatus, useRun } from "@/store/run";
import { cn } from "@/lib/utils";

function useLiveLine(id: string) {
  const line = useRun(
    useShallow((s) => {
      const m = Object.values(s.streaming).find((x) => x.from === id);
      if (m) return { kind: "speaking" as const, text: m.text };
      if (s.acting[id]) return { kind: "acting" as const, text: s.acting[id] };
      return { kind: null, text: "" };
    }),
  );
  return line.kind ? line : null;
}

function TeamRow({ id }: { id: string }) {
  const agent = useRun((s) => s.agents[id]);
  const status = useRun((s) => selectStatus(s, id));
  const selected = useRun((s) => s.selectedAgent === id && s.panelOpen);
  const select = useRun((s) => s.selectAgent);
  const live = useLiveLine(id);
  if (!agent) return null;
  return (
    <motion.li layout="position" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25 }}>
      <button
        onClick={() => select(selected ? null : id)}
        aria-pressed={selected}
        className={cn(
          "group flex w-full gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
          selected ? "bg-white/[0.06]" : "hover:bg-white/[0.035]",
        )}
      >
        <Avatar id={id} size={28} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-fg">{agent.name}</span>
            <span className="truncate text-[12px] text-fg-faint">{agent.role}</span>
            <EngineTag engine={agent.engine} className="ml-auto" />
          </span>
          <span className={cn("mt-0.5 line-clamp-2 text-[12px] leading-snug", live ? "text-fg-muted" : status === "waiting" ? "text-warn" : "text-fg-faint")}>
            {live ? (live.kind === "acting" ? `${live.text}…` : `“${live.text.length > 90 ? "…" + live.text.slice(-90) : live.text}”`) : STATUS_LABEL[status]}
          </span>
        </span>
      </button>
    </motion.li>
  );
}

export function TeamList({ className }: { className?: string }) {
  const order = useRun((s) => s.agentOrder);
  return (
    <ul className={cn("flex flex-col gap-0.5", className)} aria-label="Equipe">
      <AnimatePresence initial={false}>
        {order.map((id) => (
          <TeamRow key={id} id={id} />
        ))}
      </AnimatePresence>
    </ul>
  );
}

/** Faixa horizontal para painéis estreitos: equipe identificável sem rolar. */
export function TeamStrip({ className }: { className?: string }) {
  const order = useRun((s) => s.agentOrder);
  const agents = useRun((s) => s.agents);
  const select = useRun((s) => s.selectAgent);
  const selected = useRun((s) => (s.panelOpen ? s.selectedAgent : null));
  return (
    <div className={cn("flex items-center gap-1 overflow-x-auto [scrollbar-width:none]", className)} role="list" aria-label="Equipe">
      {order.map((id) => (
        <StripItem key={id} id={id} name={agents[id]?.name ?? id} active={selected === id} onClick={() => select(selected === id ? null : id)} />
      ))}
      <span role="listitem" className="shrink-0">
        <AddSpecialist compact />
      </span>
    </div>
  );
}

function StripItem({ id, name, active, onClick }: { id: string; name: string; active: boolean; onClick: () => void }) {
  const status = useRun((s) => selectStatus(s, id));
  const role = useRun((s) => s.agents[id]?.role);
  return (
    <span role="listitem" className="shrink-0">
    <button
      onClick={onClick}
      aria-pressed={active}
      title={`${name} · ${role} · ${STATUS_LABEL[status]}`}
      className={cn("flex shrink-0 items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[12px] transition-colors", active ? "bg-white/[0.08] text-fg" : "text-fg-muted hover:bg-white/[0.04]")}
    >
      <Avatar id={id} size={22} />
      {name}
    </button>
    </span>
  );
}

const PROFILES: { id: SpecialistProfile; label: string }[] = [
  { id: "code-review", label: "Revisão de código" },
  { id: "architecture", label: "Arquitetura" },
  { id: "testing", label: "Testes" },
  { id: "product", label: "Produto" },
  { id: "performance", label: "Desempenho" },
  { id: "custom", label: "Personalizado" },
];

// Repassa props/ref do PopoverTrigger (asChild) para o botão real.
function SpecialistTrigger({ compact, disabled, label, ...rest }: { compact: boolean; disabled: boolean; label: string } & React.ComponentProps<"button">) {
  return compact ? (
    <button
      {...rest}
      className="grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-line-strong text-fg-faint transition-colors hover:border-white/25 hover:text-fg disabled:opacity-30"
      aria-label="Adicionar especialista"
      disabled={disabled}
    >
      <Plus className="size-3.5" />
    </button>
  ) : (
    <Button {...rest} variant="ghost" size="sm" className="w-full justify-start text-fg-faint" disabled={disabled}>
      <UserPlus className="size-3.5" />
      {label}
    </Button>
  );
}

export function AddSpecialist({ compact = false }: { compact?: boolean }) {
  const mode = useRun((s) => s.mode);
  return mode === "demo" ? <DemoSpecialist compact={compact} /> : <RealSpecialist compact={compact} />;
}

function RealSpecialist({ compact }: { compact: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<SpecialistProfile>("code-review");
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const closed = useRun((s) => !s.meta || isTerminal(s.runStatus) || s.replaying);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    const ok = await controls.addSpecialist(name.trim(), profile, scope.trim() || undefined);
    setBusy(false);
    if (ok) {
      setOpen(false);
      setName("");
      setScope("");
    }
  };
  const field = "w-full rounded-md border border-line-strong bg-ink-900 px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-white/20";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SpecialistTrigger compact={compact} disabled={closed} label="Adicionar especialista" />
      </PopoverTrigger>
      <PopoverContent align={compact ? "end" : "start"} className="w-80 p-3">
        <form onSubmit={submit} className="flex flex-col gap-2.5">
          <p className="text-[11.5px] leading-snug text-fg-faint">O backend cria o especialista neste run; ele aparece no conselho quando o evento chegar.</p>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (ex.: Lia)" aria-label="Nome do especialista" className={cn(field, "h-8")} required />
          <select value={profile} onChange={(e) => setProfile(e.target.value as SpecialistProfile)} aria-label="Perfil" className={cn(field, "h-8")}>
            {PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <textarea value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Escopo (opcional): o que deve olhar" aria-label="Escopo" rows={2} className={cn(field, "resize-none py-1.5")} />
          <Button type="submit" variant="accent" size="sm" disabled={busy || !name.trim()}>
            {busy ? "Adicionando…" : "Adicionar ao conselho"}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function DemoSpecialist({ compact }: { compact: boolean }) {
  const [open, setOpen] = useState(false);
  const agents = useRun((s) => s.agents);
  useRun((s) => s.seq); // reavalia "na fila" a cada evento
  const available = SPECIALISTS.filter((a) => !agents[a.id] && !engine.isQueued(a.id));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SpecialistTrigger compact={compact} disabled={available.length === 0} label={available.length ? "Adicionar especialista" : "Especialistas já no conselho"} />
      </PopoverTrigger>
      <PopoverContent align={compact ? "end" : "start"}>
        <p className="px-2 pb-1.5 pt-1 text-[11px] text-fg-faint">Demo: o orquestrador roteirizado cria o agente e o apresenta à equipe.</p>
        {SPECIALISTS.map((a) => {
          const taken = !available.includes(a);
          return (
            <button
              key={a.id}
              disabled={taken}
              onClick={() => {
                controls.addDemoSpecialist(a.id);
                setOpen(false);
              }}
              className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-white/[0.05] disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <span
                className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[11px]"
                style={{ color: a.hue, background: `color-mix(in oklab, ${a.hue} 13%, #0e0f11)`, boxShadow: `inset 0 0 0 1px ${a.hue}55` }}
              >
                {a.name[0]}
              </span>
              <span className="min-w-0">
                <span className="flex items-baseline gap-2 text-[13px] text-fg">
                  {a.name} <span className="text-[12px] text-fg-faint">{a.role}</span>
                </span>
                <span className="block text-[12px] leading-snug text-fg-muted">{taken ? "Já está no conselho." : a.brief}</span>
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

export function CriteriaList({ className }: { className?: string }) {
  const criteria = useRun((s) => s.criteria);
  const agents = useRun((s) => s.agents);
  return (
    <ul className={cn("flex flex-col gap-2.5", className)}>
      {criteria.map((c) => (
        <li key={c.id} className="flex gap-2.5">
          {c.state === "met" ? (
            <CheckCircle2 className="mt-px size-4 shrink-0 text-ok" />
          ) : c.state === "blocked" ? (
            <XCircle className="mt-px size-4 shrink-0 text-[#e8b4b4]" />
          ) : c.state === "progress" ? (
            <CircleDashed className="mt-px size-4 shrink-0 text-warn" />
          ) : (
            <Circle className="mt-px size-4 shrink-0 text-fg-faint/60" />
          )}
          <span className="min-w-0">
            <span className={cn("block text-[12.5px]", c.state === "met" ? "text-fg-muted" : "text-fg")}>{c.label}</span>
            <span className="block text-[11.5px] leading-snug text-fg-faint">
              {c.owner ? `${c.owner === "user" ? "você" : (agents[c.owner]?.name ?? c.owner)} · ` : ""}{c.note}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CriteriaMeter({ className }: { className?: string }) {
  const criteria = useRun((s) => s.criteria);
  const met = useRun(selectMetCount);
  return (
    <div className={cn("flex items-center gap-2", className)} title={criteria.map((c) => `${c.state === "met" ? "✓" : "·"} ${c.label}`).join("\n")}>
      <div className="flex gap-[3px]" aria-hidden>
        {criteria.map((c) => (
          <span
            key={c.id}
            className={cn("h-1.5 w-3.5 rounded-full transition-colors duration-500", c.state === "met" ? "bg-ok" : c.state === "progress" ? "bg-warn/70" : c.state === "blocked" ? "bg-[#e6a0a0]/70" : "bg-white/10")}
          />
        ))}
      </div>
      <span className="whitespace-nowrap font-mono text-[11px] text-fg-muted tabular">
        {met}/{criteria.length}
        <span className="text-fg-faint max-[480px]:hidden"> critérios</span>
      </span>
    </div>
  );
}
