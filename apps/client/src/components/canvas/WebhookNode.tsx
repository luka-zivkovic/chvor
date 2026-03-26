import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { WebhookNodeData } from "../../stores/canvas-store";
import { cn } from "@/lib/utils";
import { RadiantField } from "./RadiantField";

const SOURCE_COLORS: Record<string, string> = {
  github: "var(--status-completed)",
  notion: "var(--status-warning)",
  gmail: "var(--status-error)",
  generic: "var(--status-running)",
};

export const WebhookNode = memo(function WebhookNode({ data }: NodeProps) {
  const d = data as unknown as WebhookNodeData;

  const color = d.enabled
    ? SOURCE_COLORS[d.source] ?? "var(--status-running)"
    : "var(--border)";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
      <div className="group flex flex-col items-center gap-1.5">
        <div
          className={cn(
            "flex items-center justify-center transition-all duration-300",
            d.enabled ? "opacity-100" : "opacity-50"
          )}
          style={{ width: 52, height: 52 }}
        >
          <RadiantField color={color} size={52} intensity={d.enabled ? 0.4 : 0.15}>
            {/* Link/webhook icon */}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke={d.enabled ? color : "var(--muted-foreground)"}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </RadiantField>
        </div>
        <div className="flex items-center gap-1">
          {d.enabled && (
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: color }}
            />
          )}
          <span
            className={cn(
              "max-w-[80px] truncate text-center font-mono text-[8px] tracking-wider",
              d.enabled ? "text-node-label" : "text-node-label-dim"
            )}
          >
            {d.label}
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
    </>
  );
});
