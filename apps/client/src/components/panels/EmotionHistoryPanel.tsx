import { useEffect, useRef, useState } from "react";
import { useRuntimeStore } from "../../stores/runtime-store";
import { EmotionSparkline } from "../canvas/EmotionSparkline";
import { getEmotionDisplayColor } from "../../lib/emotion-colors";
import type { EmotionSnapshot } from "@chvor/shared";
import { api } from "../../lib/api";

interface PatternData {
  frequencies: Record<string, number>;
  avgVAD: { valence: number; arousal: number; dominance: number };
  totalSnapshots: number;
}

export function EmotionHistoryPanel() {
  const sessionHistory = useRuntimeStore((s) => s.sessionHistory);
  const currentSnapshot = useRuntimeStore((s) => s.currentSnapshot);
  const distanceFromHome = useRuntimeStore((s) => s.distanceFromHome);
  const [patterns, setPatterns] = useState<PatternData | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const sparklineRef = useRef<HTMLDivElement>(null);
  const [sparklineWidth, setSparklineWidth] = useState(280);

  // Debounce pattern loading — only fetch once after history stabilizes (5s)
  useEffect(() => {
    const timer = setTimeout(() => {
      api.get<PatternData>("/emotions/patterns?days=30")
        .then(setPatterns)
        .catch((e: unknown) => console.warn("[emotion] failed to load patterns:", e));
    }, 5000);
    return () => clearTimeout(timer);
  }, [sessionHistory.length]);

  useEffect(() => {
    const el = sparklineRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSparklineWidth(Math.floor(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const filtered = filter
    ? sessionHistory.filter((s) => s.blend.primary.emotion === filter)
    : sessionHistory;

  const uniqueEmotions = [...new Set(sessionHistory.map((s) => s.blend.primary.emotion))];

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Sparkline header */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wider opacity-50">
          Session Arc
        </span>
        <div ref={sparklineRef} className="w-full">
          <EmotionSparkline
            snapshots={sessionHistory}
            width={sparklineWidth}
            height={28}
          />
        </div>
      </div>

      {/* Current state summary */}
      {currentSnapshot && (
        <div
          className="rounded-lg border p-3"
          style={{
            borderColor: `color-mix(in oklch, ${getEmotionDisplayColor(currentSnapshot)} 30%, transparent)`,
            background: `color-mix(in oklch, ${getEmotionDisplayColor(currentSnapshot)} 5%, transparent)`,
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: getEmotionDisplayColor(currentSnapshot) }}
              />
              <span className="text-xs font-medium">
                {currentSnapshot.displayLabel}
              </span>
              {currentSnapshot.blend.secondary && (
                <span className="text-[10px] opacity-50">
                  + {currentSnapshot.blend.secondary.emotion.replace(/_/g, " ")}
                </span>
              )}
            </div>
            <span className="font-mono text-[10px] opacity-40">
              {(currentSnapshot.blend.intensity * 100).toFixed(0)}%
            </span>
          </div>
          <div className="mt-1.5 flex gap-3 font-mono text-[9px] opacity-40">
            <span>V:{currentSnapshot.vad.valence.toFixed(2)}</span>
            <span>A:{currentSnapshot.vad.arousal.toFixed(2)}</span>
            <span>D:{currentSnapshot.vad.dominance.toFixed(2)}</span>
            {distanceFromHome > 0 && (
              <span>{distanceFromHome.toFixed(2)} from home</span>
            )}
          </div>
        </div>
      )}

      {/* Filter pills */}
      {uniqueEmotions.length > 1 && (
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setFilter(null)}
            className={`rounded-full px-2 py-0.5 text-[9px] transition-colors ${
              !filter ? "bg-white/10 text-white" : "opacity-40 hover:opacity-70"
            }`}
          >
            all
          </button>
          {uniqueEmotions.map((e) => (
            <button
              key={e}
              onClick={() => setFilter(filter === e ? null : e)}
              className={`rounded-full px-2 py-0.5 text-[9px] transition-colors ${
                filter === e ? "bg-white/10 text-white" : "opacity-40 hover:opacity-70"
              }`}
            >
              {e}
            </button>
          ))}
        </div>
      )}

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1.5">
          {filtered.length === 0 && (
            <div className="py-8 text-center text-[11px] opacity-30">
              No emotion data yet. Start a conversation.
            </div>
          )}
          {[...filtered].reverse().map((s) => (
            <TimelineEntry key={s.id || s.timestamp} snapshot={s} />
          ))}
        </div>
      </div>

      {/* Cross-conversation patterns */}
      {patterns && patterns.totalSnapshots > 0 && (
        <div className="border-t border-white/5 pt-3">
          <details>
            <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wider opacity-50 hover:opacity-70">
              30-Day Patterns ({patterns.totalSnapshots} snapshots)
            </summary>
            <div className="mt-2 flex flex-col gap-1.5">
              {Object.entries(patterns.frequencies)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 8)
                .map(([emotion, count]) => (
                  <div key={emotion} className="flex items-center gap-2">
                    <span className="w-20 text-[10px] truncate">{emotion}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-white/5">
                      <div
                        className="h-full rounded-full bg-white/20"
                        style={{
                          width: `${(count / patterns.totalSnapshots) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="font-mono text-[9px] opacity-30">{count}</span>
                  </div>
                ))}
              <div className="mt-1 font-mono text-[9px] opacity-30">
                Avg VAD: V:{patterns.avgVAD.valence.toFixed(2)} A:{patterns.avgVAD.arousal.toFixed(2)} D:{patterns.avgVAD.dominance.toFixed(2)}
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function TimelineEntry({ snapshot }: { snapshot: EmotionSnapshot }) {
  const color = getEmotionDisplayColor(snapshot);
  const time = new Date(snapshot.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-white/[0.02]">
      <div
        className="mt-1 h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <div className="flex flex-1 flex-col gap-0.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium">{snapshot.displayLabel}</span>
          <span className="font-mono text-[9px] opacity-30">{time}</span>
        </div>
        {snapshot.blend.secondary && (
          <span className="text-[9px] opacity-40">
            + {snapshot.blend.secondary.emotion.replace(/_/g, " ")} ({(snapshot.blend.secondary.weight * 100).toFixed(0)}%)
          </span>
        )}
        {/* Intensity bar */}
        <div className="h-1 w-full rounded-full bg-white/5">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${snapshot.blend.intensity * 100}%`,
              backgroundColor: color,
              opacity: 0.6,
            }}
          />
        </div>
      </div>
    </div>
  );
}
