import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChannelPolicy, ChannelPolicyDmMode, ChannelPolicyGroupMode } from "@chvor/shared";

const DM_MODES: { value: ChannelPolicyDmMode; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "allowlist", label: "Allowlist" },
  { value: "disabled", label: "Disabled" },
];

const GROUP_MODES: { value: ChannelPolicyGroupMode; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "allowlist", label: "Allowlist" },
  { value: "disabled", label: "Disabled" },
];

function ModeSelector({
  modes,
  value,
  onChange,
}: {
  modes: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1">
      {modes.map((m) => (
        <button
          key={m.value}
          onClick={() => onChange(m.value)}
          className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors ${
            value === m.value
              ? "bg-primary text-primary-foreground"
              : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function AllowlistEditor({
  items,
  onAdd,
  onRemove,
  placeholder,
}: {
  items: string[];
  onAdd: (v: string) => void;
  onRemove: (i: number) => void;
  placeholder: string;
}) {
  const [input, setInput] = useState("");

  const handleAdd = () => {
    const trimmed = input.trim();
    if (trimmed && !items.includes(trimmed)) {
      onAdd(trimmed);
      setInput("");
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {items.map((item, i) => (
            <span
              key={item}
              className="flex items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 text-[10px] font-mono text-foreground/80"
            >
              {item}
              <button
                onClick={() => onRemove(i)}
                className="text-muted-foreground hover:text-destructive"
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <Input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder={placeholder}
          className="h-7 text-[11px] font-mono"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={handleAdd}
          disabled={!input.trim()}
          className="h-7 text-[10px] px-2"
        >
          Add
        </Button>
      </div>
    </div>
  );
}

export function WhatsAppAccessControl() {
  const [policy, setPolicy] = useState<ChannelPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.whatsapp.getPolicy().then(setPolicy).catch(() => {});
  }, []);

  const save = async (updates: Parameters<typeof api.whatsapp.updatePolicy>[0]) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.whatsapp.updatePolicy(updates);
      setPolicy(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!policy) return null;

  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Access Control
      </h3>
      <div className="flex flex-col gap-3 rounded-xl border border-border/50 bg-muted/20 p-3">
        {/* DM Policy */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            DM Policy
          </span>
          <ModeSelector
            modes={DM_MODES}
            value={policy.dm.mode}
            onChange={(mode) => save({ dm: { mode: mode as ChannelPolicyDmMode } })}
          />
          {policy.dm.mode === "allowlist" && (
            <div className="mt-1">
              <span className="text-[9px] text-muted-foreground/60 mb-1 block">
                Phone numbers (digits only, e.g. 15551234567)
              </span>
              <AllowlistEditor
                items={policy.dm.allowlist}
                onAdd={(v) => save({ dm: { allowlist: [...policy.dm.allowlist, v] } })}
                onRemove={(i) =>
                  save({ dm: { allowlist: policy.dm.allowlist.filter((_, idx) => idx !== i) } })
                }
                placeholder="15551234567"
              />
            </div>
          )}
        </div>

        {/* Group Policy */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Group Policy
          </span>
          <ModeSelector
            modes={GROUP_MODES}
            value={policy.group.mode}
            onChange={(mode) => save({ group: { mode: mode as ChannelPolicyGroupMode } })}
          />
          {policy.group.mode === "allowlist" && (
            <div className="mt-1">
              <span className="text-[9px] text-muted-foreground/60 mb-1 block">
                Group JIDs (e.g. 120363012345678@g.us)
              </span>
              <AllowlistEditor
                items={policy.group.allowlist}
                onAdd={(v) => save({ group: { allowlist: [...policy.group.allowlist, v] } })}
                onRemove={(i) =>
                  save({
                    group: { allowlist: policy.group.allowlist.filter((_, idx) => idx !== i) },
                  })
                }
                placeholder="120363012345678@g.us"
              />
            </div>
          )}
        </div>

        {/* Group Sender Filter */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Group Sender Filter
            </span>
            <button
              onClick={() =>
                save({ groupSenderFilter: { enabled: !policy.groupSenderFilter.enabled } })
              }
              className={`relative h-4 w-7 rounded-full transition-colors ${
                policy.groupSenderFilter.enabled ? "bg-primary" : "bg-muted-foreground/30"
              }`}
            >
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                  policy.groupSenderFilter.enabled ? "left-3.5" : "left-0.5"
                }`}
              />
            </button>
          </div>
          {policy.groupSenderFilter.enabled && (
            <div className="mt-1">
              <span className="text-[9px] text-muted-foreground/60 mb-1 block">
                Only these senders can trigger the AI in groups
              </span>
              <AllowlistEditor
                items={policy.groupSenderFilter.allowlist}
                onAdd={(v) =>
                  save({
                    groupSenderFilter: {
                      allowlist: [...policy.groupSenderFilter.allowlist, v],
                    },
                  })
                }
                onRemove={(i) =>
                  save({
                    groupSenderFilter: {
                      allowlist: policy.groupSenderFilter.allowlist.filter((_, idx) => idx !== i),
                    },
                  })
                }
                placeholder="15551234567"
              />
            </div>
          )}
        </div>

        {saving && (
          <span className="text-[9px] text-muted-foreground/60">Saving...</span>
        )}
        {error && (
          <div className="rounded-md bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
            {error}
          </div>
        )}
      </div>
    </section>
  );
}
