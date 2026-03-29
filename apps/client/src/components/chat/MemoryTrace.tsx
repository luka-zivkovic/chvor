import { useState } from "react";
import type { MemoryRetrievalTrace, MemoryRetrievalTraceEntry } from "@chvor/shared";

const CATEGORY_COLORS: Record<string, string> = {
  profile: "#8b5cf6",
  preference: "#06b6d4",
  entity: "#f59e0b",
  event: "#ef4444",
  pattern: "#10b981",
  case: "#6366f1",
};

function ScoreBar({ score, label }: { score: number; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-16 text-[9px] text-muted-foreground/50">{label}</span>
      <div className="h-1 flex-1 rounded-full bg-border/30">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{
            width: `${Math.min(100, score * 100)}%`,
            background: "var(--primary)",
            opacity: 0.5 + score * 0.5,
          }}
        />
      </div>
      <span className="w-7 text-right font-mono text-[9px] text-muted-foreground/40">
        {(score * 100).toFixed(0)}
      </span>
    </div>
  );
}

function TraceEntry({ entry, expanded }: { entry: MemoryRetrievalTraceEntry; expanded: boolean }) {
  const [showScores, setShowScores] = useState(false);
  const catColor = CATEGORY_COLORS[entry.category] ?? "#888";

  return (
    <div className="group rounded-md border border-border/20 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-wider"
          style={{ background: catColor + "20", color: catColor }}
        >
          {entry.category}
        </span>
        <span className="min-w-0 truncate text-[10px] text-muted-foreground">
          {entry.abstract}
        </span>
        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/30">
          {entry.source === "direct" ? "direct" : entry.source === "associated" ? "linked" : "predicted"}
        </span>
        {expanded && (
          <button
            onClick={() => setShowScores(!showScores)}
            className="shrink-0 text-[9px] text-primary/50 hover:text-primary transition-colors"
          >
            {showScores ? "hide" : "scores"}
          </button>
        )}
      </div>

      {/* Composite score bar (always visible in expanded) */}
      {expanded && (
        <div className="mt-1 h-1 rounded-full bg-border/20">
          <div
            className="h-full rounded-full bg-primary/40"
            style={{ width: `${Math.min(100, entry.scores.composite * 100)}%` }}
          />
        </div>
      )}

      {/* Detailed score breakdown */}
      {showScores && (
        <div className="mt-1.5 space-y-0.5">
          <ScoreBar score={entry.scores.vector} label="vector" />
          <ScoreBar score={entry.scores.strength} label="strength" />
          <ScoreBar score={entry.scores.recency} label="recency" />
          <ScoreBar score={entry.scores.categoryRelevance} label="category" />
          {entry.scores.emotionalResonance != null && (
            <ScoreBar score={entry.scores.emotionalResonance} label="emotion" />
          )}
        </div>
      )}
    </div>
  );
}

export function MemoryTrace({ trace }: { trace: MemoryRetrievalTrace }) {
  const [expanded, setExpanded] = useState(false);

  if (trace.entries.length === 0) return null;

  return (
    <div className="mt-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground/60"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="font-mono">
          {trace.entries.length} memor{trace.entries.length === 1 ? "y" : "ies"} retrieved
        </span>
        {trace.durationMs > 0 && (
          <span className="text-muted-foreground/25">
            {trace.durationMs}ms
          </span>
        )}
        {trace.categoriesDetected.length > 0 && (
          <span className="text-muted-foreground/25">
            [{trace.categoriesDetected.join(", ")}]
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1 pl-4">
          {trace.entries.map((entry) => (
            <TraceEntry key={entry.memoryId} entry={entry} expanded={expanded} />
          ))}
        </div>
      )}
    </div>
  );
}
