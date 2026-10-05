import { lazy, Suspense, useState } from "react";
import { MessagesSquare, PanelRightClose, PanelRightOpen } from "lucide-react";
import { OrchestratorChat } from "@/features/chat/OrchestratorChat";
import { GraphLegend } from "@/features/council/GraphLegend";

// React Flow só carrega quando a vista Conselho abre
const CouncilGraph = lazy(() => import("@/features/council/CouncilGraph").then((m) => ({ default: m.CouncilGraph })));
import { Timeline, TimelineFilters } from "@/features/council/Timeline";
import { AddSpecialist, CriteriaList, TeamList, TeamStrip } from "@/features/team/Team";
import { Avatar } from "@/features/common";
import { Button } from "@/components/ui/button";
import { useRun } from "@/store/run";
import { cn } from "@/lib/utils";

const eyebrow = "text-[11px] uppercase tracking-[0.1em] text-fg-faint";

/** Conversa: o chat com o orquestrador em destaque; equipe compacta ao lado. */
export function ConversationView() {
  return (
    <div className="flex h-full min-h-0 flex-col md:grid md:grid-cols-[minmax(0,1fr)_292px] lg:grid-cols-[minmax(0,1fr)_312px]">
      <TeamStrip className="shrink-0 border-b border-line px-3 py-1.5 md:hidden" />
      <section className="flex min-h-0 flex-1 flex-col" aria-label="Conversa com o orquestrador">
        <OrchestratorChat />
      </section>
      <aside className="hidden min-h-0 flex-col overflow-y-auto border-l border-line md:flex" aria-label="Equipe e critérios">
        <div className="px-3 pt-5">
          <div className="flex items-baseline justify-between px-2.5 pb-2">
            <h2 className={eyebrow}>Equipe</h2>
            <TeamCount />
          </div>
          <TeamList />
          <div className="mt-1 px-0.5">
            <AddSpecialist />
          </div>
        </div>
        <div className="mx-5 my-5 h-px bg-line" />
        <div className="px-5 pb-6">
          <h2 className={cn(eyebrow, "mb-3")}>Critérios da revisão</h2>
          <CriteriaList />
        </div>
      </aside>
    </div>
  );
}

function TeamCount() {
  const n = useRun((s) => s.agentOrder.length);
  const speaking = useRun((s) => new Set(Object.values(s.streaming).map((m) => m.from)).size);
  return (
    <span className="font-mono text-[10.5px] text-fg-faint tabular">
      {n} agentes{speaking ? ` · ${speaking} falando` : ""}
    </span>
  );
}

/** Conselho: grafo grande + timeline entre pares; chat humano↔orquestrador em dock. */
export function CouncilView() {
  const [dockOpen, setDockOpen] = useState(true);
  const [narrowTab, setNarrowTab] = useState<"timeline" | "chat">("timeline");
  return (
    <div className={cn("flex h-full min-h-0 flex-col md:grid", dockOpen ? "md:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]" : "md:grid-cols-[minmax(0,1fr)_52px]")}>
      <div className="flex min-h-0 flex-1 flex-col">
        <section className="relative h-[46%] min-h-[240px] shrink-0 border-b border-line md:h-auto md:min-h-0 md:flex-[1.15]" aria-label="Grafo do conselho">
          <Suspense fallback={<div className="grid h-full place-items-center text-[12px] text-fg-faint">carregando grafo…</div>}>
            <CouncilGraph />
          </Suspense>
          <div className="pointer-events-none absolute left-4 right-14 top-3 space-y-1">
            <div className="flex items-baseline gap-3">
              <h2 className={eyebrow}>Conselho</h2>
              <p className="hidden truncate text-[11.5px] text-fg-faint sm:block">clique num agente para ver mensagens e ações</p>
            </div>
            <GraphLegend />
          </div>
          <div className="absolute right-3 top-3">
            <AddSpecialist compact />
          </div>
        </section>

        {/* estreito: alterna timeline e chat no mesmo espaço */}
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5 md:hidden" role="tablist">
          {(["timeline", "chat"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={narrowTab === t}
              onClick={() => setNarrowTab(t)}
              className={cn("rounded-md px-2.5 py-1 text-[12.5px]", narrowTab === t ? "bg-white/[0.07] text-fg" : "text-fg-faint")}
            >
              {t === "timeline" ? "Timeline entre pares" : "Chat com orquestrador"}
            </button>
          ))}
        </div>

        <section className={cn("min-h-0 flex-1 flex-col", narrowTab === "timeline" ? "flex" : "hidden md:flex")} aria-label="Timeline">
          <TimelineFilters className="shrink-0 border-b border-line px-4 py-2 sm:px-5" />
          <Timeline className="flex-1" />
        </section>
        <section className={cn("min-h-0 flex-1 flex-col md:hidden", narrowTab === "chat" ? "flex" : "hidden")} aria-label="Chat com o orquestrador">
          {narrowTab === "chat" && <OrchestratorChat compact />}
        </section>
      </div>

      <aside className="hidden min-h-0 flex-col border-l border-line bg-ink-900/60 md:flex" aria-label="Chat com o orquestrador">
        {dockOpen ? (
          <>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
              <Avatar id="orchestrator" size={20} status={false} />
              <span className="text-[12.5px] text-fg">Orquestrador</span>
              <span className="text-[11.5px] text-fg-faint">· seu canal</span>
              <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => setDockOpen(false)} aria-label="Recolher chat">
                <PanelRightClose />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <OrchestratorChat compact />
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 pt-2">
            <Button variant="ghost" size="icon-sm" onClick={() => setDockOpen(true)} aria-label="Abrir chat com o orquestrador">
              <PanelRightOpen />
            </Button>
            <button onClick={() => setDockOpen(true)} className="grid size-8 place-items-center rounded-md text-fg-faint hover:text-fg" aria-label="Abrir chat">
              <MessagesSquare className="size-4" />
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
