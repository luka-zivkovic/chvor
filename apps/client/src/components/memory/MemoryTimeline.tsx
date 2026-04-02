import { useMemo, useState } from "react";
import { useMemoryStore } from "../../stores/memory-store";
import type { MemoryCategory } from "@chvor/shared";

const CATEGORY_COLORS: Record<string, string> = {
  profile: "border-blue-400",
  preference: "border-purple-400",
  entity: "border-green-400",
  event: "border-amber-400",
  pattern: "border-cyan-400",
  case: "border-rose-400",
};

const CATEGORY_BG: Record<string, string> = {
  profile: "bg-blue-400",
  preference: "bg-purple-400",
  entity: "bg-green-400",
  event: "bg-amber-400",
  pattern: "bg-cyan-400",
  case: "bg-rose-400",
};

const STRENGTH_COLOR = (s: number) =>
  s >= 0.6 ? "bg-green-400" : s >= 0.3 ? "bg-amber-400" : "bg-red-400";

export function MemoryTimeline() {
  const { memories, loading } = useMemoryStore();
  const [filter, setFilter] = useState<MemoryCategory | "all">("all");

  const sorted = useMemo(() => {
    let list = [...memories].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    if (filter !== "all") list = list.filter((m) => m.category === filter);
    return list;
  }, [memories, filter]);

  // Group by date
  const grouped = useMemo(() => {
    const groups: Map<string, typeof sorted> = new Map();
    for (const m of sorted) {
      const date = new Date(m.createdAt).toLocaleDateString();
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date)!.push(m);
    }
    return groups;
  }, [sorted]);

  if (loading) return <p className="text-xs text-muted-foreground">Loading...</p>;

  if (memories.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-xs text-muted-foreground">No memories yet</p>
        <p className="mt-1 text-[10px] text-muted-foreground/60">
          Memories form automatically as you chat
        </p>
      </div>
    );
  }

  const categories: Array<MemoryCategory | "all"> = ["all", "profile", "preference", "entity", "event", "pattern", "case"];

  return (
    <div className="flex flex-col gap-3">
      {/* Category filter */}
      <div className="flex flex-wrap gap-1">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={`rounded-full px-2 py-0.5 text-[9px] font-medium transition-colors ${
              filter === cat
                ? "bg-primary text-primary-foreground"
                : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Timeline */}
      <div className="max-h-[500px] space-y-4 overflow-y-auto pr-1">
        {[...grouped.entries()].map(([date, mems]) => (
          <div key={date}>
            <p className="mb-1.5 text-[10px] font-semibold text-muted-foreground">{date}</p>
            <div className="relative ml-2 border-l border-border/40 pl-4 space-y-2">
              {mems.map((m) => (
                <div
                  key={m.id}
                  className={`relative rounded-md border-l-2 ${CATEGORY_COLORS[m.category] ?? "border-gray-400"} bg-muted/10 px-3 py-2`}
                  style={{ opacity: Math.max(0.4, m.strength) }}
                >
                  {/* Dot on timeline */}
                  <span className={`absolute -left-[22px] top-2.5 h-2 w-2 rounded-full ${CATEGORY_BG[m.category] ?? "bg-gray-400"}`} />

                  <p className="text-xs text-foreground leading-relaxed">{m.abstract}</p>

                  <div className="mt-1.5 flex items-center gap-3 text-[9px] text-muted-foreground">
                    <span>{m.category}</span>
                    <span>{new Date(m.createdAt).toLocaleTimeString()}</span>

                    {/* Strength bar */}
                    <div className="flex items-center gap-1">
                      <span>str</span>
                      <div className="h-1 w-12 rounded-full bg-muted/30">
                        <div
                          className={`h-full rounded-full ${STRENGTH_COLOR(m.strength)}`}
                          style={{ width: `${m.strength * 100}%` }}
                        />
                      </div>
                      <span>{(m.strength * 100).toFixed(0)}%</span>
                    </div>

                    {m.accessCount > 0 && <span>{m.accessCount} accesses</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
