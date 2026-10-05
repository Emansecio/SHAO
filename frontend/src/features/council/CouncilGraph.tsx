import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  BaseEdge,
  Controls,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useReducedMotion } from "motion/react";
import { Avatar, EngineTag } from "@/features/common";
import { HUMAN } from "@/demo/scenario";
import type { Agent } from "@/model/types";
import { STATUS_LABEL, selectActivePairs, selectStatus, useRun } from "@/store/run";
import { cn } from "@/lib/utils";

const NODE_W = 178;
const FIT = { padding: { top: "60px", bottom: "16px", left: "16px", right: "52px" }, maxZoom: 1.15 } as const;
const NODE_H = 52;

type AgentNodeT = Node<{ agentId: string }, "agent">;
type HumanNodeT = Node<Record<string, never>, "user">;
type FlowEdge = Edge<{ hue: string; kind: "lineage" | "message"; count: number; active: boolean; dim: boolean; paused: boolean }, "flow">;

/** Posições dependem só da topologia (quem existe e quem criou quem). */
function layout(order: string[], agents: Record<string, Agent>, portrait: boolean) {
  const pos: Record<string, { x: number; y: number }> = { user: { x: 0, y: -125 } };
  // uma raiz central (orquestrador, se houver); todos os demais entram no arco ou nas laterais
  const root = order.includes("orchestrator") ? "orchestrator" : order.find((id) => !agents[id]?.parentId || !agents[agents[id].parentId!]);
  if (root) pos[root] = { x: 0, y: 0 };
  const children = order.filter((id) => id !== root);
  const core = children.filter((id) => !agents[id]?.dynamic);
  const dynamic = children.filter((id) => agents[id]?.dynamic);
  if (portrait) {
    // contêiner alto e estreito: equipe em duas colunas abaixo do orquestrador
    [...core, ...dynamic].forEach((id, i) => {
      pos[id] = { x: (i % 2 === 0 ? -1 : 1) * 100, y: 125 + Math.floor(i / 2) * 82 };
    });
  } else {
    // equipe base em arco raso abaixo do orquestrador (linhas de até 5); especialistas dinâmicos nas laterais
    const perRow = 5;
    core.forEach((id, i) => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, core.length - row * perRow);
      const k = i % perRow;
      const t = inRow === 1 ? 0 : (k / (inRow - 1)) * 2 - 1;
      pos[id] = { x: t * (inRow - 1) * 96, y: 140 - 36 * t * t + row * 92 };
    });
    dynamic.forEach((id, i) => {
      pos[id] = { x: (i % 2 === 0 ? -1 : 1) * 340, y: 8 + Math.floor(i / 2) * 66 };
    });
  }
  for (const k in pos) pos[k] = { x: pos[k].x - NODE_W / 2, y: pos[k].y - NODE_H / 2 };
  return pos;
}

const centerHandle = "!pointer-events-none !absolute !left-1/2 !top-1/2 !size-px !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0";

