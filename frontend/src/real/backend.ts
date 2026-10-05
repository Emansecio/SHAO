// Descoberta do backend local e histórico de runs. Nada é presumido: o estado vem de /api/health.
import { create } from "zustand";
import type { RuntimeAvailability, RunSummary } from "../../../shared/contracts";
import { api, ApiError } from "@/api/client";

type BackendState = "checking" | "online" | "offline";

interface Backend {
  state: BackendState;
  version?: string;
  runtimes: RuntimeAvailability[];
  error?: string;
  httpStatus?: number; // 0 = sem resposta; >0 = backend respondeu com erro
  runs: RunSummary[];
  runsError?: string;
  check: () => Promise<boolean>;
  refreshRuns: () => Promise<void>;
}

export const useBackend = create<Backend>()((set) => ({
  state: "checking",
  runtimes: [],
  runs: [],
  check: async () => {
    try {
      const h = await api.health();
      set({
        state: h.status === "ok" ? "online" : "offline",
        version: h.version,
        runtimes: Array.isArray(h.capabilities) ? h.capabilities : [],
        error: h.status === "ok" ? undefined : `health: ${h.status}`,
        httpStatus: undefined,
      });
      return h.status === "ok";
    } catch (e) {
      set({ state: "offline", error: e instanceof ApiError ? `${e.message} (${e.code})` : String(e), httpStatus: e instanceof ApiError ? e.status : 0 });
      return false;
    }
  },
  refreshRuns: async () => {
    try {
      const runs = await api.listRuns();
      set({ runs: Array.isArray(runs) ? runs : [], runsError: undefined });
    } catch (e) {
      set({ runsError: e instanceof ApiError ? e.message : String(e) });
    }
  },
}));
