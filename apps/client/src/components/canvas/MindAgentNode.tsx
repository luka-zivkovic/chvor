import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { MindAgentNodeData } from "../../stores/canvas-store";

const ROLE_COLOR: Record<MindAgentNodeData["role"], string> = {
  researcher: "oklch(0.70 0.14 220)",
  planner: "oklch(0.72 0.15 150)",
  critic: "oklch(0.72 0.16 35)",
};

const ROLE_GLYPH: Record<MindAgentNodeData["role"], string> = {
  researcher: "R",
  planner: "P",
  critic: "C",
};

export const MindAgentNode = memo(function MindAgentNode({ data }: NodeProps) {
  const d = data as unknown as MindAgentNodeData;
  const color = ROLE_COLOR[d.role] ?? ROLE_COLOR.researcher;
  const status = d.executionStatus;
  const running = status === "running";
  const failed = status === "failed";

  return (
    <>
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-none !h-1 !w-1 opacity-0" />
      <div
        className="relative w-[116px] rounded-2xl border px-3 py-2 text-center shadow-2xl backdrop-blur-xl"
        style={{
          borderColor: `${failed ? "oklch(0.62 0.20 25)" : color}66`,
          background: "linear-gradient(145deg, oklch(0.16 0.006 285 / 0.88), oklch(0.10 0.004 285 / 0.72))",
          boxShadow: `0 0 ${running ? 36 : 22}px ${color}33`,
        }}
      >
        <div
          className="mx-auto mb-1 flex h-9 w-9 items-center justify-center rounded-full border text-xs font-semibold"
          style={{
            color,
            borderColor: `${color}55`,
            background: `${color}14`,
            boxShadow: running ? `0 0 18px ${color}55` : undefined,
          }}
        >
          {ROLE_GLYPH[d.role] ?? "M"}
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">{d.role}</div>
        <div className="mt-1 line-clamp-2 text-[11px] font-medium leading-snug text-white/80">{d.label}</div>
        {d.summary && (
          <div className="mt-1 line-clamp-2 text-[9px] leading-snug text-white/40">{d.summary}</div>
        )}
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-white/8">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: running ? "55%" : status === "completed" ? "100%" : "100%",
              background: failed ? "oklch(0.62 0.20 25)" : color,
            }}
          />
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-transparent !border-none !h-1 !w-1 opacity-0" />
    </>
  );
});
