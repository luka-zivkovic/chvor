import { memo } from "react";
import { getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";

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

  return (
    <g>
      {/* Per-edge gradient — glass conduit style */}
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={sourceX}
          y1={sourceY}
          x2={targetX}
          y2={targetY}
        >
          <stop offset="0%" stopColor="var(--edge-active)" stopOpacity={active ? 0.7 : 0.3} />
          <stop offset="100%" stopColor="var(--edge-idle)" stopOpacity={active ? 0.4 : 0.12} />
        </linearGradient>
      </defs>

      {/* Soft ambient glow (active) */}
      {active && (
        <path
          d={edgePath}
          fill="none"
          stroke="var(--edge-active)"
          strokeWidth={8}
          opacity={0.06}
          style={{ filter: "blur(6px)" }}
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
        stroke={active ? "var(--edge-active)" : "var(--edge-idle)"}
        strokeWidth={active ? 0.8 : 0.4}
        strokeLinecap="round"
        opacity={active ? 0.5 : 0.2}
        style={{
          transition: "stroke-width 0.4s ease-out, opacity 0.4s ease-out",
        }}
      />

      {/* Flowing light pulse (active only) */}
      {active && (
        <path
          d={edgePath}
          fill="none"
          stroke="var(--edge-active)"
          strokeWidth={1}
          strokeDasharray="4 20"
          strokeLinecap="round"
          opacity={0.5}
          className="energy-flow"
          style={{ animationDirection: sourceX > targetX ? "reverse" : "normal" }}
        />
      )}
    </g>
  );
}

export const AnimatedEdge = memo(AnimatedEdgeInner);
