import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { ToolNodeData } from "../../stores/canvas-store";
import { ProviderIcon } from "../ui/ProviderIcon";
import { RadiantField } from "./RadiantField";

const TOOL_COLOR = "var(--tool-accent)";

export const ToolNode = memo(function ToolNode({ data }: NodeProps) {
  const d = data as unknown as ToolNodeData;
  const status = d.executionStatus;
  const isRunning = status === "running";
  const isCompleted = status === "completed";
  const isFailed = status === "failed";

  let loopColor: string;
  if (isRunning) loopColor = "var(--status-running)";
  else if (isCompleted) loopColor = "var(--status-completed)";
  else if (isFailed) loopColor = "var(--status-failed)";
  else loopColor = TOOL_COLOR;

  const labelColor = isRunning ? "var(--foreground)" : "var(--node-label)";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
      <div className="group flex flex-col items-center gap-2">
        <div
          className={`flex items-center justify-center transition-all duration-300 ease-out ${isRunning ? "animate-field-pulse" : ""} ${isCompleted ? "animate-field-intensify" : ""}`}
          style={{ width: 72, height: 72 }}
        >
          <RadiantField color={loopColor} intensity={isRunning ? 0.7 : isCompleted ? 0.6 : 0.4}>
            {d.icon ? (
              <ProviderIcon icon={d.icon} size={24} className="text-[color:var(--tool-accent)]" />
            ) : (
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke={loopColor}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
            )}
          </RadiantField>
        </div>
        <span
          className="max-w-[90px] truncate rounded-full px-2 py-px text-center font-mono text-[10px] tracking-wider transition-colors duration-300"
          style={{ color: labelColor, background: "var(--glass-bg)", textShadow: "0 1px 4px oklch(0 0 0 / 0.5)" }}
        >
          {d.label}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
    </>
  );
});
