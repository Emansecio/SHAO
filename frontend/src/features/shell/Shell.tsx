import { useEffect, useState } from "react";
import { CircleStop, FileText, Menu, MessagesSquare, Network, Pause, Play, Plus, RotateCcw, Square } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CriteriaMeter } from "@/features/team/Team";
import { controls, openDemo, openHome, openRun } from "@/app/controls";
import { useBackend } from "@/real/backend";
import { RUN_STATUS_LABEL, isTerminal, useRun, type View } from "@/store/run";
import { cn } from "@/lib/utils";

export function DemoBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent/25 bg-accent/[0.07] px-2.5 py-[3px] text-[11px] font-medium text-accent",
        className,
      )}
      role="status"
    >
      <span className="size-1.5 rounded-full bg-accent" aria-hidden />
      <span className="hidden @3xl:inline">Demo interativa · dados simulados</span>
      <span className="@3xl:hidden">Demo · dados simulados</span>
    </span>
  );
}

/** Real: versão do backend + estado do stream. Nunca finge conexão. */
function LiveBadge({ className }: { className?: string }) {
  const version = useBackend((s) => s.version);
  const stream = useRun((s) => s.stream);
  const replaying = useRun((s) => s.replaying);
  const label = replaying
    ? "reproduzindo histórico"
    : { idle: "sem stream", connecting: "conectando…", live: "ao vivo", reconnecting: "reconectando…", closed: "stream encerrado", error: "erro no stream" }[stream.state];
  const tone = replaying ? "bg-accent" : stream.state === "live" ? "bg-ok" : stream.state === "error" ? "bg-[#e6a0a0]" : "bg-warn";
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-[3px] text-[11px] text-fg-muted", className)}
      role="status"
      title={stream.detail}
    >
      <span className={cn("size-1.5 rounded-full", tone, stream.state === "live" && !replaying && "live-dot")} aria-hidden />
      {version ? (/^\d/.test(version) ? `v${version}` : version) : "local"} · {label}
    </span>
  );
}

function ModeBadge({ className }: { className?: string }) {
  const mode = useRun((s) => s.mode);
  return mode === "demo" ? <DemoBadge className={className} /> : <LiveBadge className={className} />;
}

function ViewToggle({ pill }: { pill: string }) {
  const view = useRun((s) => s.view);
  const setView = useRun((s) => s.setView);
  const items: { id: View; label: string; Icon: typeof Network }[] = [
    { id: "conversa", label: "Conversa", Icon: MessagesSquare },
    { id: "conselho", label: "Conselho", Icon: Network },
    { id: "relatorio", label: "Relatório", Icon: FileText },
  ];
  return (
    <div role="tablist" aria-label="Vista do run" className="relative flex shrink-0 rounded-lg bg-white/[0.035] p-0.5 ring-1 ring-line">
      {items.map(({ id, label, Icon }) => (
        <button
          key={id}
          role="tab"
          aria-selected={view === id}
          onClick={() => setView(id)}
          className={cn("relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] transition-colors", view === id ? "text-fg" : "text-fg-faint hover:text-fg-muted")}
        >
          {view === id && <motion.span layoutId={pill} className="absolute inset-0 rounded-md bg-white/[0.085]" transition={{ type: "spring", bounce: 0.15, duration: 0.35 }} />}
          <Icon className="relative size-3.5" />
          <span className="relative">{label}</span>
        </button>
      ))}
    </div>
  );
}

function IconAction({ label, onClick, children, pressed, disabled }: { label: string; onClick: () => void; children: React.ReactNode; pressed?: boolean; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={onClick} aria-label={label} aria-pressed={pressed} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Cancelar é irreversível: confirmação inline de um clique, sem modal. */
function CancelRun() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed)
    return (
      <Button
        variant="outline"
        size="sm"
        className="border-[#e6a0a0]/40 text-[#e8b4b4] hover:bg-[#e6a0a0]/10"
        onClick={() => {
          setArmed(false);
          controls.cancelRun();
        }}
      >
        <CircleStop className="size-3.5" /> Confirmar cancelamento
      </Button>
    );
  return (
    <IconAction label="Cancelar run" onClick={() => setArmed(true)}>
      <Square className="size-3.5" />
    </IconAction>
  );
}

