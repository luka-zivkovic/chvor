import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { TriggerNodeData } from "../../stores/canvas-store";
import { withOpacity } from "@/lib/utils";
import { RadiantField } from "./RadiantField";

const V = {
  trigger: "var(--node-trigger)",
  completed: "var(--status-completed)",
  failed: "var(--status-failed)",
  nodeLabel: "var(--node-label)",
};

function ClockBadge() {
  return (
    <div
      className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full"
      style={{ background: V.trigger }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--background)" strokeWidth="2.5" strokeLinecap="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    </div>
  );
}

export const TriggerNode = memo(function TriggerNode({ data }: NodeProps) {
  const d = data as unknown as TriggerNodeData;
  const status = d.executionStatus;
  const isRunning = status === "running";
  const isCompleted = status === "completed";

  let fieldColor = V.trigger;
  if (isCompleted) fieldColor = V.completed;
  else if (status === "failed") fieldColor = V.failed;

  const intensity = isRunning ? 0.75 : isCompleted ? 0.6 : 0.4;

  return (
    <>
      <div className="flex flex-col items-center gap-1.5" style={{ color: V.trigger }}>
        <div
          className={`relative flex items-center justify-center transition-all duration-300 ${isRunning ? "animate-field-pulse" : ""} ${isCompleted ? "animate-field-intensify" : ""}`}
          style={{ width: 60, height: 60 }}
        >
          <RadiantField color={fieldColor} size={60} intensity={intensity}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={fieldColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </RadiantField>
          {d.triggerType === "schedule" && <ClockBadge />}
        </div>
        <span
          className="text-center font-mono text-[9px] tracking-wider"
          style={{ color: V.nodeLabel }}
        >
          {d.label}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !rounded-full !border-2"
        style={{ backgroundColor: V.trigger, borderColor: withOpacity(V.trigger, 0.4) }}
      />
    </>
  );
});
