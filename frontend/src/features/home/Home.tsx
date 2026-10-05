import { useState } from "react";
import { ArrowRight, FolderOpen, Plus, RefreshCw, X } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/api/client";
import { openDemo, openRun } from "@/app/controls";
import { useBackend } from "@/real/backend";
import { RUN_STATUS_LABEL } from "@/store/run";
import { cn } from "@/lib/utils";

const ease = [0.22, 1, 0.36, 1] as const;

function Runtimes() {
  const runtimes = useBackend((s) => s.runtimes);
  if (!runtimes.length) return <p className="text-[12.5px] text-fg-faint">O backend não informou runtimes.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {runtimes.map((r) => {
        const ok = r.available && r.auth === "ready";
        const label = !r.available ? "indisponível" : r.auth === "missing" ? "sem autenticação" : r.auth === "unknown" ? "autenticação não verificada" : "pronto";
        return (
          <li key={r.runtime} className="flex items-start gap-2.5">
            <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", ok ? "bg-ok" : r.available ? "bg-warn" : "bg-[#e6a0a0]")} />
            <span className="min-w-0">
              <span className="flex items-baseline gap-2 whitespace-nowrap">
                <span className="font-mono text-[12px] text-fg">{r.runtime}</span>
                <span className={cn("text-[12px]", ok ? "text-fg-muted" : "text-warn")}>{label}</span>
              </span>
              {r.mode && <span className="block font-mono text-[10.5px] leading-snug text-fg-faint">{r.mode}</span>}
              {r.reason && <span className="block text-[11.5px] leading-snug text-fg-faint">{r.reason}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function Home() {
  const runs = useBackend((s) => s.runs);
  const runsError = useBackend((s) => s.runsError);
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState(() => localStorage.getItem("shao.workspace") ?? "");
  const [criteria, setCriteria] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || !workspace.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const list = criteria.map((c) => c.trim()).filter(Boolean);
      const res = await api.createRun({
        prompt: prompt.trim(),
        workspace: workspace.trim(),
        ...(list.length ? { criteria: list.map((description, i) => ({ id: `c${i + 1}`, description })) } : {}),
      });
      localStorage.setItem("shao.workspace", workspace.trim());
      const title = prompt.trim().split("\n")[0].slice(0, 90);
      openRun({ runId: res.runId, title, workspace: workspace.trim(), createdAt: res.createdAt });
      void useBackend.getState().refreshRuns();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} (${err.code})` : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-[1080px] gap-10 px-5 py-8 sm:px-8 sm:py-12 lg:grid-cols-[minmax(0,1fr)_300px]">
        <motion.form initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }} onSubmit={submit} className="min-w-0">
          <h1 className="font-serif text-[34px] leading-[1.05] text-fg sm:text-[40px]">Nova missão</h1>
          <p className="mt-2 max-w-[52ch] text-[13.5px] text-fg-muted">
            Descreva o que o conselho deve analisar. O orquestrador divide o trabalho entre os agentes e conversa com você durante o run.
          </p>

          <label className="mt-7 block text-[11px] uppercase tracking-[0.1em] text-fg-faint" htmlFor="m-prompt">
            Prompt
          </label>
          <textarea
            id="m-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
            }}
            rows={6}
            required
            placeholder="Ex.: revise o fluxo de importação em lote da branch feature/bulk-import; foque em validação, persistência parcial e testes."
            className="mt-2 w-full resize-y rounded-xl border border-line-strong bg-ink-850 px-3.5 py-3 text-[14px] leading-relaxed text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-white/20"
          />

          <label className="mt-5 block text-[11px] uppercase tracking-[0.1em] text-fg-faint" htmlFor="m-ws">
            Workspace local
          </label>
          <div className="mt-2 flex items-center gap-2 rounded-xl border border-line-strong bg-ink-850 px-3 focus-within:border-white/20">
            <FolderOpen className="size-4 shrink-0 text-fg-faint" />
            <input
              id="m-ws"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              required
              spellCheck={false}
              placeholder="D:/projetos/atlas"
              className="h-10 min-w-0 flex-1 bg-transparent font-mono text-[13px] text-fg outline-none placeholder:text-fg-faint"
            />
          </div>
          <p className="mt-1.5 text-[11.5px] text-fg-faint">Caminho no disco desta máquina. O backend valida acesso e escopo.</p>

          <div className="mt-5 flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-[0.1em] text-fg-faint">Critérios (opcional)</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCriteria((c) => [...c, ""])}>
              <Plus className="size-3.5" /> critério
            </Button>
          </div>
          <ul className="mt-1 flex flex-col gap-1.5">
            {criteria.map((c, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-5 text-right font-mono text-[11px] text-fg-faint">{i + 1}</span>
                <input
                  value={c}
                  aria-label={`Critério ${i + 1}`}
                  onChange={(e) => setCriteria((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
                  placeholder="Ex.: contrato de erro por linha definido"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-ink-850 px-3 text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-white/20"
                />
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remover critério ${i + 1}`} onClick={() => setCriteria((all) => all.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              </li>
            ))}
            {criteria.length === 0 && <li className="text-[12px] text-fg-faint">Sem critérios: o orquestrador propõe os seus.</li>}
          </ul>

          {error && (
            <p className="mt-5 rounded-lg border border-[#e6a0a0]/30 bg-[#e6a0a0]/[0.06] px-3 py-2 text-[12.5px] text-[#e8b4b4]" role="alert">
              Não foi possível criar a missão: {error}
            </p>
          )}

          <div className="mt-6 flex items-center gap-3">
            <Button type="submit" variant="accent" disabled={busy || !prompt.trim() || !workspace.trim()}>
              {busy ? "Criando…" : "Iniciar missão"} <ArrowRight className="size-3.5" />
            </Button>
            <span className="text-[11.5px] text-fg-faint">Ctrl+Enter</span>
          </div>
        </motion.form>

        <aside className="flex flex-col gap-8">
          <section>
            <h2 className="mb-3 text-[11px] uppercase tracking-[0.1em] text-fg-faint">Runtimes</h2>
            <Runtimes />
          </section>
          <section>
            <h2 className="mb-3 text-[11px] uppercase tracking-[0.1em] text-fg-faint">Recentes</h2>
            {runsError && <p className="text-[12px] text-warn">Histórico indisponível: {runsError}</p>}
            {!runsError && runs.length === 0 && <p className="text-[12.5px] text-fg-faint">Nenhuma missão ainda.</p>}
            <ul className="flex flex-col gap-1">
              {runs.slice(0, 8).map((r) => (
                <li key={r.runId}>
                  <button
                    onClick={() => openRun({ runId: r.runId, title: r.title, workspace: r.workspace, createdAt: r.createdAt })}
                    className="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <span className="block truncate text-[13px] text-fg-muted">{r.title || r.runId}</span>
                    <span className="text-[11.5px] text-fg-faint">{RUN_STATUS_LABEL[r.status] ?? r.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function Offline() {
  const error = useBackend((s) => s.error);
  const state = useBackend((s) => s.state);
  const refused = useBackend((s) => s.httpStatus !== undefined && s.httpStatus > 0);
  return (
    <div className="grid h-full place-items-center overflow-y-auto px-6 py-10">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }} className="max-w-[460px]">
        <span className="flex items-center gap-2 text-[12px] text-warn">
          <span className="size-1.5 rounded-full bg-warn" />
          {state === "checking" ? "Procurando backend local…" : refused ? "Backend respondeu, mas recusou a conexão" : "Backend local indisponível"}
        </span>
        <h1 className="mt-3 font-serif text-[32px] leading-[1.1] text-fg">O SHAO precisa do backend para trabalhar de verdade.</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-fg-muted">
          Inicie o backend local (porta padrão 4317) e abra esta página pelo endereço que ele imprime. Sem backend, nenhuma missão real é criada e nenhuma resposta é simulada aqui.
        </p>
        {error && <p className="mt-3 font-mono text-[11.5px] text-fg-faint">{error}</p>}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button variant="default" onClick={() => void useBackend.getState().check().then((ok) => { if (ok) void useBackend.getState().refreshRuns(); })} disabled={state === "checking"}>
            <RefreshCw className={cn("size-3.5", state === "checking" && "animate-spin")} /> Tentar de novo
          </Button>
          <Button variant="outline" onClick={openDemo}>
            Abrir demonstração (dados simulados)
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
