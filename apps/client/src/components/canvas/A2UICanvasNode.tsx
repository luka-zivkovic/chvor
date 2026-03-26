import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { RadiantField } from "./RadiantField";

const A2UI_COLOR = "var(--chart-3, oklch(0.72 0.15 175))";

export const A2UICanvasNode = memo(function A2UICanvasNode({ data }: NodeProps) {
  const d = data as { label?: string; hasSurfaces?: boolean };
  const active = d.hasSurfaces;

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
      <div className="group flex flex-col items-center gap-2">
        <div
          className={`flex items-center justify-center transition-all duration-300 ease-out ${active ? "animate-field-pulse" : ""}`}
          style={{ width: 72, height: 72 }}
        >
          <RadiantField color={A2UI_COLOR} intensity={active ? 0.6 : 0.35}>
            {/* Layout/grid icon */}
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke={A2UI_COLOR}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="4" rx="1" />
              <rect x="14" y="10" width="7" height="7" rx="1" />
              <rect x="3" y="13" width="7" height="4" rx="1" />
              <rect x="3" y="20" width="18" height="1" rx="0.5" />
            </svg>
          </RadiantField>
        </div>
        <span
          className="max-w-[90px] truncate rounded-full px-2 py-px text-center font-mono text-[10px] tracking-wider transition-colors duration-300"
          style={{ color: "var(--node-label)", background: "var(--glass-bg)", textShadow: "0 1px 4px oklch(0 0 0 / 0.5)" }}
        >
          {d.label ?? "A2UI Canvas"}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
    </>
  );
});
