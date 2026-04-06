/**
 * Exclusion Zone Calculator
 *
 * Given node positions (flow-space) and a viewport transform,
 * computes the available text width at any Y coordinate by
 * subtracting horizontal spans occupied by orbital nodes.
 */

import { OFFSETS } from "../../hooks/use-orbital-layout";
import type { ChvorNode, ChvorNodeData } from "../../stores/canvas-store";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Full rendered size (2 * half-offset) for each node category */
const NODE_SIZES: Record<string, { w: number; h: number }> = {
  brain: { w: OFFSETS.brain.hw * 2, h: OFFSETS.brain.hh * 2 },
  "skills-hub": { w: OFFSETS.hub.hw * 2, h: OFFSETS.hub.hh * 2 },
  "tools-hub": { w: OFFSETS.hub.hw * 2, h: OFFSETS.hub.hh * 2 },
  "connections-hub": { w: OFFSETS.hub.hw * 2, h: OFFSETS.hub.hh * 2 },
  "integrations-hub": { w: OFFSETS.hub.hw * 2, h: OFFSETS.hub.hh * 2 },
  "schedule-hub": { w: OFFSETS.hub.hw * 2, h: OFFSETS.hub.hh * 2 },
  "webhooks-hub": { w: OFFSETS.hub.hw * 2, h: OFFSETS.hub.hh * 2 },
  "ghost-hub": { w: OFFSETS.hub.hw * 2, h: OFFSETS.hub.hh * 2 },
  skill: { w: OFFSETS.skill.hw * 2, h: OFFSETS.skill.hh * 2 },
  tool: { w: OFFSETS.tool.hw * 2, h: OFFSETS.tool.hh * 2 },
  schedule: { w: OFFSETS.schedule.hw * 2, h: OFFSETS.schedule.hh * 2 },
  integration: { w: OFFSETS.integration.hw * 2, h: OFFSETS.integration.hh * 2 },
  webhook: { w: OFFSETS.webhook.hw * 2, h: OFFSETS.webhook.hh * 2 },
};

const DEFAULT_SIZE = { w: 90, h: 94 };
const PADDING = 18; // breathing room around nodes

/**
 * Convert node flow-space positions to screen-space bounding rects.
 */
function nodesToScreenRects(nodes: ChvorNode[], vp: Viewport): Rect[] {
  const rects: Rect[] = [];
  for (const node of nodes) {
    const size = NODE_SIZES[node.type ?? ""] ?? DEFAULT_SIZE;
    // flow-space position is already the top-left corner (offset-adjusted)
    const left = node.position.x * vp.zoom + vp.x - PADDING;
    const top = node.position.y * vp.zoom + vp.y - PADDING;
    const right = left + size.w * vp.zoom + PADDING * 2;
    const bottom = top + size.h * vp.zoom + PADDING * 2;
    rects.push({ left, top, right, bottom });
  }
  return rects;
}

export interface LineSlot {
  startX: number;
  maxWidth: number;
}

/**
 * Build a reusable line-width calculator from the current node state.
 * Returns a function that, given a Y in screen-space, returns the
 * widest unobstructed horizontal span for text at that line.
 */
export function buildLineWidthFn(
  nodes: ChvorNode[],
  vp: Viewport,
  canvasWidth: number,
): (y: number, lineHeight: number) => LineSlot {
  const rects = nodesToScreenRects(nodes, vp);
  const margin = 24; // left/right canvas margin

  return (y: number, lineHeight: number): LineSlot => {
    // Collect rects that overlap this line's vertical band
    const overlapping: Rect[] = [];
    for (const r of rects) {
      if (r.bottom > y && r.top < y + lineHeight) {
        overlapping.push(r);
      }
    }

    if (overlapping.length === 0) {
      return { startX: margin, maxWidth: canvasWidth - margin * 2 };
    }

    // Sort overlapping rects by left edge
    overlapping.sort((a, b) => a.left - b.left);

    // Find the widest gap between obstacles (including canvas edges)
    let bestStart = margin;
    let bestWidth = 0;

    // Gap from left margin to first rect
    const firstGapEnd = overlapping[0].left;
    if (firstGapEnd - margin > bestWidth) {
      bestStart = margin;
      bestWidth = firstGapEnd - margin;
    }

    // Gaps between consecutive rects
    for (let i = 0; i < overlapping.length - 1; i++) {
      const gapStart = overlapping[i].right;
      const gapEnd = overlapping[i + 1].left;
      const gapWidth = gapEnd - gapStart;
      if (gapWidth > bestWidth) {
        bestStart = gapStart;
        bestWidth = gapWidth;
      }
    }

    // Gap from last rect to right margin
    const lastGapStart = overlapping[overlapping.length - 1].right;
    const lastGapWidth = canvasWidth - margin - lastGapStart;
    if (lastGapWidth > bestWidth) {
      bestStart = lastGapStart;
      bestWidth = lastGapWidth;
    }

    const MIN_READABLE_WIDTH = 120;
    if (bestWidth < MIN_READABLE_WIDTH) {
      // All gaps too narrow — use full width (text will render below nodes)
      return { startX: margin, maxWidth: canvasWidth - margin * 2 };
    }
    return {
      startX: bestStart,
      maxWidth: bestWidth,
    };
  };
}
