import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { GhostHubNodeData } from "../../stores/canvas-store";
import { withOpacity } from "@/lib/utils";

export const GhostHubNode = memo(function GhostHubNode({ data }: NodeProps) {
  const d = data as unknown as GhostHubNodeData;
  const color = d.accentColor || "var(--canvas-accent)";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
      <div className="group flex flex-col items-center gap-2 animate-ghost-pulse cursor-pointer">
        <div className="relative flex items-center justify-center" style={{ width: 72, height: 72 }}>
          {/* Dim glow */}
          <div
            className="absolute inset-[-10%] rounded-full"
            style={{
              background: `radial-gradient(circle, ${withOpacity(color, 0.06)} 0%, transparent 70%)`,
              filter: "blur(6px)",
            }}
          />
          {/* Dashed ring */}
          <div
            className="absolute inset-0 rounded-full"
            style={{
              border: `1.5px dashed ${withOpacity(color, 0.3)}`,
              background: withOpacity(color, 0.03),
            }}
          />
          {/* Plus icon */}
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
            style={{ opacity: 0.4 }}
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
        <span
          className="max-w-[100px] truncate rounded-full px-2 py-px text-center font-mono text-[10px] tracking-wider"
          style={{ color: withOpacity(color, 0.5) }}
        >
          {d.ctaLabel}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
    </>
  );
});
