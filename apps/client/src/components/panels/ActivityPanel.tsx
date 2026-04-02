import { useEffect } from "react";
import { useActivityStore } from "../../stores/activity-store";
import { Badge } from "../ui/badge";
import type { ActivitySource } from "@chvor/shared";

const SOURCE_META: Record<ActivitySource, { label: string; color: string }> = {
  pulse: { label: "pulse", color: "text-rose-400" },
  schedule: { label: "schedule", color: "text-blue-400" },
  "self-healing": { label: "repair", color: "text-amber-400" },
  workflow: { label: "workflow", color: "text-emerald-400" },
  "credential-access": { label: "cred", color: "text-purple-400" },
  webhook: { label: "webhook", color: "text-cyan-400" },
  "pc-control": { label: "pc", color: "text-emerald-400" },
  daemon: { label: "daemon", color: "text-indigo-400" },
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function ActivityPanel() {
  const { activities, loading, unreadCount, fetchActivities, markRead, markAllRead } =
    useActivityStore();

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  return (
    <div className="flex flex-col gap-3 p-1">
      {unreadCount > 0 && (
        <div className="flex justify-end">
          <button
            onClick={markAllRead}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Mark all read
          </button>
        </div>
      )}

      {loading && activities.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-8">Loading...</p>
      )}

      {!loading && activities.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-8">
          No activity yet. Pulse alerts, schedule results, and repair actions will appear here.
        </p>
      )}

      {activities.map((a) => {
        const meta = SOURCE_META[a.source];
        return (
          <button
            key={a.id}
            onClick={() => !a.read && markRead(a.id)}
            className={`w-full text-left rounded-lg border p-3 transition-colors ${
              a.read
                ? "border-border/30 bg-muted/5"
                : "border-accent/30 bg-accent/5 border-l-2 border-l-accent"
            }`}
          >
            <div className="flex items-start gap-2">
              <span className={`text-[10px] font-semibold uppercase ${meta.color}`}>
                {meta.label}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground truncate">{a.title}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {formatRelativeTime(a.timestamp)}
                  </span>
                </div>
                {a.content && (
                  <p className="text-[11px] text-muted-foreground mt-1 line-clamp-3">
                    {a.content}
                  </p>
                )}
                <Badge variant="outline" className="mt-1.5 text-[9px]">
                  {meta.label}
                </Badge>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
