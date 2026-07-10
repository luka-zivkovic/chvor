import { useState } from "react";
import { useConfigStore } from "../../../stores/config-store";
import { useFeatureStore } from "../../../stores/feature-store";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import type { LLMProviderDef, ModelRole, RoleFallbackEntry } from "@chvor/shared";
import { useDynamicModels } from "./useDynamicModels";

/* ─── Fallback List ─── */

export function FallbackList({ role }: { role: ModelRole }) {
  const { fallbacks, setFallbacks } = useConfigStore();
  const { credentials, llmProviders } = useFeatureStore();
  const [showAdd, setShowAdd] = useState(false);
  const [addProvider, setAddProvider] = useState<LLMProviderDef | null>(null);
  const [addModel, setAddModel] = useState("");
  const [addAlias, setAddAlias] = useState("");
  const { getModels, fetchModels } = useDynamicModels();

  const entries = fallbacks[role] ?? [];

  const availableProviders = llmProviders.filter((p) =>
    credentials.some(
      (c) => c.type === p.credentialType && c.testStatus !== "failed"
    )
  );

  const getProviderDef = (providerId: string) =>
    llmProviders.find((p) => p.id === providerId);

  const move = (idx: number, dir: -1 | 1) => {
    const newEntries = [...entries];
    const target = idx + dir;
    if (target < 0 || target >= newEntries.length) return;
    [newEntries[idx], newEntries[target]] = [newEntries[target], newEntries[idx]];
    setFallbacks(role, newEntries);
  };

  const remove = (idx: number) => {
    setFallbacks(role, entries.filter((_, i) => i !== idx));
  };

  const handleAdd = () => {
    if (!addProvider || !addModel.trim()) return;
    const model = addModel.trim();
    if (entries.some((e) => e.providerId === addProvider.id && e.model === model)) return;
    const entry: RoleFallbackEntry = {
      providerId: addProvider.id,
      model,
      ...(addAlias.trim() ? { alias: addAlias.trim() } : {}),
    };
    setFallbacks(role, [...entries, entry]);
    setShowAdd(false);
    setAddProvider(null);
    setAddModel("");
    setAddAlias("");
  };

  return (
    <div className="mt-3">
      <button
        onClick={() => setShowAdd(!showAdd && entries.length === 0 ? true : !showAdd)}
        className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={cn("transition-transform", (showAdd || entries.length > 0) && "rotate-90")}>
          <polyline points="9 6 15 12 9 18" />
        </svg>
        Fallback chain{entries.length > 0 && ` (${entries.length})`}
      </button>

      {(showAdd || entries.length > 0) && (
        <div className="mt-2 space-y-1.5">
          {entries.map((entry, idx) => {
            const pDef = getProviderDef(entry.providerId);
            return (
              <div
                key={`${entry.providerId}-${entry.model}-${idx}`}
                className="flex items-center gap-2 rounded-lg border border-border/30 bg-muted/5 px-2.5 py-1.5"
              >
                <span className="text-[9px] text-muted-foreground/50 w-3 shrink-0">{idx + 1}</span>
                {pDef && <ProviderIcon icon={pDef.icon} size={14} />}
                <span className="flex-1 truncate text-[11px] text-foreground">
                  {entry.alias ? (
                    <>{entry.alias} <span className="text-muted-foreground/50">({entry.model})</span></>
                  ) : (
                    entry.model
                  )}
                </span>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted/20 disabled:opacity-20 transition-colors"
                    title="Move up"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                  <button
                    onClick={() => move(idx, 1)}
                    disabled={idx === entries.length - 1}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted/20 disabled:opacity-20 transition-colors"
                    title="Move down"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <button
                    onClick={() => remove(idx)}
                    className="rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    title="Remove"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}

          {showAdd ? (
            <div className="space-y-2 rounded-lg border border-border/30 bg-muted/5 p-2.5">
              <div className="flex flex-wrap gap-1.5">
                {availableProviders.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setAddProvider(p);
                      fetchModels(p);
                      const models = getModels(p);
                      setAddModel(models[0]?.id ?? "");
                    }}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium transition-all",
                      addProvider?.id === p.id
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                    )}
                  >
                    <ProviderIcon icon={p.icon} size={14} />
                    {p.name}
                  </button>
                ))}
              </div>
              {addProvider && (
                <>
                  <input
                    type="text"
                    list={`fallback-models-${role}-${addProvider.id}`}
                    value={addModel}
                    onChange={(e) => setAddModel(e.target.value)}
                    placeholder={getModels(addProvider).length > 0 ? "Select or type a model..." : "Type a model name..."}
                    className="w-full rounded-lg border border-border/50 bg-transparent px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40"
                  />
                  <datalist id={`fallback-models-${role}-${addProvider.id}`}>
                    {getModels(addProvider).map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </datalist>
                  <input
                    type="text"
                    value={addAlias}
                    onChange={(e) => setAddAlias(e.target.value)}
                    placeholder="Display alias (optional)"
                    className="w-full rounded-lg border border-border/50 bg-transparent px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleAdd}
                      disabled={!addModel}
                      className="rounded-md bg-primary/15 px-2.5 py-1 text-[10px] font-medium text-primary hover:bg-primary/25 disabled:opacity-40 transition-colors"
                    >
                      Add
                    </button>
                    <button
                      onClick={() => { setShowAdd(false); setAddProvider(null); setAddModel(""); setAddAlias(""); }}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add fallback
            </button>
          )}
        </div>
      )}
    </div>
  );
}
