/**
 * Pretext Layout Wrapper
 *
 * Thin caching layer over @chenglou/pretext that prepares text segments
 * and lays them out line-by-line with variable widths (for flowing around nodes).
 */

import { prepareWithSegments, layoutNextLine, clearCache } from "@chenglou/pretext";
import type { PreparedTextWithSegments, LayoutCursor, LayoutLine } from "@chenglou/pretext";
import type { LineSlot } from "./exclusion-zones";

export interface ThoughtSegment {
  id: string;
  text: string;
  font: string;
  type: "thought" | "decision" | "skill" | "tool" | "memory" | "content";
  /** Unix timestamp in ms when this segment was added */
  createdAt: number;
}

export interface RenderedLine {
  text: string;
  x: number;
  y: number;
  width: number;
  font: string;
  segmentId: string;
  opacity: number;
}

// Cache prepared text per (text + font) to avoid re-preparing unchanged segments
const preparedCache = new Map<string, PreparedTextWithSegments>();

function cacheKey(text: string, font: string): string {
  return `${font}|${text}`;
}

function getPrepared(text: string, font: string): PreparedTextWithSegments {
  const key = cacheKey(text, font);
  let prepared = preparedCache.get(key);
  if (prepared) {
    // LRU: move to end so it's evicted last
    preparedCache.delete(key);
    preparedCache.set(key, prepared);
    return prepared;
  }
  prepared = prepareWithSegments(text, font);
  preparedCache.set(key, prepared);
  // Evict least-recently-used entry
  if (preparedCache.size > 100) {
    const firstKey = preparedCache.keys().next().value;
    if (firstKey) preparedCache.delete(firstKey);
  }
  return prepared;
}

/**
 * Lay out a sequence of thought segments line-by-line,
 * querying the lineWidth function for variable widths at each Y.
 *
 * Returns an array of rendered lines ready for ctx.fillText().
 */
export function layoutThoughtStream(
  segments: ThoughtSegment[],
  getLineWidth: (y: number, lineHeight: number) => LineSlot,
  startY: number,
  lineHeight: number,
  maxY: number,
  now: number,
  fadeDurationMs: number,
): RenderedLine[] {
  const lines: RenderedLine[] = [];
  let y = startY;

  for (const seg of segments) {
    if (y > maxY) break;
    if (!seg.text.trim()) continue;

    const age = now - seg.createdAt;
    const opacity = Math.max(0, 1 - age / fadeDurationMs) * 0.5;
    if (opacity <= 0.01) continue;

    const prepared = getPrepared(seg.text, seg.font);
    let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };

    while (y <= maxY) {
      const slot = getLineWidth(y, lineHeight);
      const line: LayoutLine | null = layoutNextLine(prepared, cursor, slot.maxWidth);
      if (!line) break;

      lines.push({
        text: line.text,
        x: slot.startX,
        y,
        width: line.width,
        font: seg.font,
        segmentId: seg.id,
        opacity,
      });

      cursor = line.end;
      y += lineHeight;
    }

    // Small gap between segments
    y += lineHeight * 0.4;
  }

  return lines;
}

/** Clear the internal prepared-text cache and pretext's canvas cache. */
export function clearLayoutCache(): void {
  preparedCache.clear();
  clearCache();
}
