import { useEffect, useState, useMemo, useCallback } from "react";
import { useFeatureStore } from "../../stores/feature-store";
import { MemoryList } from "./MemoryList";
import { MemoryStatsView } from "./MemoryStatsView";
import { MemoryGraphButton, MemoryGraphOverlay } from "./MemoryGraphView";
import { MemoryTimeline } from "./MemoryTimeline";
import { cn } from "../../lib/utils";

type InsightTab = "overview" | "graph" | "timeline";

const TABS: { id: InsightTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "graph", label: "Graph" },
  { id: "timeline", label: "Timeline" },
];

export function MemoryInsightsDashboard() {
  const [tab, setTab] = useState<InsightTab>("overview");
  const { memories, memoriesLoading: loading, memoriesError: error, fetchMemories: fetchAll, fetchGraph, fetchStats, addMemory } = useFeatureStore();
  const [newFact, setNewFact] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [graphOpen, setGraphOpen] = useState(false);

  useEffect(() => {
    fetchAll();
    fetchGraph();
    fetchStats();
  }, [fetchAll, fetchGraph, fetchStats]);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const handleAddFact = useCallback(() => {
    if (newFact.trim()) {
      addMemory(newFact.trim());
      setNewFact("");
    }
  }, [newFact, addMemory]);

  const filtered = useMemo(
    () => debouncedSearch
      ? memories.filter((m) => m.abstract.toLowerCase().includes(debouncedSearch.toLowerCase()))
      : memories,
    [memories, debouncedSearch],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-tab navigation */}
      <div className="flex gap-1 rounded-md bg-muted/30 p-0.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex-1 rounded px-2 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] transition-colors",
              tab === t.id
                ? "bg-background text-primary shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "overview" && (
        <div className="flex flex-col gap-5">
          <MemoryStatsView />

          {/* Add fact + search (from original MemoryPanel) */}
          <div className="flex gap-2">
            <input
              value={newFact}
              onChange={(e) => setNewFact(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddFact(); }}
              placeholder="Add a fact..."
              className="h-8 flex-1 rounded border border-input bg-transparent px-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <button
              onClick={handleAddFact}
              disabled={!newFact.trim()}
              className="h-8 shrink-0 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Add
            </button>
          </div>

          {memories.length > 5 && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search memories..."
              className="h-8 rounded border border-input bg-transparent px-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          )}

          {loading && <p className="text-xs text-muted-foreground">Loading...</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {!loading && !error && <MemoryList memories={filtered} />}
        </div>
      )}

      {tab === "graph" && (
        <>
          <MemoryGraphButton onClick={() => setGraphOpen(true)} />
          {graphOpen && <MemoryGraphOverlay onClose={() => setGraphOpen(false)} />}
        </>
      )}
      {tab === "timeline" && <MemoryTimeline />}
    </div>
  );
}
