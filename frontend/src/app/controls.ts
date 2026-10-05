// Ponto único que a UI usa para agir no run, conforme o modo (real por padrão, demo explícita).
import type { SpecialistProfile } from "../../../shared/contracts";
import { engine } from "@/demo/engine";
import { realSession } from "@/real/session";
import { useBackend } from "@/real/backend";
import { useRun, type RunMeta } from "@/store/run";

const isDemo = () => useRun.getState().mode === "demo";

export const controls = {
  send(text: string) {
    if (isDemo()) engine.human(text);
    else void realSession.send(text);
  },
  retrySend(clientMessageId: string) {
    if (!isDemo()) void realSession.retry(clientMessageId);
  },
  cancelReply() {
    if (isDemo()) engine.cancelReply();
    else void realSession.cancelTurn();
  },
  togglePause() {
    if (isDemo()) return engine.togglePause();
    const st = useRun.getState().runStatus;
    void realSession.control(st.startsWith("paused") ? "resume" : "pause");
  },
  cancelRun() {
    if (!isDemo()) void realSession.control("cancel");
  },
  /** Demo: reinicia o roteiro. Real: reproduz o histórico recebido e volta ao vivo. */
  restart() {
    if (isDemo()) engine.reset();
    else realSession.replay();
  },
  stopReplay() {
    realSession.stopReplay();
  },
  addDemoSpecialist(id: string) {
    engine.addSpecialist(id);
  },
  addSpecialist(name: string, profile: SpecialistProfile, scope?: string) {
    return realSession.addSpecialist(name, profile, scope);
  },
};

// ----- navegação (hash) -----

export function openRun(meta: RunMeta) {
  engine.stop();
  realSession.open(meta);
  setHash(`#/run/${encodeURIComponent(meta.runId)}`);
}

export function openHome() {
  engine.stop();
  realSession.close();
  useRun.getState().load("real", null);
  setHash("#/");
  void useBackend.getState().refreshRuns();
}

export function openDemo() {
  realSession.close();
  engine.stop();
  engine.start();
  setHash("#/demo");
}

function setHash(h: string) {
  if (location.hash !== h) history.replaceState(null, "", h);
}

/** Aplica a rota do hash: #/demo, #/run/<id> ou início. Idempotente. */
export async function route() {
  const hash = location.hash;
  const st = useRun.getState();
  if (hash === "#/demo") {
    if (st.mode !== "demo") openDemo();
    return;
  }
  const m = hash.match(/^#\/run\/(.+)$/);
  if (useBackend.getState().state !== "online") {
    // sem backend não há run real para abrir: sai da demo se o usuário navegou para fora dela
    if (st.mode === "demo") openHome();
    if (!(await useBackend.getState().check())) return;
  }
  await useBackend.getState().refreshRuns();
  if (m) {
    const runId = decodeURIComponent(m[1]);
    if (st.mode === "real" && st.meta?.runId === runId) return;
    const known = useBackend.getState().runs.find((r) => r.runId === runId);
    openRun({ runId, title: known?.title ?? runId, workspace: known?.workspace ?? "", createdAt: known?.createdAt ?? "" });
  } else if (st.mode === "demo" || st.meta) openHome();
}

/** Boot: rota inicial + navegação por hash (links, voltar/avançar, URL colada na mesma aba). */
export async function boot() {
  if (!bootstrapped) {
    bootstrapped = true;
    window.addEventListener("hashchange", () => void route());
  }
  await route();
}
let bootstrapped = false;
