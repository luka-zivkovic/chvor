import { useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemoryStore } from "../../stores/memory-store";

const CATEGORY_COLORS: Record<string, string> = {
  profile: "#60a5fa",
  preference: "#a78bfa",
  entity: "#4ade80",
  event: "#fbbf24",
  pattern: "#22d3ee",
  case: "#fb7185",
};

const RELATION_COLORS: Record<string, string> = {
  temporal: "#9ca3af",
  causal: "#ef4444",
  semantic: "#3b82f6",
  entity: "#22c55e",
  contradiction: "#f59e0b",
  supersedes: "#8b5cf6",
  narrative: "#06b6d4",
};

function MemoryNode({ data }: NodeProps) {
  const color = CATEGORY_COLORS[data.category as string] ?? "#9ca3af";
  return (
    <div
      className="rounded-md border bg-background px-2.5 py-1.5 shadow-sm"
      style={{ borderColor: color, opacity: Math.max(0.3, data.strength as number) }}
    >
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground/30 !h-1 !w-1" />
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="max-w-[120px] truncate text-[10px] text-foreground">
          {(data.label as string)?.slice(0, 40)}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground/30 !h-1 !w-1" />
    </div>
  );
}

const nodeTypes = { memory: MemoryNode };

const MAX_VISIBLE_NODES = 100;

function useGraphData() {
  const { graphNodes, graphEdges } = useMemoryStore();

  return useMemo(() => {
    if (graphNodes.length === 0) return { nodes: [], edges: [], totalCount: 0 };

    const categories = [...new Set(graphNodes.map((n) => n.category))];
    const limitedNodes = graphNodes
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_VISIBLE_NODES);

    const rfNodes: Node[] = limitedNodes.map((n) => {
      const catIdx = categories.indexOf(n.category);
      const nodesInCat = limitedNodes.filter((m) => m.category === n.category);
      const posInCat = nodesInCat.indexOf(n);
      const angle = (catIdx / categories.length) * 2 * Math.PI + (posInCat * 0.4);
      const radius = 150 + posInCat * 60;

      return {
        id: n.id,
        type: "memory",
        position: {
          x: 300 + Math.cos(angle) * radius,
          y: 300 + Math.sin(angle) * radius,
        },
        data: {
          label: n.abstract,
          category: n.category,
          strength: n.strength,
        },
      };
    });

    const nodeIds = new Set(rfNodes.map((n) => n.id));
    const rfEdges: Edge[] = graphEdges
      .filter((e) => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId))
      .map((e) => ({
        id: e.id,
        source: e.sourceId,
        target: e.targetId,
        style: { stroke: RELATION_COLORS[e.relation] ?? "#6b7280", strokeWidth: Math.max(1, e.weight * 3) },
        animated: e.weight > 0.7,
        label: e.relation,
        labelStyle: { fontSize: 8, fill: "#9ca3af" },
      }));

    return { nodes: rfNodes, edges: rfEdges, totalCount: graphNodes.length };
  }, [graphNodes, graphEdges]);
}

/** Button shown in the sidebar to launch the full-screen graph overlay */
export function MemoryGraphButton({ onClick }: { onClick: () => void }) {
  const { graphNodes, graphLoading } = useMemoryStore();

  if (graphLoading) return <p className="text-xs text-muted-foreground">Loading graph...</p>;

  if (graphNodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-xs text-muted-foreground">No memories yet</p>
        <p className="mt-1 text-[10px] text-muted-foreground/60">
          Memories form automatically as you chat
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/40">
        <circle cx="12" cy="12" r="2" />
        <circle cx="5" cy="6" r="1.5" />
        <circle cx="19" cy="6" r="1.5" />
        <circle cx="5" cy="18" r="1.5" />
        <circle cx="19" cy="18" r="1.5" />
        <line x1="6.3" y1="7" x2="10.5" y2="10.8" />
        <line x1="17.7" y1="7" x2="13.5" y2="10.8" />
        <line x1="6.3" y1="17" x2="10.5" y2="13.2" />
        <line x1="17.7" y1="17" x2="13.5" y2="13.2" />
      </svg>
      <p className="text-xs text-muted-foreground">
        {graphNodes.length} memories in graph
      </p>
      <button
        onClick={onClick}
        className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/10 px-4 py-2 text-xs font-medium text-foreground hover:bg-muted/20 hover:border-border transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
        Open Graph View
      </button>
    </div>
  );
}

/** Full-screen overlay for the memory graph — rendered via portal to escape transform containing blocks */
export function MemoryGraphOverlay({ onClose }: { onClose: () => void }) {
  const { graphLoading } = useMemoryStore();
  const { nodes, edges, totalCount } = useGraphData();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-md"
        onClick={onClose}
      />

      {/* Graph container */}
      <div
        className="relative z-10 m-4 md:m-8 flex flex-1 flex-col overflow-hidden rounded-xl border border-border/50"
        style={{ background: "var(--glass-bg-strong)" }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border/30 px-6 py-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium text-foreground">Memory Graph</h3>
            {totalCount > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {totalCount > MAX_VISIBLE_NODES
                  ? `Showing ${MAX_VISIBLE_NODES} of ${totalCount} (strongest)`
                  : `${totalCount} memories`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* Legend */}
            <div className="hidden md:flex items-center gap-2">
              {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
                <div key={cat} className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-[9px] text-muted-foreground">{cat}</span>
                </div>
              ))}
            </div>
            <button
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
              title="Close (Esc)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Graph */}
        <div className="flex-1">
          {graphLoading ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-xs text-muted-foreground">Loading graph...</p>
            </div>
          ) : nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-xs text-muted-foreground">No memories to display</p>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              minZoom={0.1}
              maxZoom={3}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={20} size={1} />
              <Controls showInteractive={false} className="!bg-background !border-border !shadow-sm" />
            </ReactFlow>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
