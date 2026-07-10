import { useEffect, useState } from "react";
import type { ChatType } from "@chvor/shared";
import { useConfigStore } from "../../../stores/config-store";
import { Button } from "@/components/ui/button";

const HOUR_OPTIONS = [
  { value: -1, label: "Disabled" },
  ...Array.from({ length: 24 }, (_, i) => ({
    value: i,
    label: `${String(i).padStart(2, "0")}:00`,
  })),
];

const CHAT_TYPES: { id: ChatType; label: string }[] = [
  { id: "dm", label: "Direct Messages" },
  { id: "group", label: "Group Chats" },
  { id: "thread", label: "Threads" },
];

export function SessionsContent() {
  const { sessionLifecycleConfig: config, fetchSessionLifecycleConfig: fetchConfig, updateSessionLifecycleConfig: updateConfig } = useConfigStore();
  const [triggerInput, setTriggerInput] = useState("");

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  if (!config) return <p className="text-xs text-muted-foreground">Loading...</p>;

  const addTrigger = () => {
    const t = triggerInput.trim();
    if (t && !config.resetTriggers.includes(t)) {
      updateConfig({ resetTriggers: [...config.resetTriggers, t] });
    }
    setTriggerInput("");
  };

  const removeTrigger = (trigger: string) => {
    updateConfig({ resetTriggers: config.resetTriggers.filter((t) => t !== trigger) });
  };

  return (
    <div className="flex flex-col gap-5">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Session Auto-Reset
      </h3>

      {/* Default policy */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Idle timeout (minutes)</label>
          <input
            type="number"
            min={0}
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={config.defaultPolicy.idleTimeoutMinutes}
            onChange={(e) =>
              updateConfig({ defaultPolicy: { idleTimeoutMinutes: Math.max(0, Number(e.target.value)) } })
            }
          />
        </div>
        <p className="text-[10px] text-muted-foreground/60">
          Reset session after N minutes of inactivity. 0 = disabled.
        </p>

        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Daily reset at hour</label>
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={config.defaultPolicy.dailyResetHour ?? -1}
            onChange={(e) => {
              const v = Number(e.target.value);
              updateConfig({ defaultPolicy: { dailyResetHour: v < 0 ? null : v } });
            }}
          >
            {HOUR_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Max messages per session</label>
          <input
            type="number"
            min={0}
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={config.defaultPolicy.maxMessages}
            onChange={(e) =>
              updateConfig({ defaultPolicy: { maxMessages: Math.max(0, Number(e.target.value)) } })
            }
          />
        </div>
        <p className="text-[10px] text-muted-foreground/60">
          Auto-reset after this many messages. 0 = unlimited.
        </p>
      </div>

      {/* Per-chat-type overrides */}
      <div className="border-t border-border pt-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Per-Chat-Type Overrides
        </h3>
        <p className="text-[10px] text-muted-foreground/60 mb-3">
          Leave at 0 / Disabled to use defaults above.
        </p>
        {CHAT_TYPES.map(({ id, label }) => {
          const policy = config.chatTypePolicies[id];
          return (
            <div key={id} className="mb-3 rounded-md border border-border/50 p-3">
              <p className="text-[11px] font-medium text-foreground mb-2">{label}</p>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-muted-foreground">Idle timeout</label>
                  <input
                    type="number"
                    min={0}
                    className="w-20 rounded-md border border-border bg-background px-2 py-1 text-[10px] text-foreground"
                    value={policy?.idleTimeoutMinutes ?? 0}
                    onChange={(e) =>
                      updateConfig({
                        chatTypePolicies: { [id]: { idleTimeoutMinutes: Math.max(0, Number(e.target.value)) } },
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-muted-foreground">Daily reset</label>
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1 text-[10px] text-foreground"
                    value={policy?.dailyResetHour ?? -1}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      updateConfig({
                        chatTypePolicies: { [id]: { dailyResetHour: v < 0 ? null : v } },
                      });
                    }}
                  >
                    {HOUR_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-muted-foreground">Max messages</label>
                  <input
                    type="number"
                    min={0}
                    className="w-20 rounded-md border border-border bg-background px-2 py-1 text-[10px] text-foreground"
                    value={policy?.maxMessages ?? 0}
                    onChange={(e) =>
                      updateConfig({
                        chatTypePolicies: { [id]: { maxMessages: Math.max(0, Number(e.target.value)) } },
                      })
                    }
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Reset triggers */}
      <div className="border-t border-border pt-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Reset Triggers
        </h3>
        <p className="text-[10px] text-muted-foreground/60 mb-2">
          Chat commands that reset the session (e.g. /new, /reset).
        </p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {config.resetTriggers.map((trigger) => (
            <span
              key={trigger}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] text-foreground"
            >
              {trigger}
              <button
                onClick={() => removeTrigger(trigger)}
                className="text-muted-foreground hover:text-destructive"
              >
                x
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-1.5">
          <input
            type="text"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            placeholder="/command"
            value={triggerInput}
            onChange={(e) => setTriggerInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTrigger();
              }
            }}
          />
          <Button size="sm" onClick={addTrigger}>
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}
