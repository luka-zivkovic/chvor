import { useMemo } from "react";
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

export function MemoryGraphView() {
  const { graphNodes, graphEdges, graphLoading } = useMemoryStore();

  const { nodes, edges, totalCount } = useMemo(() => {
    if (graphNodes.length === 0) return { nodes: [], edges: [], totalCount: 0 };

    // Simple radial layout grouped by category
    const categories = [...new Set(graphNodes.map((n) => n.category))];
    const limitedNodes = graphNodes
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_VISIBLE_NODES);

    const rfNodes: Node[] = limitedNodes.map((n, i) => {
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
    <div className="flex flex-col gap-1">
      {totalCount > MAX_VISIBLE_NODES && (
        <p className="text-[9px] text-muted-foreground/60 text-right">
          Showing {MAX_VISIBLE_NODES} of {totalCount} memories (strongest)
        </p>
      )}
    <div className="h-[400px] rounded-md border border-border/30 bg-muted/5">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} className="!bg-background !border-border !shadow-sm" />
      </ReactFlow>
    </div>
    </div>
  );
}
