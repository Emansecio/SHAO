import { useMemo, type ReactNode } from "react";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import { controls } from "@/app/controls";
import { USER, type Message, type StreamingMessage } from "@/model/types";
import { useRun, type PendingHuman } from "@/store/run";

type ChatItem = Message | (StreamingMessage & { streaming: true }) | (PendingHuman & { pending: true });

function convert(m: ChatItem): ThreadMessageLike {
  if ("pending" in m) {
    return {
      id: m.localId,
      role: "user",
      content: [{ type: "text", text: m.text }],
      metadata: { custom: { pending: !m.error, error: m.error ?? null, clientMessageId: m.localId } },
    };
  }
  const streaming = "streaming" in m;
  return {
    id: m.messageId,
    role: m.from === USER ? "user" : "assistant",
    content: [{ type: "text", text: m.text }],
    status: m.from === USER ? undefined : streaming ? { type: "running" } : { type: "complete", reason: "stop" },
    metadata: {
      custom: {
        from: m.from,
        evidenceIds: m.evidenceIds,
        tone: m.tone ?? null,
        interrupted: !streaming && Boolean((m as Message).interrupted),
        at: streaming ? null : (m as Message).at,
      },
    },
  };
}

/**
 * Thread humano ↔ orquestrador sobre o mesmo store do run (real ou demo).
 * O runtime é único na raiz, então histórico e rascunho do composer sobrevivem à troca de vista.
 */
export function ChatRuntime({ children }: { children: ReactNode }) {
  const events = useRun((s) => s.events);
  const live = useRun(useShallow((s) => Object.values(s.streaming).filter((m) => m.channel === "chat")));
  const pending = useRun((s) => s.pendingHuman);
  const awaiting = useRun((s) => s.awaitingReply);
  // só cancelado não aceita continuação; concluído/falhou podem ser retomados pelo backend
  const closed = useRun((s) => (s.mode === "real" && (!s.meta || s.runStatus === "cancelled")) || s.replaying);

  const messages = useMemo<ChatItem[]>(() => {
    const done: ChatItem[] = [];
    for (const e of events) if (e.type === "message.completed" && e.message.channel === "chat") done.push(e.message);
    return [...done, ...pending.map((p) => ({ ...p, pending: true as const })), ...live.map((m) => ({ ...m, streaming: true as const }))];
  }, [events, live, pending]);

  const runtime = useExternalStoreRuntime<ChatItem>({
    messages,
    convertMessage: convert,
    isRunning: awaiting !== null,
    isDisabled: closed,
    onNew: async (msg) => {
      const text = msg.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
        .trim();
      if (text) controls.send(text);
    },
    onCancel: async () => controls.cancelReply(),
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
