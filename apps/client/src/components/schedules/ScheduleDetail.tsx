import { useState, useEffect } from "react";
import type { ScheduleRun } from "@chvor/shared";
import { useScheduleStore } from "../../stores/schedule-store";
import { cronToHuman, getNextRun, formatRelativeTime } from "../../lib/cron-utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

function RunEntry({ run }: { run: ScheduleRun }) {
  const [expanded, setExpanded] = useState(false);
  const isError = run.status === "failed";
  const content = isError ? run.error : run.result;

  return (
    <Card
      className={cn(
        "border-l-2 cursor-pointer transition-colors",
        isError ? "border-l-destructive" : "border-l-green-500/60"
      )}
    >
      <CardContent className="p-3" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                isError ? "bg-destructive" : "bg-green-500"
              )}
            />
            <span className="font-mono text-[10px] text-muted-foreground">
              {new Date(run.startedAt).toLocaleString()}
            </span>
          </div>
          <Badge
            variant={isError ? "destructive" : "success"}
            className="text-[9px]"
          >
            {run.status}
          </Badge>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground line-clamp-1">
          {content ?? "No output"}
        </p>
        {expanded && content && (
          <pre className="mt-2 max-h-40 overflow-y-auto rounded bg-muted p-2 text-[10px] whitespace-pre-wrap">
            {content}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

export function ScheduleDetail() {
  const { schedules, selectedScheduleId, selectSchedule, runs, runsLoading } =
    useScheduleStore();
  const schedule = schedules.find((s) => s.id === selectedScheduleId);

  // Clear selection if schedule was deleted — via effect, not during render
  useEffect(() => {
    if (selectedScheduleId && !schedule) {
      selectSchedule(null);
    }
  }, [selectedScheduleId, schedule, selectSchedule]);

  if (!schedule) return null;

  const humanCron = cronToHuman(schedule.cronExpression);
  const nextRun = schedule.enabled ? getNextRun(schedule.cronExpression) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Back button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => selectSchedule(null)}
        className="self-start gap-1.5 px-2 text-xs text-muted-foreground"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 12L6 8L10 4" />
        </svg>
        Back to schedules
      </Button>

      {/* Schedule info */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{schedule.name}</h3>
            <Badge
              variant={schedule.enabled ? "success" : "secondary"}
              className="text-[10px]"
            >
              {schedule.enabled ? "Active" : "Paused"}
            </Badge>
          </div>

          <p className="mt-1 text-[11px] text-muted-foreground">{humanCron}</p>

          <p className="mt-2 text-xs text-muted-foreground">{schedule.prompt}</p>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px]">
            <code className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              {schedule.cronExpression}
            </code>
            {nextRun && (
              <span className="text-primary">
                Next: {formatRelativeTime(nextRun)}
              </span>
            )}
          </div>

          {schedule.deliverTo && schedule.deliverTo.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {schedule.deliverTo.map((t) => (
                <span
                  key={`${t.channelType}-${t.channelId}`}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary"
                >
                  {t.channelType}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Execution History */}
      <div>
        <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
          Execution History
        </h4>
        {runsLoading ? (
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No executions yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {runs.map((run) => (
              <RunEntry key={run.id} run={run} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
