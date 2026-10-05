import { AlertTriangle, Clock, KeyRound, PlugZap, Timer, X, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { IssueKind } from "@/model/types";
import { useRun } from "@/store/run";

const KIND: Record<IssueKind, { label: string; Icon: LucideIcon; cls: string }> = {
  unavailable: { label: "Runtime indisponível", Icon: PlugZap, cls: "text-warn" },
  quota: { label: "Quota atingida", Icon: Timer, cls: "text-warn" },
  auth: { label: "Autenticação necessária", Icon: KeyRound, cls: "text-warn" },
  stalled: { label: "Turno travado", Icon: Clock, cls: "text-warn" },
  error: { label: "Erro", Icon: AlertTriangle, cls: "text-[#e8b4b4]" },
};

const fmt = (iso?: string) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });
};

/** Estados honestos de runtime/erro/quota: visíveis, sem modal, dispensáveis. */
export function IssueBar() {
  const issues = useRun((s) => s.issues);
  const agents = useRun((s) => s.agents);
  const dismiss = useRun((s) => s.dismissIssue);
  const reason = useRun((s) => s.runReason);
  const status = useRun((s) => s.runStatus);
  const showReason = reason && (status === "failed" || status === "stalled" || status.startsWith("paused_"));
  if (!issues.length && !showReason) return null;
  return (
    <div className="shrink-0 border-b border-line bg-ink-900/70" role="alert" aria-live="polite">
      <AnimatePresence initial={false}>
        {showReason && (
          <div key="reason" className="flex items-center gap-2.5 px-4 py-2 text-[12.5px]">
            <AlertTriangle className="size-3.5 shrink-0 text-warn" />
            <span className="text-fg-muted">Run: {reason}</span>
          </div>
        )}
        {issues.slice(-3).map((i) => {
          const k = KIND[i.kind];
          const reset = fmt(i.resetAt);
          return (
            <motion.div
              key={i.id}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-start gap-2.5 px-4 py-2 text-[12.5px]"
            >
              <k.Icon className={`mt-0.5 size-3.5 shrink-0 ${k.cls}`} />
              <span className="min-w-0 flex-1">
                <span className={k.cls}>{k.label}</span>
                {i.runtime && <span className="ml-1.5 font-mono text-[11px] text-fg-faint">{i.runtime}</span>}
                {i.agentId && agents[i.agentId] && <span className="text-fg-faint"> · {agents[i.agentId].name}</span>}
                <span className="text-fg-muted"> — {i.message}</span>
                {reset && <span className="text-fg-faint"> · libera em {reset}</span>}
                {i.retryable && <span className="text-fg-faint"> · recuperável</span>}
              </span>
              <button onClick={() => dismiss(i.id)} className="grid size-5 shrink-0 place-items-center rounded text-fg-faint hover:bg-white/5 hover:text-fg" aria-label="Dispensar aviso">
                <X className="size-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
