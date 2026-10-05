import { ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { ArrowDown, ArrowUp, Pause, Square } from "lucide-react";
import { motion } from "motion/react";
import { Avatar, EvidenceChip, ToneTag, useParticipant } from "@/features/common";
import { ORCH, type Tone } from "@/model/types";
import { RUN_STATUS_LABEL, clockLabel, isTerminal, useRun } from "@/store/run";
import { cn } from "@/lib/utils";
import { Markdown } from "@/features/report/Markdown";
import { controls } from "@/app/controls";

const MarkdownText = ({ text }: { text: string }) => <Markdown text={text} />;

type Custom = { clientMessageId?: string; from?: string; evidenceIds?: string[]; tone?: Tone | null; interrupted?: boolean; at?: number | null; pending?: boolean; error?: string | null };

const SUGGESTIONS = {
  demo: [
    { label: "Prefiro importação parcial", prompt: "Prefiro importação parcial, com relatório por linha." },
    { label: "Chame um especialista de produto", prompt: "Chame um especialista de produto para propor o contrato." },
    { label: "Resuma o estado", prompt: "Resuma o estado da revisão." },
  ],
  real: [
    { label: "Resuma o estado", prompt: "Resuma o estado atual da missão e o que falta." },
    { label: "Quais riscos estão abertos?", prompt: "Quais riscos e divergências continuam abertos?" },
    { label: "Mostre as evidências", prompt: "Liste as evidências que sustentam as conclusões até agora." },
  ],
};

export function OrchestratorChat({ compact = false }: { compact?: boolean }) {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ThreadPrimitive.Viewport
        className={cn("relative min-h-0 flex-1 overflow-y-auto", compact ? "px-4" : "px-5 sm:px-8")}
        autoScroll
      >
        <div className={cn("mx-auto flex w-full flex-col pt-5 pb-6", compact ? "gap-5" : "max-w-[680px] gap-6 pt-8")}>
          <ThreadPrimitive.Messages>{({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage compact={compact} />)}</ThreadPrimitive.Messages>
        </div>
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 flex justify-center pb-2">
          <ThreadPrimitive.ScrollToBottom
            className="grid size-7 place-items-center rounded-full border border-line-strong bg-ink-850 text-fg-muted shadow-lg transition-opacity hover:text-fg disabled:pointer-events-none disabled:opacity-0"
            aria-label="Ir para a última mensagem"
          >
            <ArrowDown className="size-3.5" />
          </ThreadPrimitive.ScrollToBottom>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
      <Composer compact={compact} />
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  const custom = useAuiState((s) => s.message.metadata.custom) as Custom;
  return (
    <MessagePrimitive.Root className="flex flex-col items-end gap-1">
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          "max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.07] px-3.5 py-2 text-[14px] leading-relaxed text-fg",
          custom?.pending && "opacity-70",
          custom?.error && "ring-1 ring-[#e6a0a0]/50",
        )}
      >
        <MessagePrimitive.Parts />
      </motion.div>
      {custom?.pending && <span className="text-[11px] text-fg-faint">enviando…</span>}
      {custom?.error && (
        <span className="flex items-center gap-2 text-[11px] text-[#e8b4b4]">
          não enviada — {custom.error}
          {custom.clientMessageId && (
            <button className="text-fg-muted underline underline-offset-2 hover:text-fg" onClick={() => controls.retrySend(custom.clientMessageId!)}>
              tentar de novo
            </button>
          )}
        </span>
      )}
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({ compact }: { compact: boolean }) {
  const custom = useAuiState((s) => s.message.metadata.custom) as Custom;
  const running = useAuiState((s) => s.message.status?.type === "running");
  const from = custom?.from ?? ORCH;
  const p = useParticipant(from);
  return (
    <MessagePrimitive.Root className="group flex gap-3">
      <Avatar id={from} size={compact ? 24 : 28} status={false} className="mt-0.5" />
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="min-w-0 flex-1"
      >
        <div className="mb-1 flex items-center gap-2 text-[12px]">
          <span className="font-medium" style={{ color: p.hue }}>{p.name}</span>
          <ToneTag tone={custom?.tone ?? undefined} />
          <span className="font-mono text-[10.5px] text-fg-faint tabular">{custom?.at != null ? clockLabel(custom.at) : "escrevendo…"}</span>
        </div>
        <div className={cn("text-[14px] leading-[1.65] text-fg/90 [&_p]:my-0 [&_p+p]:mt-2", compact && "text-[13.5px]")}>
          {running ? <MessagePrimitive.Parts /> : <MessagePrimitive.Parts components={{ Text: MarkdownText }} />}
          {custom?.interrupted && <span className="ml-1 text-[12px] text-fg-faint">— interrompida</span>}
        </div>
        {!running && custom?.evidenceIds && custom.evidenceIds.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {custom.evidenceIds.map((id) => (
              <EvidenceChip key={id} id={id} />
            ))}
          </div>
        )}
      </motion.div>
    </MessagePrimitive.Root>
  );
}

function Composer({ compact }: { compact: boolean }) {
  const mode = useRun((s) => s.mode);
  const paused = useRun((s) => (s.mode === "demo" ? s.paused : s.runStatus.startsWith("paused")));
  const status = useRun((s) => s.runStatus);
  const replaying = useRun((s) => s.replaying);
  const awaiting = useRun((s) => s.awaitingReply);
  const closed = mode === "real" && status === "cancelled";
  const ended = mode === "real" && (isTerminal(status) || status === "stalled") && !closed;
  return (
    <div className={cn("shrink-0 pb-3", compact ? "px-3" : "px-4 sm:px-8 sm:pb-5")}>
      <div className={cn("mx-auto w-full", !compact && "max-w-[680px]")}>
        <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
          {!closed && SUGGESTIONS[mode].map((s) => (
            <ThreadPrimitive.Suggestion
              key={s.label}
              prompt={s.prompt}
              send
              className="shrink-0 rounded-full border border-line-strong px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:border-white/20 hover:bg-white/[0.04] hover:text-fg disabled:opacity-40"
            >
              {s.label}
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
        <ComposerPrimitive.Root className="group/composer relative flex items-end gap-2 rounded-xl border border-line-strong bg-ink-850 p-1.5 pl-3.5 transition-colors focus-within:border-white/20 focus-within:bg-ink-800">
          <ComposerPrimitive.Input
            rows={1}
            autoFocus={!compact}
            placeholder={closed ? `Run ${RUN_STATUS_LABEL[status] ?? status} — abra uma nova missão para continuar` : replaying ? "Reproduzindo histórico…" : "Oriente o orquestrador…"}
            aria-label="Mensagem para o orquestrador"
            className="max-h-36 min-h-[34px] flex-1 resize-none bg-transparent py-[7px] text-[14px] leading-[1.45] text-fg outline-none placeholder:text-fg-faint"
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-fg text-ink-950 transition-[opacity,background] hover:bg-white disabled:bg-white/10 disabled:text-fg-faint"
              aria-label="Enviar"
            >
              <ArrowUp className="size-4" />
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-fg transition-colors hover:bg-white/15"
              aria-label="Interromper resposta"
            >
              <Square className="size-3 fill-current" />
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
        <p className="mt-1.5 flex items-center gap-1.5 px-1 text-[11px] text-fg-faint">
          {paused && awaiting ? (
            <>
              <Pause className="size-3" /> Run pausado — a resposta continua ao retomar.
            </>
          ) : ended ? (
            <span>Run {RUN_STATUS_LABEL[status] ?? status} — uma nova mensagem pede ao orquestrador para continuar; a resposta chega aqui.</span>
          ) : mode === "real" && status.startsWith("paused_") ? (
            <span className="text-warn">
              Run {RUN_STATUS_LABEL[status] ?? status}: mensagens ficam registradas, mas o orquestrador não está respondendo agora.
            </span>
          ) : mode === "demo" ? (
            <>Demo: respostas roteirizadas no navegador · nenhum modelo é chamado.</>
          ) : (
            <>Mensagem vai ao orquestrador do backend local; respostas chegam pelo stream do run.</>
          )}
        </p>
      </div>
    </div>
  );
}
