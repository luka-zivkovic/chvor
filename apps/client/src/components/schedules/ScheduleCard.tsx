import { useState } from "react";
import { toast } from "sonner";
import type { Schedule } from "@chvor/shared";
import { useScheduleStore } from "../../stores/schedule-store";
import { api } from "../../lib/api";
import { cronToHuman, getNextRun, formatRelativeTime } from "../../lib/cron-utils";
import { ScheduleFormDialog } from "./ScheduleFormDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Props {
  schedule: Schedule;
}

export function ScheduleCard({ schedule }: Props) {
  const { removeSchedule, updateSchedule } = useScheduleStore();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const humanCron = cronToHuman(schedule.cronExpression);
  const nextRun = schedule.enabled ? getNextRun(schedule.cronExpression) : null;
  const lastStatus = schedule.lastError
    ? "error"
    : schedule.lastResult
      ? "success"
      : null;

  const handleToggle = async () => {
    setToggling(true);
    try {
      const updated = await api.schedules.toggle(schedule.id, !schedule.enabled);
      updateSchedule(schedule.id, updated);
    } finally {
      setToggling(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await api.schedules.delete(schedule.id);
      removeSchedule(schedule.id);
    } catch (err) {
      toast.error(`Failed to delete schedule: ${err instanceof Error ? err.message : String(err)}`);
      setConfirmDelete(false);
    }
  };

  return (
    <>
      <Card
        className={cn(
          "border-l-2 transition-colors",
          schedule.enabled ? "border-l-green-500/60" : "border-l-border"
        )}
      >
        <CardContent className="p-4">
          {/* Row 1: Status + cron human + actions */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge
                variant={schedule.enabled ? "success" : "secondary"}
                className="gap-1 text-[10px]"
              >
                <span
                  className={cn(
                    "h-1 w-1 rounded-full",
                    schedule.enabled ? "bg-green-400" : "bg-muted-foreground"
                  )}
                />
                {schedule.enabled ? "Active" : "Paused"}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {humanCron}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                className="h-auto px-2 py-1 text-[10px]"
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleToggle}
                disabled={toggling}
                className="h-auto px-2 py-1 text-[10px]"
              >
                {toggling ? "..." : schedule.enabled ? "Pause" : "Enable"}
              </Button>
              <Button
                variant={confirmDelete ? "destructive" : "ghost"}
                size="sm"
                onClick={handleDelete}
                onBlur={() => setConfirmDelete(false)}
                className="h-auto px-2 py-1 text-[10px]"
              >
                {confirmDelete ? "Confirm?" : "Del"}
              </Button>
            </div>
          </div>

          {/* Row 2: Name (clickable → drill-down) */}
          <p
            className="mt-2 text-sm font-semibold cursor-pointer hover:text-primary transition-colors"
            onClick={() => useScheduleStore.getState().selectSchedule(schedule.id)}
          >
            {schedule.name}
          </p>

          {/* Row 3: Prompt (expandable) */}
          <p
            className={cn(
              "mt-1 cursor-pointer text-xs text-muted-foreground",
              !expanded && "line-clamp-2"
            )}
            onClick={() => setExpanded(!expanded)}
          >
            {schedule.prompt}
          </p>

          {/* Row 4: Next run + Last run */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px]">
            {nextRun && (
              <span className="text-primary">
                Next: {formatRelativeTime(nextRun)}
              </span>
            )}
            {schedule.lastRunAt && (
              <span
                className={cn(
                  lastStatus === "error"
                    ? "text-destructive"
                    : lastStatus === "success"
                      ? "text-green-400"
                      : "text-muted-foreground"
                )}
              >
                Last: {new Date(schedule.lastRunAt).toLocaleString()}
                {lastStatus === "error" ? " (failed)" : lastStatus === "success" ? " (ok)" : ""}
              </span>
            )}
          </div>

          {/* Row 5: Raw cron + delivery targets */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <code className="inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {schedule.cronExpression}
            </code>
            {schedule.deliverTo && schedule.deliverTo.length > 0 &&
              schedule.deliverTo.map((t) => (
                <span
                  key={`${t.channelType}-${t.channelId}`}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary"
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 2L11 13" /><path d="M22 2L15 22L11 13L2 9L22 2Z" />
                  </svg>
                  {t.channelType}
                </span>
              ))
            }
          </div>
        </CardContent>
      </Card>

      {editing && (
        <ScheduleFormDialog
          schedule={schedule}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