function RunControls() {
  const mode = useRun((s) => s.mode);
  const status = useRun((s) => s.runStatus);
  const demoPaused = useRun((s) => s.paused);
  const replaying = useRun((s) => s.replaying);
  const hasEvents = useRun((s) => s.events.length > 0);
  if (mode === "demo")
    return (
      <div className="flex items-center gap-0.5">
        <IconAction label={demoPaused ? "Retomar simulação" : "Pausar simulação"} onClick={() => controls.togglePause()} pressed={demoPaused}>
          {demoPaused ? <Play className="text-accent" /> : <Pause />}
        </IconAction>
        <IconAction label="Reiniciar demo do zero" onClick={() => controls.restart()}>
          <RotateCcw />
        </IconAction>
      </div>
    );
  const terminal = isTerminal(status);
  const paused = status.startsWith("paused");
  return (
    <div className="flex items-center gap-0.5">
      {!terminal && !replaying && (
        <IconAction label={paused ? "Retomar run" : "Pausar run"} onClick={() => controls.togglePause()} pressed={paused}>
          {paused ? <Play className="text-accent" /> : <Pause />}
        </IconAction>
      )}
      {!terminal && !replaying && <CancelRun />}
      {replaying ? (
        <Button variant="outline" size="sm" onClick={() => controls.stopReplay()}>
          Pular replay
        </Button>
      ) : (
        <IconAction label="Reproduzir histórico do run" onClick={() => controls.restart()} disabled={!hasEvents}>
          <RotateCcw />
        </IconAction>
      )}
    </div>
  );
}

