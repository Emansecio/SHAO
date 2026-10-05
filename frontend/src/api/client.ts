// Cliente HTTP do backend local SHAO. Contrato: D:/SHAO/shared (README + contracts.ts).
// Same-origin por padrão; em dev o Vite faz proxy de /api.
import type {
  AcceptedMessage,
  AgentMessage,
  ArtifactResponse,
  ControlResponse,
  CreateRunRequest,
  ExportResponse,
  HealthResponse,
  RunProjection,
  RunResponse,
  RunSummary,
  SpecialistRequest,
  SpecialistResponse,
} from "../../../shared/contracts";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const BASE = "api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    });
  } catch (e) {
    throw new ApiError("network", e instanceof Error ? e.message : "Falha de rede", 0, true);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; retryable?: boolean } } | null)?.error;
    throw new ApiError(err?.code ?? `http_${res.status}`, err?.message ?? (typeof body === "string" && body ? body : res.statusText), res.status, err?.retryable ?? res.status >= 500);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const api = {
  health: () => request<HealthResponse>("/health"),
  listRuns: () => request<RunSummary[]>("/runs"),
  getRun: (runId: string) => request<RunProjection>(`/runs/${enc(runId)}`),
  createRun: (body: CreateRunRequest) => request<RunResponse>("/runs", json(body)),
  sendMessage: (runId: string, body: AgentMessage) => request<AcceptedMessage>(`/runs/${enc(runId)}/messages`, json(body)),
  control: (runId: string, action: "pause" | "resume" | "cancel") => request<ControlResponse>(`/runs/${enc(runId)}/control`, json({ action })),
  cancelTurn: (runId: string, turnId: string) => request<unknown>(`/runs/${enc(runId)}/turns/${enc(turnId)}/cancel`, { method: "POST" }),
  addSpecialist: (runId: string, body: SpecialistRequest) => request<SpecialistResponse>(`/runs/${enc(runId)}/specialists`, json(body)),
  artifact: (runId: string, artifactId: string) => request<ArtifactResponse>(`/runs/${enc(runId)}/artifacts/${enc(artifactId)}`),
  artifactUrl: (runId: string, artifactId: string) => `${BASE}/runs/${enc(runId)}/artifacts/${enc(artifactId)}`,
  reportUrl: (runId: string, format: "json" | "markdown") => `${BASE}/runs/${enc(runId)}/report?format=${format}`,
  exportRun: (runId: string, format: "json" | "markdown") => request<ExportResponse>(`/runs/${enc(runId)}/export?format=${format}`),
  exportUrl: (runId: string, format: "json" | "markdown") => `${BASE}/runs/${enc(runId)}/export?format=${format}`,
  report: async (runId: string) => {
    const res = await fetch(`${BASE}/runs/${enc(runId)}/report?format=markdown`);
    if (!res.ok) throw new ApiError(`http_${res.status}`, res.statusText, res.status);
    return res.text();
  },
  eventsUrl: (runId: string, after?: number) => `${BASE}/runs/${enc(runId)}/events${after ? `?after=${after}` : ""}`,
};
