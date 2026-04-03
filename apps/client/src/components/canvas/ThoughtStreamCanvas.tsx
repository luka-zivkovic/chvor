/**
 * ThoughtStreamCanvas
 *
 * A raw HTML <canvas> layer rendered behind ReactFlow that displays
 * the AI's live reasoning as flowing text. Text wraps around orbital
 * nodes using pretext's variable-width layoutNextLine() API.
 *
 * - pointer-events: none — never intercepts ReactFlow interactions
 * - rAF loop only runs during active execution
 * - HiDPI-aware for crisp text
 */

import { useRef, useEffect, useCallback, memo } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import { useCanvasStore } from "../../stores/canvas-store";
import type { ChvorNode, ChvorEdge } from "../../stores/canvas-store";
import { useEmotionStore } from "../../stores/emotion-store";
import { useThoughtStream } from "../../hooks/use-thought-stream";
import { buildLineWidthFn } from "../../lib/thought-stream/exclusion-zones";
import { layoutThoughtStream } from "../../lib/thought-stream/text-layout";
import type { RenderedLine } from "../../lib/thought-stream/text-layout";

const LINE_HEIGHT = 16;
const FADE_DURATION_MS = 8000;

interface Props {
  rfInstance: React.RefObject<ReactFlowInstance<ChvorNode, ChvorEdge> | null>;
}

export const ThoughtStreamCanvas = memo(function ThoughtStreamCanvas({ rfInstance }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const { segments, isActive, streamingThoughtRef } = useThoughtStream();
  const nodes = useCanvasStore((s) => s.nodes);
  const emotionColor = useEmotionStore((s) => s.displayColor);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    // Resize canvas to match container (HiDPI)
    const w = rect.width;
    const h = rect.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Build render-time segments: stable segments + live streaming thought
    const renderSegments = [...segments];
    const liveThought = streamingThoughtRef.current;
    if (liveThought) {
      renderSegments.push({
        id: "streaming-thought",
        text: liveThought,
        font: "11px 'IBM Plex Sans', sans-serif",
        type: "thought" as const,
        createdAt: Date.now(),
      });
    }

    if (renderSegments.length === 0) return;

    // Get viewport transform from ReactFlow
    const vp = rfInstance.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 };

    // Build exclusion zones from current node positions
    const getLineWidth = buildLineWidthFn(nodes, vp, w);

    // Compute the starting Y: below the top of the brain canvas with some offset
    // Use the center of the viewport, offset upward
    const centerY = h * 0.15;
    const now = Date.now();

    // Layout all segments through pretext
    const lines: RenderedLine[] = layoutThoughtStream(
      renderSegments,
      getLineWidth,
      centerY,
      LINE_HEIGHT,
      h - 40,
      now,
      FADE_DURATION_MS,
    );

    // Render
    const baseColor = emotionColor || "oklch(0.65 0.12 250)";

    for (const line of lines) {
      ctx.font = line.font;
      ctx.globalAlpha = line.opacity;

      // Subtle glow
      ctx.shadowColor = baseColor;
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // Text color: tinted with emotion
      ctx.fillStyle = baseColor;
      ctx.fillText(line.text, line.x, line.y + LINE_HEIGHT * 0.8);
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }, [segments, nodes, rfInstance, emotionColor, streamingThoughtRef]);

  // Animation loop
  useEffect(() => {
    if (!isActive && segments.length === 0) {
      // Clear canvas when nothing to show
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      }
      return;
    }

    let running = true;

    function tick() {
      if (!running) return;
      render();
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [isActive, segments.length, render]);

  // Also re-render on viewport changes (pan/zoom) via a resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas?.parentElement) return;

    const observer = new ResizeObserver(() => {
      render();
    });
    observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, [render]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
});
