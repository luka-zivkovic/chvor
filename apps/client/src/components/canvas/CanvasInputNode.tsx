import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { CanvasInputNodeData } from "../../stores/canvas-store";

const KIND_ICON: Record<CanvasInputNodeData["inputKind"], string> = {
  file: "↥",
  url: "⌁",
  text: "✎",
};

const KIND_LABEL: Record<CanvasInputNodeData["inputKind"], string> = {
  file: "drop",
  url: "url",
  text: "input",
};

export const CanvasInputNode = memo(function CanvasInputNode({ data }: NodeProps) {
  const d = data as unknown as CanvasInputNodeData;

  return (
    <>
      <Handle type="target" position={Position.Left} className="!h-1 !w-1 !border-none !bg-transparent opacity-0" />
      <div
        className="w-36 rounded-2xl border px-3 py-2 shadow-2xl backdrop-blur-xl"
        style={{
          borderColor: "oklch(0.62 0.13 250 / 0.34)",
          background: "linear-gradient(145deg, oklch(0.16 0.012 265 / 0.9), oklch(0.10 0.006 285 / 0.78))",
          boxShadow: "0 0 30px oklch(0.62 0.13 250 / 0.16), inset 0 1px 0 oklch(1 0 0 / 0.06)",
        }}
      >
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/35 bg-primary/12 text-sm text-primary">
            {KIND_ICON[d.inputKind] ?? "•"}
          </div>
          <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-[0.18em] text-white/35">{KIND_LABEL[d.inputKind] ?? "input"}</div>
            <div className="truncate text-[11px] font-medium text-white/80">{d.label}</div>
          </div>
        </div>
        {d.preview && (
          <div className="mt-2 line-clamp-2 text-[9px] leading-snug text-white/38">{d.preview}</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!h-1 !w-1 !border-none !bg-transparent opacity-0" />
    </>
  );
});
