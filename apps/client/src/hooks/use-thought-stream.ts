/**
 * useThoughtStream
 *
 * Subscribes to execution events from app-store and aggregates them
 * into a rolling buffer of ThoughtSegments for canvas rendering.
 */

import { useRef, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../stores/app-store";
import type { ThoughtSegment } from "../lib/thought-stream/text-layout";
import { clearLayoutCache } from "../lib/thought-stream/text-layout";

const MAX_SEGMENTS = 20;
const FONT_THOUGHT = "11px 'IBM Plex Sans', sans-serif";
const FONT_MONO = "10px 'IBM Plex Mono', monospace";

function segmentType(
  eventType: string,
): ThoughtSegment["type"] | null {
  if (eventType === "brain.thinking") return "thought";
  if (eventType === "brain.decision") return "decision";
  if (eventType.startsWith("skill.")) return "skill";
  if (eventType.startsWith("tool.")) return "tool";
  if (eventType.startsWith("memory.")) return "memory";
  return null;
}

function extractText(eventType: string, data: Record<string, unknown>): string {
  switch (eventType) {
    case "brain.thinking":
      return (data.thought as string) || "";
    case "brain.decision":
      return `${data.capabilityKind === "skill" ? "skill" : "tool"}: ${data.reason || ""}`;
    case "skill.invoked":
      return `invoking ${data.skillId || "skill"}`;
    case "skill.completed":
      return `completed ${data.nodeId || "skill"}`;
    case "skill.failed":
      return `failed: ${data.error || "unknown"}`;
    case "tool.invoked":
      return `using ${data.toolId || "tool"}`;
    case "tool.completed":
      return `done: ${data.nodeId || "tool"}`;
    case "tool.failed":
      return `error: ${data.error || "unknown"}`;
    case "memory.recalled":
      return `recalled: ${data.abstract || ""}`;
    case "memory.created":
      return `learned: ${data.abstract || ""}`;
    case "memory.consolidated":
      return `insight: ${data.insight || ""}`;
    default:
      return "";
  }
}

function fontForType(type: ThoughtSegment["type"]): string {
  return type === "thought" || type === "decision" ? FONT_THOUGHT : FONT_MONO;
}

/**
 * Returns a stable array of ThoughtSegments derived from execution events.
 * The array updates when new events arrive and clears on execution.started.
 */
export function useThoughtStream(): {
  segments: ThoughtSegment[];
  isActive: boolean;
} {
  const executionEvents = useAppStore((s) => s.executionEvents);
  const streamingThought = useAppStore((s) => s.streamingThought);
  const prevLengthRef = useRef(0);
  const segmentsRef = useRef<ThoughtSegment[]>([]);
  const [version, setVersion] = useState(0);

  // Process new events into the segment buffer (side-effect, not in useMemo)
  useEffect(() => {
    const prevLen = prevLengthRef.current;
    const currentLen = executionEvents.length;

    // Reset on new execution (events cleared) or first run
    if (currentLen < prevLen) {
      segmentsRef.current = [];
    }

    // Process only new events
    const startIdx = currentLen < prevLen ? 0 : prevLen;
    let changed = currentLen < prevLen;

    for (let i = startIdx; i < currentLen; i++) {
      const ev = executionEvents[i];
      if (ev.type === "execution.started") {
        segmentsRef.current = [];
        changed = true;
        continue;
      }

      const type = segmentType(ev.type);
      if (!type) continue;

      const text = extractText(ev.type, ev.data as Record<string, unknown>);
      if (!text.trim()) continue;

      segmentsRef.current.push({
        id: `${ev.type}-${i}-${Date.now()}`,
        text,
        font: fontForType(type),
        type,
        createdAt: Date.now(),
      });

      // Keep buffer bounded
      if (segmentsRef.current.length > MAX_SEGMENTS) {
        segmentsRef.current = segmentsRef.current.slice(-MAX_SEGMENTS);
      }
      changed = true;
    }

    prevLengthRef.current = currentLen;
    if (changed) setVersion((v) => v + 1);
  }, [executionEvents]);

  // Derive the segments array (pure computation)
  const segments = useMemo(() => {
    const result = [...segmentsRef.current];
    if (streamingThought) {
      result.push({
        id: "streaming-thought",
        text: streamingThought,
        font: FONT_THOUGHT,
        type: "thought",
        createdAt: Date.now(),
      });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, streamingThought]);

  const isActive = executionEvents.some(
    (e) => e.type === "execution.started",
  ) && !executionEvents.some((e) => e.type === "execution.completed");

  // Clear pretext caches when execution finishes
  const prevActiveRef = useRef(false);
  useEffect(() => {
    if (prevActiveRef.current && !isActive) {
      // Execution just completed — schedule cache clear after fade-out
      const timer = setTimeout(clearLayoutCache, 10_000);
      return () => clearTimeout(timer);
    }
    prevActiveRef.current = isActive;
  }, [isActive]);

  return { segments, isActive };
}
