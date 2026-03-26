import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { SkillNodeData } from "../../stores/canvas-store";
import { RadiantField } from "./RadiantField";

const CATEGORY_VARS: Record<string, string> = {
  web: "var(--skill-web)",
  communication: "var(--skill-communication)",
  file: "var(--skill-file)",
  data: "var(--skill-data)",
  developer: "var(--skill-developer)",
  productivity: "var(--skill-productivity)",
  ai: "var(--skill-ai)",
};

const DEFAULT_SKILL_COLOR = "var(--muted-foreground)";

function CategoryIcon({ category, color }: { category?: string; color: string }) {
  const props = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (category) {
    case "web":
      return (<svg {...props}><circle cx="12" cy="12" r="10" /><ellipse cx="12" cy="12" rx="4" ry="10" /><line x1="2" y1="12" x2="22" y2="12" /></svg>);
    case "communication":
      return (<svg {...props}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>);
    case "file":
      return (<svg {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>);
    case "data":
      return (<svg {...props}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></svg>);
    case "developer":
      return (<svg {...props}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>);
    case "productivity":
      return (<svg {...props}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>);
    case "ai":
      return (<svg {...props}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>);
    default:
      return (<svg {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>);
  }
}

export const SkillNode = memo(function SkillNode({ data }: NodeProps) {
  const d = data as unknown as SkillNodeData;
  const status = d.executionStatus;
  const isRunning = status === "running";
  const isCompleted = status === "completed";
  const isWaiting = status === "waiting";

  const catColor = d.category ? CATEGORY_VARS[d.category] ?? DEFAULT_SKILL_COLOR : DEFAULT_SKILL_COLOR;

  let loopColor: string;
  if (isWaiting) {
    loopColor = "var(--status-warning, oklch(0.8 0.15 85))";
  } else if (isRunning) {
    loopColor = "var(--status-running)";
  } else if (isCompleted) {
    loopColor = "var(--status-completed)";
  } else {
    loopColor = catColor;
  }

  const labelColor = isRunning ? "var(--foreground)" : "var(--node-label)";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
      <div className="group flex flex-col items-center gap-2">
        <div
          className={`flex items-center justify-center transition-all duration-300 ease-out ${isWaiting || isRunning ? "animate-field-pulse" : ""} ${isCompleted ? "animate-field-intensify" : ""}`}
          style={{ width: 72, height: 72 }}
        >
          <RadiantField color={loopColor} intensity={isRunning ? 0.7 : isCompleted ? 0.6 : 0.4}>
            <CategoryIcon category={d.category} color={loopColor} />
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
