import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { SkillsHubNodeData } from "../../stores/canvas-store";
import { RadiantOrb } from "./RadiantOrb";
import { useEmotionStore } from "../../stores/emotion-store";

const ACCENT = "var(--skill-ai)";

export const SkillsHubNode = memo(function SkillsHubNode({ data }: NodeProps) {
  const d = data as unknown as SkillsHubNodeData;
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
              <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
            </svg>
          </RadiantOrb>
        </div>
        <div className="flex items-center gap-1.5">
          {d.skillCount > 0 && (
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ACCENT }} />
          )}
          <span
            className="max-w-[90px] truncate text-center font-mono text-[10px] tracking-wider"
            style={{ color: "var(--node-label)", textShadow: "0 1px 4px oklch(0 0 0 / 0.5)" }}
          >
            Skills
          </span>
          {d.skillCount > 0 && (
            <span
              className="font-mono text-[8px] tracking-wider"
              style={{ color: "var(--node-label-dim)" }}
            >
              ({d.skillCount})
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
    </>
  );
});
