import { useState, useEffect } from "react";
import { toast } from "sonner";
import type { Schedule, Workspace, DeliveryTarget } from "@chvor/shared";
import { useFeatureStore } from "../../stores/feature-store";
import { api } from "../../lib/api";
import type { ChannelTargetDTO } from "../../lib/api";
import { cronToHuman } from "../../lib/cron-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface Props {
  onClose: () => void;
  schedule?: Schedule;
}

export function ScheduleFormDialog({ onClose, schedule }: Props) {
  const isEdit = !!schedule;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const { addSchedule, updateSchedule } = useFeatureStore();
  const [name, setName] = useState(schedule?.name ?? "");
  const [cronExpression, setCronExpression] = useState(
    schedule?.cronExpression ?? ""
  );
  const [workspaceId, setWorkspaceId] = useState(schedule?.workspaceId ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channelTargets, setChannelTargets] = useState<ChannelTargetDTO[]>([]);
  const [deliverTo, setDeliverTo] = useState<DeliveryTarget[]>(
    schedule?.deliverTo ?? []
  );

  useEffect(() => {
    api.workspaces.list().then(setWorkspaces).catch(() => toast.error("Failed to load workspaces"));
    api.sessions.targets().then(setChannelTargets).catch(() => toast.error("Failed to load channels"));
  }, []);

  const canSave =
    name.trim() && cronExpression.trim() && workspaceId && prompt.trim();

  const cronPreview = cronExpression.trim()
    ? cronToHuman(cronExpression.trim())
    : null;

  const toggleTarget = (ct: ChannelTargetDTO) => {
    const key = `${ct.channelType}:${ct.channelId}`;
    const exists = deliverTo.some(
      (d) => `${d.channelType}:${d.channelId}` === key
    );
    if (exists) {
      setDeliverTo(deliverTo.filter((d) => `${d.channelType}:${d.channelId}` !== key));
    } else {
      setDeliverTo([...deliverTo, {
        channelType: ct.channelType as DeliveryTarget["channelType"],
        channelId: ct.channelId,
        label: `${ct.channelType} — ${ct.channelId}`,
      }]);
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const deliverToPayload = deliverTo.length > 0 ? deliverTo : null;
    try {
      if (isEdit) {
        const updated = await api.schedules.update(schedule.id, {
          name: name.trim(),
          cronExpression: cronExpression.trim(),
          prompt: prompt.trim(),
          workspaceId,
          deliverTo: deliverToPayload,
        });
        updateSchedule(schedule.id, updated);
      } else {
        const created = await api.schedules.create({
          name: name.trim(),
          cronExpression: cronExpression.trim(),
          prompt: prompt.trim(),
          workspaceId,
          deliverTo: deliverToPayload,
        });
        addSchedule(created);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="animate-scale-in w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
        <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {isEdit ? "Edit Schedule" : "New Schedule"}
        </h2>
        <p className="mb-4 text-[10px] text-muted-foreground/70">
          {isEdit
            ? "Update this scheduled task"
            : "Automate a recurring task"}
        </p>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Name
            </Label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Daily news summary"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Cron
              <span className="ml-1 font-normal normal-case text-muted-foreground/60">
                min hr dom mon dow
              </span>
            </Label>
            <Input
              type="text"
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              placeholder="0 9 * * *"
              className="font-mono"
            />
            {cronPreview && cronPreview !== cronExpression.trim() ? (
              <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] text-primary self-start">
                {cronPreview}
              </span>
            ) : (
              <span className="font-mono text-[9px] text-muted-foreground/60">
                0 9 * * * daily 9am · */30 * * * * every 30m · 0 0 * * 1
                Mondays
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Workspace
            </Label>
            <select
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">Select...</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.mode})
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Prompt
            </Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Summarize today's top tech news"
              rows={3}
              className="resize-none"
            />
          </div>

          {/* Deliver to channels */}
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Deliver to
              <span className="ml-1 font-normal normal-case text-muted-foreground/60">
                optional
              </span>
            </Label>
            {channelTargets.length > 0 ? (
              <div className="flex flex-col gap-1.5 rounded-md border border-border/50 bg-muted/20 p-2">
                {channelTargets.map((ct) => {
                  const key = `${ct.channelType}:${ct.channelId}`;
                  const checked = deliverTo.some(
                    (d) => `${d.channelType}:${d.channelId}` === key
                  );
                  return (
                    <label
                      key={key}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/40"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTarget(ct)}
                        className="h-3 w-3 rounded border-border accent-primary"
                      />
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {ct.channelType}
                      </span>
                      <span className="font-mono text-[10px] text-foreground/60">
                        {ct.channelId}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground/60">
                No external channels used yet. Message Chvor from Telegram, Discord, or Slack first.
              </p>
            )}
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-[10px] text-destructive">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} className="text-[10px]">
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave || saving} className="text-[10px]">
            {saving ? "Saving..." : isEdit ? "Save Changes" : "Add Schedule"}
          </Button>
        </div>
      </div>
    </div>
  );
}
