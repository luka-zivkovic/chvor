import { useEffect, useMemo, useState } from "react";
import type { CognitiveLoopRun } from "@chvor/shared";
import { useRuntimeStore } from "../../stores/runtime-store";
import { useUIStore } from "../../stores/ui-store";
import { api, type CognitiveLoopDiffResponse } from "../../lib/api";

function stageLabel(stage: string): string {
  return stage.replace(/\./g, " › ");
}

function severityColor(severity: string): string {
  if (severity === "critical") return "oklch(0.67 0.19 25)";
  if (severity === "warning") return "oklch(0.74 0.15 75)";
  return "oklch(0.70 0.14 220)";
}

function branchSourceLoopId(
  events: Array<{ metadata: Record<string, unknown> | null }>
): string | null {
  for (const event of events) {
    const sourceLoopId = event.metadata?.sourceLoopId;
    if (typeof sourceLoopId === "string" && sourceLoopId.trim()) return sourceLoopId.trim();
  }
  return null;
}

export function CognitiveLoopRail() {
  const loops = useRuntimeStore((s) => s.cognitiveLoops);
  const activeLoop = useRuntimeStore((s) => s.activeCognitiveLoop);
  const selectedCognitiveLoopId = useRuntimeStore((s) => s.selectedCognitiveLoopId);
  const cognitiveLoopSelectionLoading = useRuntimeStore((s) => s.cognitiveLoopSelectionLoading);
  const eventsByLoop = useRuntimeStore((s) => s.cognitiveLoopEvents);
  const selectCognitiveLoop = useRuntimeStore((s) => s.selectCognitiveLoop);
  const branchCognitiveLoop = useRuntimeStore((s) => s.branchCognitiveLoop);
  const openPreviewModal = useUIStore((s) => s.openPreviewModal);
  const [dismissedLoopId, setDismissedLoopId] = useState<string | null>(null);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [branching, setBranching] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diff, setDiff] = useState<CognitiveLoopDiffResponse | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branches, setBranches] = useState<CognitiveLoopRun[]>([]);
  const activeLoopId = activeLoop?.id;
  const events = useMemo(
    () => (activeLoopId ? (eventsByLoop[activeLoopId] ?? []) : []),
    [activeLoopId, eventsByLoop]
  );
  const recentEvents = useMemo(() => events.slice(-5).reverse(), [events]);
  const selectedIndex =
    events.length === 0 ? -1 : Math.min(scrubIndex ?? events.length - 1, events.length - 1);
  const selectedEvent = selectedIndex >= 0 ? events[selectedIndex] : null;
  const sourceLoopId = useMemo(
    () => activeLoop?.parentLoopId ?? branchSourceLoopId(events),
    [activeLoop?.parentLoopId, events]
  );

  useEffect(() => {
    if (activeLoop && dismissedLoopId !== null && activeLoop.id !== dismissedLoopId)
      setDismissedLoopId(null);
  }, [activeLoop, dismissedLoopId]);

  useEffect(() => {
    setScrubIndex(null);
    setDiff(null);
  }, [activeLoopId, events.length]);

  useEffect(() => {
    if (!activeLoopId) {
      setBranchesLoading(false);
      setBranches([]);
      return;
    }
    let cancelled = false;
    setBranches([]);
    setBranchesLoading(true);
    api.cognitiveLoops
      .branches(activeLoopId, 8)
      .then((result) => {
        if (!cancelled) setBranches(result.branches);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[cognitive-loop] failed to load branches:", err);
        setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeLoopId, loops.length]);

  if (!activeLoop) return null;
  if (dismissedLoopId === activeLoop.id && activeLoop.status !== "running") return null;

  const color = severityColor(activeLoop.severity);
  const isRunning = activeLoop.status === "running";
  const isPaused = activeLoop.status === "paused";
  const isLiveSelection = selectedCognitiveLoopId === activeLoop.id && isRunning;
  const compareWithSource = async () => {
    if (!sourceLoopId || diffLoading) return;
    setDiffLoading(true);
    try {
      setDiff(await api.cognitiveLoops.diff(activeLoop.id));
    } catch (err) {
      void import("sonner").then(({ toast }) => {
        toast.error(err instanceof Error ? err.message : "Failed to compare branch");
      });
    } finally {
      setDiffLoading(false);
    }
  };
  const branchFromSelected = async () => {
    if (!selectedEvent || branching) return;
    const instruction = window.prompt(
      "Optional branch instruction. Leave blank to continue safely from this event.",
      ""
    );
    if (instruction === null) return;
    setBranching(true);
    try {
      await branchCognitiveLoop(activeLoop.id, selectedEvent.id, instruction.trim() || undefined);
      void import("sonner").then(({ toast }) => {
        toast.success("Branched cognitive loop from selected event");
      });
    } catch (err) {
      void import("sonner").then(({ toast }) => {
        toast.error(err instanceof Error ? err.message : "Failed to branch loop");
      });
    } finally {
      setBranching(false);
    }
  };

  return (
    <div className="pointer-events-none absolute left-5 top-5 z-20 w-[360px] max-w-[calc(100vw-2.5rem)]">
      <div
        className="pointer-events-auto overflow-hidden rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-xl"
        style={{
          borderColor: `${color}66`,
          background:
            "linear-gradient(145deg, oklch(0.16 0.006 285 / 0.92), oklch(0.11 0.004 285 / 0.78))",
          boxShadow: `0 0 40px ${color}22, inset 0 1px 0 oklch(1 0 0 / 0.08)`,
        }}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-white/45">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{
                  background: color,
                  boxShadow: isRunning ? `0 0 16px ${color}` : undefined,
                }}
              />
              cognitive loop
            </div>
            <div className="truncate text-sm font-semibold text-white">{activeLoop.title}</div>
            <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/60">
              {activeLoop.summary}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] uppercase tracking-wide text-white/65">
              {activeLoop.status}
            </div>
            {activeLoop.status !== "running" && (
              <button
                type="button"
                aria-label="Dismiss cognitive loop"
                className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/45 transition hover:bg-white/10 hover:text-white"
                onClick={() => setDismissedLoopId(activeLoop.id)}
              >
                ×
              </button>
            )}
          </div>
        </div>

        {loops.length > 1 && (
          <label className="mb-3 block text-[10px] uppercase tracking-[0.18em] text-white/35">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span>timeline</span>
              <span className="font-mono normal-case tracking-normal text-white/45">
                {cognitiveLoopSelectionLoading ? "loading…" : isLiveSelection ? "live" : "history"}
              </span>
            </div>
            <select
              value={selectedCognitiveLoopId ?? activeLoop.id}
              className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-black/30 px-2 text-xs normal-case tracking-normal text-white/75 outline-none transition hover:bg-white/5 focus:border-white/25"
              onChange={(event) => void selectCognitiveLoop(event.target.value)}
            >
              {loops.map((loop) => (
                <option key={loop.id} value={loop.id}>
                  {loop.status.toUpperCase()} · {loop.title}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="mb-3 h-1 overflow-hidden rounded-full bg-white/8">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width:
                activeLoop.status === "completed"
                  ? "100%"
                  : activeLoop.status === "failed"
                    ? "100%"
                    : `${Math.min(90, 18 + events.length * 12)}%`,
              background:
                activeLoop.status === "failed"
                  ? "oklch(0.62 0.20 25)"
                  : isPaused
                    ? "oklch(0.55 0.02 285)"
                    : color,
              boxShadow: isPaused ? "none" : `0 0 18px ${color}88`,
              opacity: isPaused ? 0.55 : 1,
            }}
          />
        </div>

        {activeLoop.currentStage && (
          <div className="mb-3 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 text-[11px] text-white/45">
            Current stage{" "}
            <span className="ml-1 text-white/70">{stageLabel(activeLoop.currentStage)}</span>
          </div>
        )}

        {sourceLoopId && (
          <div className="mb-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2 text-xs">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                  branch lineage
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-white/45">
                  from {sourceLoopId.slice(0, 8)}
                </div>
              </div>
              <button
                type="button"
                className="rounded-full border border-white/10 bg-white/8 px-3 py-1.5 text-[11px] text-white/70 transition hover:bg-white/12 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={diffLoading}
                onClick={() => void compareWithSource()}
              >
                {diffLoading ? "Comparing…" : diff ? "Refresh diff" : "Compare"}
              </button>
            </div>
            {diff && (
              <div className="space-y-2 border-t border-white/8 pt-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-black/20 px-2 py-1.5">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-white/30">
                      source
                    </div>
                    <div className="mt-0.5 truncate text-white/65">
                      {diff.sourceEvent?.title ?? diff.sourceLoop.title}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-white/35">
                      {diff.comparison.sourceStatus} · {diff.comparison.sourceEventCount} events
                    </div>
                  </div>
                  <div className="rounded-lg bg-black/20 px-2 py-1.5">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-white/30">
                      branch
                    </div>
                    <div className="mt-0.5 truncate text-white/65">{diff.branchLoop.title}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-white/35">
                      {diff.comparison.branchStatus} · {diff.comparison.branchEventCount} events
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-white/55 transition hover:bg-white/8 hover:text-white"
                  onClick={() => void selectCognitiveLoop(diff.sourceLoop.id)}
                >
                  Open source loop
                </button>
              </div>
            )}
          </div>
        )}

        {(branchesLoading || branches.length > 0) && (
          <div className="mb-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2 text-xs">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                  branches from this loop
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-white/45">
                  {branchesLoading
                    ? "loading…"
                    : `${branches.length} branch${branches.length === 1 ? "" : "es"}`}
                </div>
              </div>
            </div>
            {branches.length > 0 && (
              <div className="space-y-1.5 border-t border-white/8 pt-2">
                {branches.map((branch) => (
                  <button
                    key={branch.id}
                    type="button"
                    className="w-full rounded-lg border border-white/8 bg-black/20 px-2 py-1.5 text-left transition hover:bg-white/8"
                    onClick={() => void selectCognitiveLoop(branch.id)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-medium text-white/70">
                          {branch.title}
                        </div>
                        <div className="mt-0.5 line-clamp-1 text-[10px] text-white/35">
                          {branch.branchReason || branch.summary}
                        </div>
                      </div>
                      <div className="shrink-0 rounded-full border border-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/45">
                        {branch.status}
                      </div>
                    </div>
                    <div className="mt-1 font-mono text-[9px] text-white/30">
                      {new Date(branch.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {branch.parentEventId ? ` · ${branch.parentEventId.slice(0, 8)}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {events.length > 0 && (
          <div className="mb-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.18em] text-white/35">
              <span>replay scrubber</span>
              <span className="font-mono normal-case tracking-normal text-white/55">
                {selectedIndex + 1}/{events.length}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, events.length - 1)}
              value={selectedIndex}
              className="w-full accent-white/70"
              aria-label="Scrub cognitive loop timeline"
              onChange={(event) => setScrubIndex(Number(event.target.value))}
            />
            {selectedEvent && (
              <div className="mt-2 border-t border-white/8 pt-2 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-white/80">{selectedEvent.title}</div>
                    <div className="mt-0.5 truncate text-[11px] text-white/40">
                      {stageLabel(selectedEvent.stage)}
                    </div>
                  </div>
                  <div className="shrink-0 font-mono text-[11px] text-white/35">
                    {new Date(selectedEvent.ts).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
                {selectedEvent.body && (
                  <div className="mt-2 line-clamp-3 rounded-lg bg-black/20 px-2 py-1.5 text-[11px] leading-relaxed text-white/50">
                    {selectedEvent.body}
                  </div>
                )}
                <button
                  type="button"
                  className="mt-2 rounded-full border border-white/10 bg-white/8 px-3 py-1.5 text-[11px] text-white/70 transition hover:bg-white/12 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={branching}
                  onClick={() => void branchFromSelected()}
                >
                  {branching ? "Branching…" : "Branch from here"}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          {recentEvents.length === 0 ? (
            <div className="text-xs text-white/45">Waiting for loop events…</div>
          ) : (
            recentEvents.map((event) => (
              <div key={event.id} className="grid grid-cols-[74px_1fr] gap-2 text-xs">
                <div className="font-mono text-white/35">
                  {new Date(event.ts).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-white/75">{event.title}</div>
                  <div className="truncate text-[11px] text-white/35">
                    {stageLabel(event.stage)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {activeLoop.surfaceId && (
          <button
            type="button"
            className="mt-3 rounded-full border border-white/10 bg-white/8 px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/12 hover:text-white"
            onClick={() => openPreviewModal(activeLoop.surfaceId ?? undefined)}
          >
            Open loop dashboard
          </button>
        )}
      </div>
    </div>
  );
}
