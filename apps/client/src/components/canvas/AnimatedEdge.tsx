import { memo } from "react";
import { getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { useEmotionStore } from "../../stores/emotion-store";

function AnimatedEdgeInner({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const edgeData = data as { active?: boolean; ghost?: boolean } | undefined;
  const active = edgeData?.active ?? false;
  const ghost = edgeData?.ghost ?? false;
  const emotionColor = useEmotionStore((s) => s.displayColor);
  const previousColor = useEmotionStore((s) => s.previousSnapshot?.color ?? null);
  const arousal = useEmotionStore((s) => s.currentSnapshot?.vad.arousal ?? 0);
  const blendIntensity = useEmotionStore((s) => s.blendIntensity);

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const gradientId = `eg-${id}`;

  // Ghost edges: simple dashed line, skip all glow/gradient layers
  if (ghost) {
    return (
      <g>
        <path
          d={edgePath}
          fill="none"
          stroke="var(--edge-idle)"
          strokeWidth={1}
          strokeDasharray="6 4"
          strokeLinecap="round"
          opacity={0.2}
        />
      </g>
    );
  }

  // Emotion-aware: tint edges when emotion is active
  const edgeColor = emotionColor ?? "var(--edge-active)";
  const idleColor = emotionColor ?? "var(--edge-idle)";
  // Higher arousal = faster flow animation
  const flowSpeed = Math.max(0.6, 1.5 - ((arousal + 1) / 2) * 0.9);

  return (
    <g>
      {/* Per-edge gradient — glass conduit style, emotion-tinted */}
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={sourceX}
          y1={sourceY}
          x2={targetX}
          y2={targetY}
        >
          <stop offset="0%" stopColor={edgeColor} stopOpacity={active ? 0.7 : 0.3} />
          <stop offset="100%" stopColor={idleColor} stopOpacity={active ? 0.4 : 0.12} />
        </linearGradient>
      </defs>

      {/* Emotion afterimage — faint trace of previous emotion color */}
      {previousColor && previousColor !== emotionColor && (
        <path
          d={edgePath}
          fill="none"
          stroke={previousColor}
          strokeWidth={2}
          strokeLinecap="round"
          opacity={0.08}
          style={{ transition: "opacity 3s ease-out", filter: "blur(2px)" }}
        />
      )}

      {/* Soft ambient glow (active), intensity modulated by emotion */}
      {active && (
        <path
          d={edgePath}
          fill="none"
          stroke={edgeColor}
          strokeWidth={6 + blendIntensity * 4}
          opacity={0.04 + blendIntensity * 0.04}
          style={{ filter: "blur(6px)", transition: "stroke-width 2s ease, opacity 2s ease" }}
        />
      )}

      {/* Glass tube — frosted translucent edge */}
      <path
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={active ? 2.5 : 1.5}
        strokeLinecap="round"
        opacity={active ? 0.7 : 0.4}
        markerEnd={active ? "url(#arrow-active)" : undefined}
        style={{
          transition: "stroke-width 0.4s ease-out, opacity 0.4s ease-out",
        }}
      />

      {/* Inner light line — bright core */}
      <path
        d={edgePath}
        fill="none"
        stroke={active ? edgeColor : idleColor}
        strokeWidth={active ? 0.8 : 0.4}
        strokeLinecap="round"
        opacity={active ? 0.5 : 0.2}
        style={{
          transition: "stroke-width 0.4s ease-out, opacity 0.4s ease-out",
        }}
      />

      {/* Flowing light pulse (active only), speed varies with arousal */}
      {active && (
        <path
          d={edgePath}
          fill="none"
          stroke={edgeColor}
          strokeWidth={1}
          strokeDasharray="4 20"
          strokeLinecap="round"
          opacity={0.5}
          className="energy-flow"
          style={{
            animationDirection: sourceX > targetX ? "reverse" : "normal",
            animationDuration: `${flowSpeed}s`,
          }}
        />
      )}
    </g>
  );
}

export const AnimatedEdge = memo(AnimatedEdgeInner);
