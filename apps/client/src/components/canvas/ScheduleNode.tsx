import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { ScheduleNodeData } from "../../stores/canvas-store";
import { cn } from "@/lib/utils";
import { RadiantField } from "./RadiantField";

export const ScheduleNode = memo(function ScheduleNode({ data }: NodeProps) {
  const d = data as unknown as ScheduleNodeData;
  const status = d.executionStatus;
  const isRunning = status === "running";
  const isCompleted = status === "completed";
  const isFailed = status === "failed";

  let loopColor: string;
  if (isRunning) loopColor = "var(--status-running)";
  else if (isCompleted) loopColor = "var(--status-completed)";
  else if (isFailed) loopColor = "var(--status-failed)";
  else loopColor = d.enabled ? "var(--status-completed)" : "var(--border)";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
      <div className="group flex flex-col items-center gap-1.5">
        <div
          className={cn(
            "flex items-center justify-center transition-all duration-300",
            d.enabled ? "opacity-100" : "opacity-50",
            isRunning ? "animate-field-pulse" : "",
            isCompleted ? "animate-field-intensify" : ""
          )}
          style={{ width: 52, height: 52 }}
        >
          <RadiantField color={loopColor} size={52} intensity={d.enabled ? 0.4 : 0.15}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke={d.enabled ? "var(--status-completed)" : "var(--muted-foreground)"}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </RadiantField>
        </div>
        <div className="flex items-center gap-1">
          {d.enabled && (
            <span className="h-1.5 w-1.5 rounded-full bg-status-completed" />
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
    </>
  );
});
