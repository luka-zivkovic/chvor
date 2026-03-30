import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { ToolsHubNodeData } from "../../stores/canvas-store";
import { RadiantOrb } from "./RadiantOrb";
import { useEmotionStore } from "../../stores/emotion-store";

const ACCENT = "var(--tool-accent)";

export const ToolsHubNode = memo(function ToolsHubNode({ data }: NodeProps) {
  const d = data as unknown as ToolsHubNodeData;
  const isRunning = d.executionStatus === "running";
  const isCompleted = d.executionStatus === "completed";

  let orbColor = ACCENT;
  if (isRunning) orbColor = "var(--status-running)";
  else if (isCompleted) orbColor = "var(--status-completed)";

  const intensity = isRunning ? 0.8 : isCompleted ? 0.7 : 0.5;
  const emotionTint = useEmotionStore((s) => s.displayColor);

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
      <div className="group flex flex-col items-center gap-2">
        <div
          className={`flex items-center justify-center transition-all duration-300 ease-out ${isCompleted ? "animate-field-intensify" : ""}`}
          style={{ width: 72, height: 72 }}
        >
          <RadiantOrb color={orbColor} intensity={intensity} emotionTint={emotionTint}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={orbColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
          </RadiantOrb>
        </div>
        <div className="flex items-center gap-1.5">
          {d.toolCount > 0 && (
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ACCENT }} />
          )}
          <span
            className="max-w-[90px] truncate text-center font-mono text-[10px] tracking-wider"
            style={{ color: "var(--node-label)", textShadow: "0 1px 4px oklch(0 0 0 / 0.5)" }}
          >
            Tools
          </span>
          {d.toolCount > 0 && (
            <span
              className="font-mono text-[8px] tracking-wider"
              style={{ color: "var(--node-label-dim)" }}
            >
              ({d.toolCount})
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
    </>
  );
});
