import { useEffect } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatRuntime } from "@/features/chat/ChatRuntime";
import { ContextPanel } from "@/features/context/ContextPanel";
import { EvidenceDialog } from "@/features/context/EvidenceDialog";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Header, Sidebar } from "@/features/shell/Shell";
import { IssueBar } from "@/features/shell/Issues";
import { ConversationView, CouncilView } from "@/features/views";
import { Home, Offline } from "@/features/home/Home";
import { ReportView } from "@/features/report/Report";
import { boot } from "@/app/controls";
import { useBackend } from "@/real/backend";
import { useRun } from "@/store/run";

const ease = [0.22, 1, 0.36, 1] as const;

export default function App() {
  const view = useRun((s) => s.view);
  const panelOpen = useRun((s) => s.panelOpen);
  const navOpen = useRun((s) => s.navOpen);
  const setPanelOpen = useRun((s) => s.setPanelOpen);
  const setNavOpen = useRun((s) => s.setNavOpen);

  const inRun = useRun((s) => s.mode === "demo" || s.meta !== null);
  const backend = useBackend((s) => s.state);

  useEffect(() => {
    void boot();
  }, []);

  // sem backend: tenta de novo em silêncio até ele subir (nunca troca para demo sozinho)
  useEffect(() => {
    if (inRun || backend !== "offline") return;
    const t = setInterval(() => void boot(), 5000);
    return () => clearInterval(t);
  }, [inRun, backend]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || useRun.getState().openEvidence) return;
      setNavOpen(false);
      setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setNavOpen, setPanelOpen]);

  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <ChatRuntime>
          <div className="flex h-full overflow-hidden">
            <Sidebar className="hidden w-[232px] shrink-0 border-r border-line lg:flex" />

            <div className="flex min-w-0 flex-1 flex-col">
              {inRun ? (
                <>
                  <Header />
                  <IssueBar />
                  <main className="relative min-h-0 flex-1">
                    {/* troca imediata: a vista nova só faz fade-in, sem esperar saída da anterior */}
                    <motion.div
                      key={view}
                      className="absolute inset-0"
                      initial={{ opacity: 0.4 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.18, ease }}
                    >
                      {view === "conversa" ? <ConversationView /> : view === "conselho" ? <CouncilView /> : <ReportView />}
                    </motion.div>
                  </main>
                </>
              ) : (
                <>
                  <div className="flex h-12 shrink-0 items-center px-3 lg:hidden">
                    <Button variant="ghost" size="icon-sm" onClick={() => setNavOpen(true)} aria-label="Abrir missões">
                      <Menu />
                    </Button>
                    <span className="ml-2 font-serif text-[19px] text-fg">shao</span>
                  </div>
                  <main className="relative min-h-0 flex-1">{backend === "online" ? <Home /> : <Offline />}</main>
                </>
              )}
            </div>

            {/* largo: painel contextual docado */}
            <AnimatePresence initial={false}>
              {panelOpen && (
                <motion.div
                  key="ctx-docked"
                  className="hidden shrink-0 overflow-hidden border-l border-line wide:block"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 360, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.28, ease }}
                >
                  <ContextPanel className="w-[360px]" onClose={() => setPanelOpen(false)} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* demais larguras: painel sobreposto */}
          <AnimatePresence>
            {panelOpen && (
              <div className="wide:hidden">
                <motion.button
                  key="ctx-scrim"
                  aria-label="Fechar painel do agente"
                  className="fixed inset-0 z-30 bg-black/50"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setPanelOpen(false)}
                />
                <motion.div
                  key="ctx-sheet"
                  className="fixed inset-y-0 right-0 z-40 w-[min(380px,92vw)] border-l border-line-strong shadow-2xl shadow-black/60"
                  initial={{ x: "100%" }}
                  animate={{ x: 0 }}
                  exit={{ x: "100%" }}
                  transition={{ duration: 0.3, ease }}
                >
                  <ContextPanel onClose={() => setPanelOpen(false)} />
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {navOpen && (
              <div className="lg:hidden">
                <motion.button
                  aria-label="Fechar missões"
                  className="fixed inset-0 z-30 bg-black/50"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setNavOpen(false)}
                />
                <motion.div
                  className="fixed inset-y-0 left-0 z-40 w-[260px] border-r border-line-strong shadow-2xl shadow-black/60"
                  initial={{ x: "-100%" }}
                  animate={{ x: 0 }}
                  exit={{ x: "-100%" }}
                  transition={{ duration: 0.28, ease }}
                >
                  <Sidebar />
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          <EvidenceDialog />
        </ChatRuntime>
      </TooltipProvider>
    </MotionConfig>
  );
}
