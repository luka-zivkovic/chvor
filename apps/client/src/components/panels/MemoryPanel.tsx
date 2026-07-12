import { lazy, Suspense, useState } from "react";
import { cn } from "@/lib/utils";
import { StableMemoryBlocks } from "../memory/blocks/StableMemoryBlocks";

const MemoryInsightsDashboard = lazy(() =>
  import("../memory/MemoryInsightsDashboard").then((module) => ({
    default: module.MemoryInsightsDashboard,
  }))
);

type MemoryTab = "stable" | "associative";

const TABS: Array<{ id: MemoryTab; label: string }> = [
  { id: "stable", label: "Stable beliefs" },
  { id: "associative", label: "Associative memory" },
];

export function MemoryPanel() {
  const [tab, setTab] = useState<MemoryTab>("stable");

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Memory views"
        className="flex gap-1 rounded-md bg-muted/30 p-0.5"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            id={`memory-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`memory-tabpanel-${item.id}`}
            onClick={() => setTab(item.id)}
            className={cn(
              "flex-1 rounded px-2 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              tab === item.id
                ? "bg-background text-primary shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div id={`memory-tabpanel-${tab}`} role="tabpanel" aria-labelledby={`memory-tab-${tab}`}>
        {tab === "stable" ? (
          <StableMemoryBlocks />
        ) : (
          <Suspense
            fallback={
              <p role="status" className="text-xs text-muted-foreground">
                Loading associative memory…
              </p>
            }
          >
            <MemoryInsightsDashboard />
          </Suspense>
        )}
      </div>
    </div>
  );
}