const AgentNode = memo(function AgentNode({ data }: NodeProps<AgentNodeT>) {
  const id = data.agentId;
  const agent = useRun((s) => s.agents[id]);
  const status = useRun((s) => selectStatus(s, id));
  const acting = useRun((s) => s.acting[id]);
  const target = useRun((s) => Object.values(s.streaming).find((m) => m.from === id)?.recipients);
  const agents = useRun((s) => s.agents);
  const selected = useRun((s) => s.selectedAgent === id);
  const paused = useRun((s) => s.paused);
  const select = useRun((s) => s.selectAgent);
  if (!agent) return null;
  const line =
    status === "acting"
      ? acting
      : status === "speaking" && target
        ? `fala com ${target.map((t) => (t === "user" ? "você" : agents[t]?.name)).join(", ")}`
        : STATUS_LABEL[status];
  const live = status === "speaking" || status === "acting";
  return (
    <>
      <Handle type="target" position={Position.Top} className={centerHandle} isConnectable={false} />
      <Handle type="source" position={Position.Top} className={centerHandle} isConnectable={false} />
      <button
        type="button"
        onClick={() => select(selected ? null : id)}
        aria-pressed={selected}
        aria-label={`${agent.name}, ${agent.role}, ${STATUS_LABEL[status]}`}
        className={cn(
          "nodrag relative flex items-center gap-2 rounded-xl border bg-ink-850/95 px-2.5 text-left backdrop-blur transition-[border-color,box-shadow,background] duration-200 hover:bg-ink-800",
          selected ? "border-white/25" : "border-line-strong",
        )}
        style={{
          width: NODE_W,
          height: NODE_H,
          boxShadow: live && !paused ? `0 0 0 1px color-mix(in oklab, ${agent.hue} 35%, transparent), 0 8px 30px -8px color-mix(in oklab, ${agent.hue} 35%, transparent)` : selected ? `0 0 0 1px ${agent.hue}55` : undefined,
        }}
      >
        <Avatar id={id} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium leading-tight text-fg">{agent.name}</span>
          <span className={cn("block truncate text-[11.5px] leading-tight", status === "waiting" ? "text-warn" : live ? "text-fg-muted" : "text-fg-faint")}>
            {live || status === "waiting" ? line : <>{agent.role} · <EngineTag engine={agent.engine} className="text-[10.5px]" /></>}
          </span>
        </span>
        {agent.dynamic && <span className="absolute -top-2 right-2 rounded bg-ink-950 px-1 font-mono text-[9px] text-fg-faint ring-1 ring-line-strong">dinâmico</span>}
      </button>
    </>
  );
});

function HumanNode() {
  return (
    <>
      <Handle type="target" position={Position.Top} className={centerHandle} isConnectable={false} />
      <Handle type="source" position={Position.Top} className={centerHandle} isConnectable={false} />
      <div className="flex items-center justify-center" style={{ width: NODE_W, height: NODE_H }}>
        <span className="flex items-center gap-2 rounded-full border border-line-strong bg-ink-850 py-1 pl-1 pr-3 text-[12px] text-fg">
          <Avatar id="user" size={22} />
          Você
        </span>
      </div>
    </>
  );
}

function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<FlowEdge>) {
  const reduced = useReducedMotion();
  if (!data) return null;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const bend = data.kind === "lineage" ? 0 : 0.16;
  const cx = (sourceX + targetX) / 2 - dy * bend;
  const cy = (sourceY + targetY) / 2 + dx * bend;
  const d = `M ${sourceX},${sourceY} Q ${cx},${cy} ${targetX},${targetY}`;
  if (data.kind === "lineage") {
    return <BaseEdge id={id} path={d} style={{ stroke: "rgb(255 255 255 / 0.16)", strokeWidth: 1, strokeDasharray: "2 5", opacity: data.dim ? 0.35 : 1 }} />;
  }
  const width = 1 + Math.min(data.count, 5) * 0.3;
  return (
    <g style={{ opacity: data.dim ? 0.12 : 1, transition: "opacity 200ms" }}>
      <BaseEdge
        id={id}
        path={d}
        style={{
          stroke: data.hue,
          strokeOpacity: data.active ? 0.85 : 0.32,
          strokeWidth: data.active ? width + 0.6 : width,
          transition: "stroke-opacity 300ms, stroke-width 300ms",
        }}
      />
      {data.active && !data.paused && !reduced &&
        [0, 0.45].map((offset) => (
          <circle key={offset} r={2.6} fill={data.hue} className="edge-particle">
            <animateMotion dur="1.1s" repeatCount="indefinite" begin={`${offset}s`} path={d} />
          </circle>
        ))}
    </g>
  );
}

const nodeTypes = { agent: AgentNode, user: HumanNode };
const edgeTypes = { flow: FlowEdgeView };

