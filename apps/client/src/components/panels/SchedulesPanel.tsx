import { useEffect, useState } from "react";
import { useScheduleStore } from "../../stores/schedule-store";
import { usePulseStore } from "../../stores/pulse-store";
import { ScheduleList } from "../schedules/ScheduleList";
import { ScheduleFormDialog } from "../schedules/ScheduleFormDialog";
import { ScheduleDetail } from "../schedules/ScheduleDetail";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const INTERVAL_OPTIONS = [
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 360, label: "6 hours" },
];

type Filter = "all" | "active" | "paused";

function PulseSection() {
  const { pulse, fetchPulse, updatePulse } = usePulseStore();

  useEffect(() => {
    fetchPulse();
  }, [fetchPulse]);

  if (!pulse) return null;

  const formatTime = (iso: string | null) => {
    if (!iso) return "Never";
    return new Date(iso).toLocaleString();
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Pulse
            </h3>
            <p className="mt-0.5 text-[10px] text-muted-foreground/70">
              Periodic awareness — quiet unless something needs attention
            </p>
          </div>
          <Badge
            variant={pulse.enabled ? "success" : "secondary"}
            className="cursor-pointer"
            onClick={() => updatePulse({ enabled: !pulse.enabled })}
          >
            {pulse.enabled ? "Active" : "Off"}
          </Badge>
        </div>

        {pulse.enabled && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">Every</span>
            <select
              value={pulse.intervalMinutes}
              onChange={(e) =>
                updatePulse({ intervalMinutes: parseInt(e.target.value, 10) })
              }
              className="rounded border border-input bg-transparent px-2 py-0.5 font-mono text-[10px] text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {pulse.lastRunAt && (
          <>
            <Separator className="mt-3" />
            <div className="pt-2 font-mono text-[10px] text-muted-foreground">
              <span>Last: {formatTime(pulse.lastRunAt)}</span>
              {pulse.lastResult && (
                <span className="ml-2">
                  — {pulse.lastResult === "silent" ? "Nothing to report" : pulse.lastResult.slice(0, 60)}
                </span>
              )}
              {pulse.lastError && (
                <span className="ml-2 text-destructive">
                  — {pulse.lastError.slice(0, 60)}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatBox({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color?: string;
}) {
  return (
    <div className="flex-1 rounded-lg border border-border bg-muted/20 px-3 py-2 text-center">
      <p className="text-lg font-bold" style={{ color }}>
        {value}
      </p>
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

export function SchedulesPanel() {
  const { fetchAll, loading, error, schedules, selectedScheduleId, selectSchedule } = useScheduleStore();
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    fetchAll();
    return () => { selectSchedule(null); };
  }, [fetchAll, selectSchedule]);

  // Drill-down view
  if (selectedScheduleId) {
    return <ScheduleDetail />;
  }

  const filtered = schedules.filter((s) => {
    if (filter === "active") return s.enabled;
    if (filter === "paused") return !s.enabled;
    return true;
  });

  const activeCount = schedules.filter((s) => s.enabled).length;
  const pausedCount = schedules.length - activeCount;

  return (
    <div className="flex flex-col gap-5">
      <PulseSection />

      {/* Stats row */}
      {schedules.length > 0 && (
        <div className="flex items-center gap-3">
          <StatBox value={schedules.length} label="Total" />
          <StatBox value={activeCount} label="Active" color="oklch(0.7 0.18 145)" />
          <StatBox value={pausedCount} label="Paused" />
        </div>
      )}

      {/* Filter tabs + Add button */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(["all", "active", "paused"] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? "default" : "ghost"}
              size="sm"
              onClick={() => setFilter(f)}
              className={cn("text-[10px] capitalize", filter !== f && "text-muted-foreground")}
            >
              {f}
            </Button>
          ))}
        </div>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          + New Schedule
        </Button>
      </div>

      {loading && (
        <p className="text-xs text-muted-foreground">Loading...</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!loading && <ScheduleList schedules={filtered} />}

      {showAdd && <ScheduleFormDialog onClose={() => setShowAdd(false)} />}
    </div>
  );
}
