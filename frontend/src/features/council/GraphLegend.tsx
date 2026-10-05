// Legenda do grafo, separada para não puxar o React Flow no carregamento inicial.
export function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-fg-faint">
      <span className="flex items-center gap-1.5">
        <svg width="22" height="2" aria-hidden>
          <line x1="0" y1="1" x2="22" y2="1" stroke="rgb(255 255 255 / 0.35)" strokeDasharray="2 4" />
        </svg>
        criou
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="22" height="2" aria-hidden>
          <line x1="0" y1="1" x2="22" y2="1" stroke="#9db0f5" strokeWidth="1.6" />
        </svg>
        mensagem endereçada
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-accent" /> em trânsito
      </span>
    </div>
  );
}
