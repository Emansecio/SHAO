import { useEffect, useMemo, useState } from "react";
import { Download, FileBox, ListChecks, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError } from "@/api/client";
import { Avatar, EvidenceChip } from "@/features/common";
import { CriteriaList } from "@/features/team/Team";
import { Markdown } from "@/features/report/Markdown";
import { RUN_STATUS_LABEL, isTerminal, useRun } from "@/store/run";
import { cn } from "@/lib/utils";

const eyebrow = "text-[11px] uppercase tracking-[0.1em] text-fg-faint";

const TASK_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "pendente", cls: "text-fg-faint" },
  ready: { label: "pronta", cls: "text-fg-muted" },
  running: { label: "em execução", cls: "text-ok" },
  review: { label: "em revisão", cls: "text-[#9db0f5]" },
  blocked: { label: "bloqueada", cls: "text-warn" },
  completed: { label: "concluída", cls: "text-ok" },
  failed: { label: "falhou", cls: "text-[#e8b4b4]" },
  cancelled: { label: "cancelada", cls: "text-fg-faint" },
};

const PROVENANCE: Record<string, string> = {
  supervisor_verified: "verificada pelo supervisor",
  model_asserted: "afirmada pelo modelo",
  user_supplied: "fornecida por você",
};

function FullReport() {
  const runId = useRun((s) => s.meta?.runId);
  const revision = useRun((s) => s.report?.revision);
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (!runId) return;
    setLoading(true);
    setErr(null);
    try {
      setMd(await api.report(runId));
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message} (${e.code})` : String(e));
    } finally {
      setLoading(false);
    }
  };
  // recarrega quando o backend publica nova revisão
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, revision]);
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className={eyebrow}>Relatório atual</h2>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> {md ? "Atualizar" : "Carregar"}
        </Button>
      </div>
      {err && <p className="text-[12.5px] text-warn">Relatório indisponível: {err}</p>}
      {md ? (
        <div className="rounded-xl border border-line bg-ink-900/60 px-5 py-4">
          <Markdown text={md} />
        </div>
      ) : (
        !err && <p className="text-[12.5px] text-fg-faint">{revision == null ? "O backend ainda não publicou relatório para este run." : "Carregando…"}</p>
      )}
    </section>
  );
}

function ArtifactDialog() {
  const id = useRun((s) => s.openArtifact);
  const artifact = useRun((s) => (id ? s.artifacts[id] : undefined));
  const runId = useRun((s) => s.meta?.runId);
  const close = useRun((s) => s.setOpenArtifact);
  const [content, setContent] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ sha256?: string; downloadUrl?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setContent(null);
    setMeta(null);
    setErr(null);
    if (!id || !runId) return;
    let alive = true;
    api
      .artifact(runId, id)
      .then(async (a) => {
        if (!alive) return;
        setMeta({ sha256: a.sha256, downloadUrl: a.downloadUrl });
        if (a.content != null) return setContent(a.content);
        // sem conteúdo inline: baixa se for pequeno e textual (o backend reconfere containment/SHA-256)
        if (!a.downloadUrl || a.size > 512 * 1024) return;
        const res = await fetch(a.downloadUrl.replace(/^\//, ""));
        if (!res.ok) throw new ApiError(`http_${res.status}`, res.statusText, res.status);
        const text = await res.text();
        if (alive && !text.includes("\u0000")) setContent(text);
      })
      .catch((e) => alive && setErr(e instanceof ApiError ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id, runId]);
  return (
    <Dialog open={!!artifact} onOpenChange={(o) => !o && close(null)}>
      <DialogContent aria-describedby="artifact-desc">
        {artifact && runId && (
          <>
            <header className="border-b border-line px-5 pb-4 pt-5 pr-12">
              <div className="font-mono text-[11px] text-fg-faint">
                {artifact.mime} · {formatSize(artifact.size)}
                {meta?.sha256 && <> · sha256 {meta.sha256.slice(0, 12)}…</>}
              </div>
              <DialogTitle className="mt-1.5 font-serif text-[24px] font-normal leading-tight text-fg">{artifact.name}</DialogTitle>
              <DialogDescription id="artifact-desc" className="mt-1 text-[12.5px] text-fg-muted">
                Publicado no run; conteúdo lido do backend local.
              </DialogDescription>
            </header>
            <div className="min-h-0 flex-1 overflow-auto">
              {err && <p className="px-5 py-4 text-[12.5px] text-warn">Não foi possível ler: {err}</p>}
              {content != null ? (
                artifact.mime.includes("markdown") ? (
                  <div className="px-5 py-4">
                    <Markdown text={content} />
                  </div>
                ) : (
                  <pre className="px-5 py-4 font-mono text-[12px] leading-[1.7] whitespace-pre-wrap text-fg/85">{content}</pre>
                )
              ) : (
                !err && <p className="px-5 py-4 text-[12.5px] text-fg-faint">Sem conteúdo textual inline.</p>
              )}
            </div>
            <footer className="border-t border-line px-5 py-3">
              <a
                className="text-[12px] text-accent hover:underline"
                href={meta?.downloadUrl ? meta.downloadUrl.replace(/^\//, "") : api.artifactUrl(runId, artifact.artifactId)}
                target="_blank"
                rel="noreferrer"
              >
                {meta?.downloadUrl ? "Baixar arquivo" : "Abrir resposta bruta"}
              </a>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Exportação vem como {runId, format, content}: baixa o conteúdo como arquivo de verdade. */
async function downloadExport(runId: string, format: "markdown" | "json") {
  try {
    const res = await api.exportRun(runId, format);
    const blob = new Blob([res.content], { type: format === "markdown" ? "text/markdown;charset=utf-8" : "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${runId}.${format === "markdown" ? "md" : "json"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError("unknown", String(e), 0);
    const id = `export:${Date.now()}`;
    useRun.getState().emit({ type: "issue.raised", issue: { id, kind: "error", message: `Exportação falhou: ${err.message} (${err.code})` } }, { seq: useRun.getState().seq, eventId: id });
  }
}

function formatSize(n: number) {
  if (!Number.isFinite(n)) return "tamanho desconhecido";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ReportView() {
  const mode = useRun((s) => s.mode);
  const runId = useRun((s) => s.meta?.runId);
  const report = useRun((s) => s.report);
  const tasksMap = useRun((s) => s.tasks);
  const evidenceMap = useRun((s) => s.evidence);
  const artifactsMap = useRun((s) => s.artifacts);
  const agents = useRun((s) => s.agents);
  const criteria = useRun((s) => s.criteria);
  const openArtifact = useRun((s) => s.setOpenArtifact);
  const tasks = useMemo(() => Object.values(tasksMap), [tasksMap]);
  const evidence = useMemo(() => Object.values(evidenceMap), [evidenceMap]);
  const artifacts = useMemo(() => Object.values(artifactsMap), [artifactsMap]);
  const met = criteria.filter((c) => c.state === "met").length;
  const runStatus = useRun((s) => s.runStatus);
  const runReason = useRun((s) => s.runReason);
  // run encerrado: o relatório atual (GET) é a fonte; o resumo do último evento é histórico
  const ended = mode === "real" && isTerminal(runStatus);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[860px] flex-col gap-9 px-5 py-8 sm:px-8">
        <header>
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="font-serif text-[30px] leading-tight text-fg">Relatório</h1>
            {report && !ended && <span className="font-mono text-[11px] text-fg-faint">revisão {report.revision}</span>}
            {mode === "real" && runId && (
              <div className="ml-auto flex gap-1.5">
                {(["markdown", "json"] as const).map((f) => (
                  <Button key={f} variant="outline" size="sm" onClick={() => void downloadExport(runId, f)}>
                    <Download className="size-3.5" /> {f === "markdown" ? "Markdown" : "JSON + eventos"}
                  </Button>
                ))}
              </div>
            )}
          </div>
          {ended ? (
            <div className="mt-3 max-w-[70ch]">
              <p className="text-[14px] text-fg">
                Run {RUN_STATUS_LABEL[runStatus] ?? runStatus}
                {runReason && <span className="text-fg-muted"> — {runReason}</span>}
              </p>
              {report?.summary && (
                <details className="mt-2 text-fg-muted">
                  <summary className="cursor-pointer text-[12px] text-fg-faint hover:text-fg-muted">
                    Último resumo publicado por agente (rev. {report.revision}) · histórico, pode estar desatualizado
                  </summary>
                  <div className="mt-2 border-l border-line pl-3 [&_p]:text-[13px]">
                    <Markdown text={report.summary} />
                  </div>
                </details>
              )}
            </div>
          ) : report?.summary ? (
            <div className="mt-3 max-w-[70ch] text-fg-muted [&_p]:text-[14px]">
              <Markdown text={report.summary} />
            </div>
          ) : (
          <p className="mt-3 max-w-[65ch] text-[14px] leading-relaxed text-fg-muted">
            {report?.summary ??
              (mode === "demo"
                ? `Demo: ${met} de ${criteria.length} critérios cobertos. Relatório roteirizado, sem análise real.`
                : "Sem resumo publicado ainda. O resumo aparece aqui quando o orquestrador atualiza o relatório.")}
          </p>
          )}
        </header>

        {ended && <FullReport />}

        <section>
          <h2 className={cn(eyebrow, "mb-3")}>
            Critérios · {met}/{criteria.length}
          </h2>
          {criteria.length ? <CriteriaList /> : <p className="text-[12.5px] text-fg-faint">Nenhum critério definido.</p>}
        </section>

        <section>
          <h2 className={cn(eyebrow, "mb-3 flex items-center gap-1.5")}>
            <ListChecks className="size-3.5" /> Tarefas · {tasks.length}
          </h2>
          {tasks.length === 0 && <p className="text-[12.5px] text-fg-faint">{mode === "demo" ? "A demo não modela tarefas." : "Nenhuma tarefa publicada."}</p>}
          <ul className="flex flex-col divide-y divide-line">
            {tasks.map((t) => {
              const st = TASK_STATUS[t.status] ?? { label: t.status, cls: "text-fg-muted" };
              return (
                <li key={t.taskId} className="flex gap-3 py-3">
                  {t.assigneeId && agents[t.assigneeId] ? <Avatar id={t.assigneeId} size={24} status={false} className="mt-0.5" /> : <span className="size-6" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[13.5px] text-fg">{t.title}</span>
                      <span className={cn("ml-auto shrink-0 text-[11.5px]", st.cls)}>{st.label}</span>
                    </div>
                    <p className="text-[12.5px] text-fg-muted">{t.objective}</p>
                    {t.result && <p className="mt-1 text-[12.5px] text-fg/80">→ {t.result}</p>}
                    <p className="mt-0.5 text-[11.5px] text-fg-faint">
                      {t.assigneeId ? `responsável ${agents[t.assigneeId]?.name ?? t.assigneeId}` : "sem responsável"}
                      {t.reviewerId && ` · revisão ${agents[t.reviewerId]?.name ?? t.reviewerId}`}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h2 className={cn(eyebrow, "mb-3")}>Evidências · {evidence.length}</h2>
          {evidence.length === 0 && <p className="text-[12.5px] text-fg-faint">Nenhuma evidência publicada.</p>}
          <ul className="flex flex-col gap-2.5">
            {evidence.map((e) => (
              <li key={e.evidenceId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <EvidenceChip id={e.evidenceId} />
                <span className="text-[11.5px] text-fg-faint">
                  {agents[e.agentId]?.name ?? e.agentId}
                  {e.provenance && ` · ${PROVENANCE[e.provenance] ?? e.provenance}`}
                  {e.sha256 && <span className="font-mono"> · sha256 {e.sha256.slice(0, 10)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className={cn(eyebrow, "mb-3")}>Artefatos · {artifacts.length}</h2>
          {artifacts.length === 0 && <p className="text-[12.5px] text-fg-faint">Nenhum artefato publicado.</p>}
          <ul className="flex flex-col gap-1">
            {artifacts.map((a) => (
              <li key={a.artifactId}>
                <button onClick={() => openArtifact(a.artifactId)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-white/[0.04]">
                  <FileBox className="size-4 text-fg-faint" />
                  <span className="text-[13px] text-fg">{a.name}</span>
                  <span className="ml-auto font-mono text-[11px] text-fg-faint">
                    {a.mime} · {formatSize(a.size)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {mode === "real" && !ended && <FullReport />}
      </div>
      <ArtifactDialog />
    </div>
  );
}