function RunState() {
  const mode = useRun((s) => s.mode);
  const demoPaused = useRun((s) => s.paused);
  const idle = useRun((s) => s.idle);
  const status = useRun((s) => s.runStatus);
  const awaiting = useRun((s) => s.awaitingReply);
  let label: string;
  let dot: string;
  if (mode === "demo") {
    label = demoPaused ? "pausado" : awaiting ? "respondendo você" : idle ? "aguarda você" : "em andamento";
    dot = demoPaused ? "bg-fg-faint" : idle ? "bg-warn" : "live-dot bg-ok";
  } else {
    label = awaiting && status === "running" ? "orquestrador respondendo" : (RUN_STATUS_LABEL[status] ?? status);
    dot =
      status === "running" ? "live-dot bg-ok" : status === "failed" || status === "stalled" ? "bg-[#e6a0a0]" : status.startsWith("paused") ? "bg-warn" : "bg-fg-faint";
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] text-fg-faint" role="status">
      <span className={cn("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

export function Header() {
  const setNavOpen = useRun((s) => s.setNavOpen);
  const meta = useRun((s) => s.meta);
  return (
    <header className="@container shrink-0 border-b border-line">
      <div className="flex h-12 items-center gap-3 px-3 sm:px-4">
        <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setNavOpen(true)} aria-label="Abrir missões">
          <Menu />
        </Button>
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate font-serif text-[19px] leading-none text-fg" title={meta?.title}>
            {meta?.title || "Missão"}
          </h1>
          {meta?.workspace && <span className="hidden truncate font-mono text-[11px] text-fg-faint @3xl:inline">{meta.workspace}</span>}
        </div>
        <RunState />
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden items-center gap-3 @7xl:flex">
            <ViewToggle pill="view-pill-wide" />
            <CriteriaMeter />
            <ModeBadge />
          </div>
          <RunControls />
        </div>
      </div>
      {/* abaixo de @6xl: segunda linha com vista, critérios e modo */}
      <div className="flex items-center gap-3 overflow-x-auto px-3 pb-2 [scrollbar-width:none] sm:px-4 @7xl:hidden">
        <ViewToggle pill="view-pill-narrow" />
        <CriteriaMeter />
        <ModeBadge className="ml-auto" />
      </div>
    </header>
  );
}

function Brand() {
  return (
    <div className="flex h-12 items-center gap-2 px-4">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" className="text-accent" aria-hidden>
        <circle cx="8" cy="8" r="2.4" fill="currentColor" />
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeOpacity=".45" strokeDasharray="2 2.6" />
      </svg>
      <span className="font-serif text-[20px] leading-none tracking-tight text-fg">shao</span>
      <span className="ml-auto font-mono text-[10px] text-fg-faint">local</span>
    </div>
  );
}

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

export function Sidebar({ className }: { className?: string }) {
  const mode = useRun((s) => s.mode);
  const meta = useRun((s) => s.meta);
  const runStatus = useRun((s) => s.runStatus);
  const runs = useBackend((s) => s.runs);
  const backend = useBackend((s) => s.state);
  const setNavOpen = useRun((s) => s.setNavOpen);
  const go = (fn: () => void) => () => {
    setNavOpen(false);
    fn();
  };
  return (
    <nav className={cn("flex h-full flex-col bg-ink-900", className)} aria-label="Missões">
      <Brand />
      <div className="px-3 pt-3">
        {mode === "real" && backend === "online" && (
          <Button variant="outline" size="sm" className="mb-4 w-full justify-start" onClick={go(openHome)}>
            <Plus className="size-3.5" /> Nova missão
          </Button>
        )}
        <h2 className="px-2 pb-2 text-[11px] uppercase tracking-[0.1em] text-fg-faint">{mode === "demo" ? "Demonstração" : "Missões"}</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {mode === "demo" ? (
          <div className="rounded-lg bg-white/[0.05] px-2.5 py-2.5 ring-1 ring-line" aria-current="page">
            <div className="text-[13.5px] text-fg">{meta?.title}</div>
            <div className="text-[11.5px] text-fg-faint">Cenário fictício · roteiro local</div>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {runs.length === 0 && <li className="px-2 py-2 text-[12px] text-fg-faint">{backend === "online" ? "Nenhuma missão ainda." : "Backend indisponível."}</li>}
            {runs.map((r) => {
              const active = meta?.runId === r.runId;
              const status = active ? runStatus : r.status;
              return (
                <li key={r.runId}>
                  <button
                    onClick={go(() => openRun({ runId: r.runId, title: r.title, workspace: r.workspace, createdAt: r.createdAt }))}
                    aria-current={active ? "page" : undefined}
                    className={cn("w-full rounded-lg px-2.5 py-2 text-left transition-colors", active ? "bg-white/[0.05] ring-1 ring-line" : "hover:bg-white/[0.03]")}
                  >
                    <div className="flex items-center gap-2 whitespace-nowrap text-[11.5px] text-fg-faint">
                      <span className={cn("size-1.5 shrink-0 rounded-full", status === "running" ? "bg-ok" : status.startsWith("paused") ? "bg-warn" : status === "failed" || status === "stalled" ? "bg-[#e6a0a0]" : "bg-white/20")} />
                      {RUN_STATUS_LABEL[status] ?? status}
                      <span className="ml-auto font-mono text-[10.5px]">{fmtDate(r.updatedAt || r.createdAt)}</span>
                    </div>
                    <div className={cn("mt-0.5 line-clamp-2 text-[13px]", active ? "text-fg" : "text-fg-muted")}>{r.title || r.runId}</div>
                    <div className="truncate font-mono text-[10.5px] text-fg-faint">{r.workspace}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="space-y-2 border-t border-line px-4 py-4 text-[11.5px] leading-relaxed text-fg-faint">
        {mode === "demo" ? (
          <>
            <p>Demo: agentes, falas, ações e evidências são simulados no navegador. Nada é executado.</p>
            <Button variant="ghost" size="sm" className="-ml-2.5" onClick={go(openHome)}>
              Sair da demo
            </Button>
          </>
        ) : (
          <>
            <p>Backend local · análise de código e laboratório próprio.</p>
            <Button variant="ghost" size="sm" className="-ml-2.5" onClick={go(openDemo)}>
              Abrir demonstração
            </Button>
          </>
        )}
      </div>
    </nav>
  );
}
