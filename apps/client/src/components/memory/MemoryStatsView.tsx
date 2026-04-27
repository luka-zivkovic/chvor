import { useFeatureStore } from "../../stores/feature-store";

const CATEGORY_COLORS: Record<string, string> = {
  profile: "bg-blue-400",
  preference: "bg-purple-400",
  entity: "bg-green-400",
  event: "bg-amber-400",
  pattern: "bg-cyan-400",
  case: "bg-rose-400",
};

const RELATION_COLORS: Record<string, string> = {
  temporal: "bg-gray-400",
  causal: "bg-red-400",
  semantic: "bg-blue-400",
  entity: "bg-green-400",
  contradiction: "bg-amber-400",
  supersedes: "bg-purple-400",
  narrative: "bg-cyan-400",
};

export function MemoryStatsView() {
  const { stats, statsLoading } = useFeatureStore();

  if (statsLoading) return <p className="text-xs text-muted-foreground">Loading stats...</p>;
  if (!stats) return null;

  const maxStrength = Math.max(...stats.strengthDistribution.map((b) => b.count), 1);

  return (
    <div className="flex flex-col gap-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Memories" value={stats.totalMemories} />
        <StatCard label="Connections" value={stats.totalEdges} />
        <StatCard label="Avg Strength" value={`${(stats.avgStrength * 100).toFixed(0)}%`} />
        <StatCard label="Avg Confidence" value={`${(stats.avgConfidence * 100).toFixed(0)}%`} />
      </div>

      {/* Category Breakdown */}
      {stats.categoryBreakdown.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Categories</h4>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted/30">
            {stats.categoryBreakdown.map((cat) => (
              <div
                key={cat.category}
                className={`${CATEGORY_COLORS[cat.category] ?? "bg-gray-400"} transition-all`}
                style={{ width: `${(cat.count / stats.totalMemories) * 100}%` }}
                title={`${cat.category}: ${cat.count}`}
              />
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {stats.categoryBreakdown.map((cat) => (
              <span key={cat.category} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${CATEGORY_COLORS[cat.category] ?? "bg-gray-400"}`} />
                {cat.category} ({cat.count})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Strength Distribution */}
      {stats.strengthDistribution.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Strength</h4>
          <div className="space-y-1">
            {stats.strengthDistribution.map((b) => (
              <div key={b.bucket} className="flex items-center gap-2">
                <span className="w-12 text-right font-mono text-[9px] text-muted-foreground">{b.bucket}</span>
                <div className="h-2 flex-1 rounded-full bg-muted/20">
                  <div
                    className="h-full rounded-full bg-primary/70 transition-all"
                    style={{ width: `${(b.count / maxStrength) * 100}%` }}
                  />
                </div>
                <span className="w-6 font-mono text-[9px] text-muted-foreground">{b.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Health Indicators */}
      <div className="flex gap-3 text-[10px]">
        <span className="text-muted-foreground">
          Last 7 days: <span className="text-foreground">{stats.recentCount7d} new</span>
        </span>
        {stats.weakCount > 0 && (
          <span className="text-amber-400">
            {stats.weakCount} fading
          </span>
        )}
      </div>

      {/* Relationship Types */}
      {stats.relationBreakdown.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Relationships</h4>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            {stats.relationBreakdown.map((r) => (
              <span key={r.relation} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${RELATION_COLORS[r.relation] ?? "bg-gray-400"}`} />
                {r.relation} ({r.count})
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border/30 bg-muted/10 px-3 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="font-mono text-sm font-semibold text-foreground">{String(value)}</p>
    </div>
  );
}
