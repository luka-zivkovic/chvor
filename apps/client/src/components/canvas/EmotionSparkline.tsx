import { memo, useMemo } from "react";
import type { EmotionSnapshot } from "@chvor/shared";
import { getEmotionDisplayColor } from "../../lib/emotion-colors";

interface EmotionSparklineProps {
  snapshots: EmotionSnapshot[];
  width?: number;
  height?: number;
  className?: string;
}

export const EmotionSparkline = memo(function EmotionSparkline({
  snapshots,
  width = 200,
  height = 24,
  className = "",
}: EmotionSparklineProps) {
  const dots = useMemo(() => {
    if (snapshots.length === 0) return [];

    const maxDots = Math.min(snapshots.length, 30);
    const step = Math.max(1, Math.floor(snapshots.length / maxDots));
    const selected = snapshots.filter((_, i) => i % step === 0 || i === snapshots.length - 1);

    return selected.map((s, i) => {
      const x = (i / (selected.length - 1 || 1)) * (width - 8) + 4;
      const y = height - (s.blend.intensity * (height - 8) + 4);
      const color = getEmotionDisplayColor(s);
      return { x, y, color, label: s.displayLabel };
    });
  }, [snapshots, width, height]);

  if (dots.length === 0) {
    return (
      <div
        className={`flex items-center justify-center text-[9px] opacity-30 ${className}`}
        style={{ width, height }}
      >
        no emotion data
      </div>
    );
  }

  return (
    <svg width={width} height={height} className={className}>
      {/* Connecting line */}
      {dots.length > 1 && (
        <polyline
          points={dots.map((d) => `${d.x},${d.y}`).join(" ")}
          fill="none"
          stroke="oklch(0.5 0.02 250)"
          strokeWidth="1"
          opacity="0.3"
        />
      )}
      {/* Dots */}
      {dots.map((d, i) => (
        <circle
          key={i}
          cx={d.x}
          cy={d.y}
          r={i === dots.length - 1 ? 3 : 2}
          fill={d.color}
          opacity={i === dots.length - 1 ? 1 : 0.6}
        >
          <title>{d.label}</title>
        </circle>
      ))}
    </svg>
  );
});
