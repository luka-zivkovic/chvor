import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { OutputNodeData } from "../../stores/canvas-store";
import { withOpacity } from "@/lib/utils";
import { RadiantField } from "./RadiantField";

const V = {
  output: "var(--node-output)",
  completed: "var(--status-completed)",
  failed: "var(--status-failed)",
  nodeLabel: "var(--node-label)",
};

export const OutputNode = memo(function OutputNode({ data }: NodeProps) {
  const d = data as unknown as OutputNodeData;
  const status = d.executionStatus;
  const isRunning = status === "running";
  const isCompleted = status === "completed";

  let fieldColor = V.output;
  if (isCompleted) fieldColor = V.completed;
  else if (status === "failed") fieldColor = V.failed;

  const intensity = isRunning ? 0.75 : isCompleted ? 0.6 : 0.35;

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !rounded-full !border-2"
        style={{ backgroundColor: V.output, borderColor: withOpacity(V.output, 0.4) }}
      />
      <div className="flex flex-col items-center gap-1.5" style={{ color: V.output }}>
        <div
          className={`relative flex items-center justify-center transition-all duration-300 ${isRunning ? "animate-field-pulse" : ""} ${isCompleted ? "animate-field-intensify" : ""}`}
          style={{ width: 60, height: 60 }}
        >
          <RadiantField color={fieldColor} size={60} intensity={intensity}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={fieldColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
              <line x1="5" y1="21" x2="19" y2="21" />
            </svg>
          </RadiantField>
        </div>
        <span
          className="text-center font-mono text-[9px] tracking-wider"
          style={{ color: V.nodeLabel }}
        >
          {d.label}
        </span>
      </div>
    </>
  );
});