function Graph() {
  const order = useRun((s) => s.agentOrder);
  const agents = useRun((s) => s.agents);
  const pairCounts = useRun((s) => s.pairCounts);
  const lineage = useRun((s) => s.lineage);
  const activeKey = useRun(selectActivePairs);
  const selected = useRun((s) => s.selectedAgent);
  const paused = useRun((s) => s.paused);
  const { fitView } = useReactFlow();
  const reduced = useReducedMotion();

  const [portrait, setPortrait] = useState(false);
  const topology = `${order.join(",")}|${portrait ? "p" : "l"}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const positions = useMemo(() => layout(order, agents, portrait), [topology]);

  const nodes = useMemo<(AgentNodeT | HumanNodeT)[]>(
    () => [
      { id: "user", type: "user", position: positions.user, data: {}, selectable: false },
      ...order.map<AgentNodeT>((id) => ({ id, type: "agent", position: positions[id] ?? { x: 0, y: 0 }, data: { agentId: id }, selectable: false })),
    ],
    [positions, order],
  );

  // Arestas derivam de contagens incrementais do store (não varrem o log) e reaproveitam
  // o objeto anterior quando nada mudou, para o React Flow não re-renderizar todas a cada evento.
  const edgeCache = useRef(new Map<string, FlowEdge>());
  const edges = useMemo<FlowEdge[]>(() => {
    const active = new Set(activeKey ? activeKey.split("|") : []);
    const ids = new Set(["user", ...order]);
    const next: FlowEdge[] = [];
    const keep = (id: string, source: string, target: string, data: NonNullable<FlowEdge["data"]>) => {
      if (!ids.has(source) || !ids.has(target)) return;
      const prev = edgeCache.current.get(id);
      const same = prev?.data && (Object.keys(data) as (keyof typeof data)[]).every((k) => prev.data![k] === data[k]);
      const edge = same ? prev! : { id, source, target, type: "flow" as const, data };
      edgeCache.current.set(id, edge);
      next.push(edge);
    };
    for (const l of lineage)
      keep(`l:${l.by}>${l.id}`, l.by, l.id, { hue: "", kind: "lineage", count: 0, active: false, dim: !!selected && selected !== l.id && selected !== l.by, paused });
    const keys = new Set([...Object.keys(pairCounts), ...active]);
    for (const k of keys) {
      const [source, target] = k.split(">");
      const hue = source === "user" ? HUMAN.hue : (agents[source]?.hue ?? "#888");
      keep(`m:${k}`, source, target, { hue, kind: "message", count: pairCounts[k] ?? 0, active: active.has(k), dim: !!selected && selected !== source && selected !== target, paused });
    }
    return next;
  }, [pairCounts, lineage, activeKey, agents, selected, paused, order]);

  // Reenquadra quando os nós são medidos pela primeira vez, quando a topologia muda
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (initialized) fitView(FIT);
  }, [initialized, fitView]);
  // Reenquadra quando a topologia muda ou o contêiner muda de tamanho (dock, painel, janela).
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => fitView({ ...FIT, duration: reduced ? 0 : 500 }), 60);
    return () => clearTimeout(t);
  }, [topology, fitView, reduced]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0) setPortrait(height > width * 0.85);
      clearTimeout(t);
      t = setTimeout(() => fitView(FIT), 120);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(t);
    };
  }, [fitView]);

  return (
    <div ref={box} className="h-full w-full">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={FIT}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      minZoom={0.2}
      maxZoom={1.6}
      onPaneClick={() => useRun.getState().selectAgent(null)}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgb(255 255 255 / 0.07)" />
      <Controls showInteractive={false} position="bottom-right" aria-label="Zoom do grafo" />
    </ReactFlow>
    </div>
  );
}

export function CouncilGraph({ className }: { className?: string }) {
  return (
    <div className={cn("relative h-full w-full", className)}>
      <ReactFlowProvider>
        <Graph />
      </ReactFlowProvider>
    </div>
  );
}
