// Leitor SSE sobre fetch: aceita qualquer `event:` (o EventSource nativo só entrega tipos registrados)
// e reconecta com Last-Event-ID, que o backend resolve para seq e replays de forma exclusiva.
import type { EventEnvelope } from "../../../shared/contracts";
import { api } from "./client";

export type StreamState = "connecting" | "live" | "reconnecting" | "closed" | "error";

export interface StreamHandlers {
  onEvent: (env: EventEnvelope) => void;
  onState: (state: StreamState, detail?: string) => void;
}

export function openRunStream(runId: string, after: number, h: StreamHandlers) {
  const ctrl = new AbortController();
  let lastId: string | null = null;
  let attempt = 0;

  const run = async () => {
    while (!ctrl.signal.aborted) {
      h.onState(attempt ? "reconnecting" : "connecting");
      try {
        const res = await fetch(api.eventsUrl(runId, lastId ? undefined : after), {
          headers: { accept: "text/event-stream", ...(lastId ? { "last-event-id": lastId } : {}) },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          if (res.status === 404) {
            h.onState("error", "Run não encontrado no backend.");
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        h.onState("live");
        attempt = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx: number;
          while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(buf[idx] === "\r" ? idx + 4 : idx + 2);
            const data: string[] = [];
            let id: string | null = null;
            for (const line of frame.split(/\r?\n/)) {
              if (!line || line.startsWith(":")) continue;
              const colon = line.indexOf(":");
              const field = colon === -1 ? line : line.slice(0, colon);
              const val = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
              if (field === "data") data.push(val);
              else if (field === "id") id = val;
            }
            if (!data.length) continue;
            try {
              const env = JSON.parse(data.join("\n")) as EventEnvelope;
              lastId = id ?? env.id ?? lastId;
              h.onEvent(env);
            } catch {
              // frame malformado: ignora sem derrubar o stream
            }
          }
        }
        // servidor encerrou o stream (p.ex. run terminal); reconecta com Last-Event-ID para não perder nada
      } catch (e) {
        if (ctrl.signal.aborted) break;
        h.onState("reconnecting", e instanceof Error ? e.message : String(e));
      }
      attempt++;
      const wait = Math.min(15000, 500 * 2 ** Math.min(attempt, 5));
      await new Promise((r) => setTimeout(r, wait));
    }
    h.onState("closed");
  };
  void run();
  return () => ctrl.abort();
}
