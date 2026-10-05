import { FileBox, FileCode2, FlaskConical, NotebookPen, Package, SquareTerminal, type LucideIcon } from "lucide-react";
import { HUMAN } from "@/demo/scenario";
import type { ParticipantId, Tone } from "@/model/types";
import { selectStatus, useRun } from "@/store/run";
import { cn } from "@/lib/utils";

export function useParticipant(id: ParticipantId) {
  const agent = useRun((s) => s.agents[id]);
  if (id === "user") return { id, name: HUMAN.name, hue: HUMAN.hue, role: "Humano", engine: null as string | null };
  if (!agent && (id === "supervisor" || id === "system"))
    return { id, name: id === "supervisor" ? "Supervisor" : "Sistema", hue: "#8a8984", role: "Core", engine: null as string | null };
  return { id, name: agent?.name ?? id, hue: agent?.hue ?? "#888", role: agent?.role ?? "", engine: agent?.engine ?? null };
}

export function Avatar({ id, size = 28, status = true, className }: { id: ParticipantId; size?: number; status?: boolean; className?: string }) {
  const p = useParticipant(id);
  const st = useRun((s) => (id === "user" ? "idle" : selectStatus(s, id)));
  const paused = useRun((s) => s.paused);
  const live = !paused && (st === "speaking" || st === "acting");
  return (
    <span
      className={cn("relative inline-grid shrink-0 place-items-center rounded-full font-medium", className)}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        color: p.hue,
        background: `color-mix(in oklab, ${p.hue} 13%, #0e0f11)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${p.hue} 38%, transparent)`,
      }}
      aria-hidden
    >
      {id === "orchestrator" ? <OrqGlyph size={size * 0.46} /> : p.name.slice(0, 1)}
      {status && id !== "user" && (
        <span
          className={cn("absolute -bottom-px -right-px size-2 rounded-full ring-2 ring-ink-900", live && "live-dot")}
          style={{ background: st === "waiting" ? "var(--color-warn)" : live ? p.hue : "#3a3b3f" }}
        />
      )}
    </span>
  );
}

function OrqGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="2.2" />
      <circle cx="8" cy="8" r="6" strokeOpacity="0.5" strokeDasharray="2 2.4" />
    </svg>
  );
}

export function EngineTag({ engine, className }: { engine: string | null; className?: string }) {
  if (!engine) return null;
  return (
    <span className={cn("whitespace-nowrap font-mono text-[10.5px] tracking-tight text-fg-faint", className)}>{engine}</span>
  );
}

const TONE: Record<Tone, { label: string; cls: string } | null> = {
  brief: null,
  finding: { label: "achado", cls: "text-[#8fd3b6] bg-[#8fd3b6]/8" },
  counterpoint: { label: "contraponto", cls: "text-[#e6c27a] bg-[#e6c27a]/10" },
  agree: { label: "concorda", cls: "text-fg-muted bg-white/5" },
  question: { label: "pergunta", cls: "text-[#9db0f5] bg-[#9db0f5]/10" },
  decision: { label: "decisão", cls: "text-accent bg-accent/10" },
};

export function ToneTag({ tone }: { tone?: Tone }) {
  const t = tone ? TONE[tone] : null;
  if (!t) return null;
  return <span className={cn("rounded px-1.5 py-px text-[10.5px] font-medium tracking-wide", t.cls)}>{t.label}</span>;
}

const EVIDENCE_ICONS: Record<string, LucideIcon> = {
  diff: FileCode2,
  file: FileCode2,
  lockfile: Package,
  lab: FlaskConical,
  command_result: SquareTerminal,
  artifact: FileBox,
  note: NotebookPen,
};
export const evidenceIcon = (kind: string): LucideIcon => EVIDENCE_ICONS[kind] ?? NotebookPen;

export function EvidenceChip({ id, className }: { id: string; className?: string }) {
  const ev = useRun((s) => s.evidence[id]);
  const open = useRun((s) => s.setOpenEvidence);
  if (!ev) return null;
  const Icon = evidenceIcon(ev.kind);
  return (
    <button
      type="button"
      onClick={() => open(id)}
      className={cn(
        "group inline-flex max-w-full items-center gap-1.5 rounded-md border border-line-strong bg-white/[0.02] py-1 pl-1.5 pr-2 text-left text-[12px] text-fg-muted transition-colors hover:border-white/20 hover:bg-white/[0.05] hover:text-fg",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0 text-fg-faint group-hover:text-accent" />
      <span className="truncate">{ev.title}</span>
      {ev.simulated && <span className="shrink-0 font-mono text-[10px] text-fg-faint">simulada</span>}
    </button>
  );
}

export function Recipients({ ids, className }: { ids: ParticipantId[]; className?: string }) {
  const agents = useRun((s) => s.agents);
  const names = ids.map((id) => (id === "user" ? "você" : (agents[id]?.name ?? id)));
  return <span className={cn("text-fg-faint", className)}>→ {names.join(", ")}</span>;
}
