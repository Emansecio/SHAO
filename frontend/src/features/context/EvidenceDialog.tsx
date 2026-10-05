import { useMemo } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Avatar, evidenceIcon } from "@/features/common";
import { clockLabel, useRun } from "@/store/run";

const PROVENANCE: Record<string, string> = {
  supervisor_verified: "verificada pelo supervisor",
  model_asserted: "afirmada pelo modelo (não verificada)",
  user_supplied: "fornecida por você",
};

export function EvidenceDialog() {
  const id = useRun((s) => s.openEvidence);
  const ev = useRun((s) => (id ? s.evidence[id] : undefined));
  const setOpen = useRun((s) => s.setOpenEvidence);
  const events = useRun((s) => s.events);
  const agents = useRun((s) => s.agents);
  const citations = useMemo(
    () => events.flatMap((e) => (e.type === "message.completed" && id && e.message.evidenceIds.includes(id) ? [e] : [])),
    [events, id],
  );
  const Icon = ev ? evidenceIcon(ev.kind) : null;
  const select = useRun((s) => s.selectAgent);

  return (
    <Dialog open={!!ev} onOpenChange={(o) => !o && setOpen(null)}>
      <DialogContent aria-describedby="evidence-desc">
        {ev && Icon && (
          <>
            <header className="border-b border-line px-5 pb-4 pt-5 pr-12">
              <div className="flex items-center gap-2 font-mono text-[11px] text-fg-faint">
                <Icon className="size-3.5" /> {ev.path}
              </div>
              <DialogTitle className="mt-1.5 font-serif text-[24px] font-normal leading-tight text-fg">{ev.title}</DialogTitle>
              <DialogDescription id="evidence-desc" className="mt-1 text-[13px] text-fg-muted">
                {ev.summary}
              </DialogDescription>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <pre className="overflow-x-auto bg-ink-950/60 px-5 py-4 font-mono text-[12px] leading-[1.7] text-fg/85">
                {ev.body.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith("+") ? "-mx-5 bg-ok/[0.07] px-5 text-[#b8e6d1]" : line.startsWith("-") ? "-mx-5 bg-[#e6a0a0]/[0.06] px-5 text-[#e8b4b4]" : line.startsWith("@@") ? "text-[#9db0f5]" : undefined
                    }
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
              <section className="px-5 py-4">
                <h3 className="mb-2 text-[11px] uppercase tracking-[0.08em] text-fg-faint">Citada em</h3>
                {citations.length === 0 && <p className="text-[12.5px] text-fg-faint">Ainda não citada em mensagens.</p>}
                <ul className="flex flex-col gap-2.5">
                  {citations.map((e) => (
                    <li key={e.eventId} className="flex gap-2.5">
                      <Avatar id={e.message.from} size={22} status={false} />
                      <div className="min-w-0 text-[12.5px]">
                        <button
                          className="font-medium hover:underline"
                          style={{ color: agents[e.message.from]?.hue }}
                          onClick={() => {
                            setOpen(null);
                            select(e.message.from);
                          }}
                        >
                          {agents[e.message.from]?.name ?? "Você"}
                        </button>
                        <span className="ml-2 font-mono text-[10.5px] text-fg-faint">{clockLabel(e.at)}</span>
                        <p className="text-fg-muted">{e.message.text}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
            <footer className="border-t border-line px-5 py-3 text-[11.5px] text-fg-faint">
              {ev.simulated ? (
                <>Artefato de demonstração por {agents[ev.agentId]?.name ?? ev.agentId} — conteúdo fictício; nenhum repositório ou ferramenta real foi acessado.</>
              ) : (
                <>
                  Publicada por {agents[ev.agentId]?.name ?? ev.agentId}
                  {ev.provenance && ` · ${PROVENANCE[ev.provenance] ?? ev.provenance}`}
                  {ev.sha256 && <span className="font-mono"> · sha256 {ev.sha256.slice(0, 16)}…</span>}
                  {ev.claims && ev.claims.length > 1 && ` · ${ev.claims.length} afirmações`}
                </>
              )}
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
