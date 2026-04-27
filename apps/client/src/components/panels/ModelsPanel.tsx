import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { useConfigStore } from "../../stores/config-store";
import { useFeatureStore } from "../../stores/feature-store";
import { useUIStore } from "../../stores/ui-store";
import { api } from "../../lib/api";
import { cn } from "@/lib/utils";
import type { ModelRole, ModelDef, LLMProviderDef, EmbeddingProviderDef, RoleFallbackEntry, CredentialSummary } from "@chvor/shared";
import { ProviderIcon } from "@/components/ui/ProviderIcon";

/* ─── Helpers ─── */

function formatCtx(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${Math.round(tokens / 1_000)}K`;
}

function formatCost(cost: { input: number; output: number }): string {
  return `$${cost.input}/${cost.output}`;
}

const CAPABILITY_COLORS: Record<string, string> = {
  vision: "bg-purple-500/15 text-purple-400",
  reasoning: "bg-blue-500/15 text-blue-400",
  toolUse: "bg-emerald-500/15 text-emerald-400",
  code: "bg-amber-500/15 text-amber-400",
};

/* ─── Dynamic model cache hook ─── */

const _dynamicModelCache = new Map<string, ModelDef[]>();

function useDynamicModels() {
  const cacheRef = useRef(_dynamicModelCache);
  const [loading, setLoading] = useState<string | null>(null);
  const [, forceUpdate] = useState(0);

  const credentials = useFeatureStore((s) => s.credentials);
  const credVersionRef = useRef(credentials);
  if (credVersionRef.current !== credentials) {
    credVersionRef.current = credentials;
    cacheRef.current.clear();
  }

  const getModels = (provider: LLMProviderDef | null | undefined): ModelDef[] => {
    if (!provider) return [];
    return cacheRef.current.get(provider.id) ?? provider.models;
  };

  const fetchModels = (provider: LLMProviderDef | null | undefined) => {
    if (!provider) return;
    if (cacheRef.current.has(provider.id)) return;

    setLoading(provider.id);
    api.providers.models(provider.id)
      .then((result) => {
        if (result.models.length > 0) {
          cacheRef.current.set(provider.id, result.models);
          forceUpdate((n) => n + 1);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(null));
  };

  return { getModels, fetchModels, loading };
}

/* ─── Inline Credential Form ─── */

function InlineCredentialForm({
  provider,
  editCredential,
  onDone,
  onCancel,
}: {
  provider: LLMProviderDef;
  /** If set, opens in edit mode for this credential */
  editCredential?: CredentialSummary;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { addCredential, updateCredential } = useFeatureStore();
  const isEdit = !!editCredential;

  const [fields, setFields] = useState<Record<string, string>>(() => {
    if (isEdit) return {}; // In edit mode, start empty — placeholders show current values
    const defaults: Record<string, string> = {};
    for (const f of provider.requiredFields) {
      if (f.defaultValue) defaults[f.key] = f.defaultValue;
    }
    return defaults;
  });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  const hasNewFields = Object.values(fields).some((v) => v.trim());
  const allRequiredFilled = isEdit
    ? true // In edit mode, can save even without new values (re-test)
    : provider.requiredFields.filter((f) => !f.optional).every((f) => fields[f.key]?.trim());

  const canTest = isEdit || allRequiredFilled;

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (isEdit && !hasNewFields) {
        // Test saved credential as-is
        const result = await api.credentials.testSaved(editCredential.id);
        setTestResult(result);
        if (result.success) updateCredential(editCredential.id, { testStatus: "success" });
      } else {
        const result = await api.credentials.test({ type: provider.credentialType, data: fields });
        setTestResult(result);
      }
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isEdit) {
        if (!hasNewFields) { onDone(); return; }
        const filledFields: Record<string, string> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v.trim()) filledFields[k] = v;
        }
        const updated = await api.credentials.update(editCredential.id, { data: filledFields });
        updateCredential(editCredential.id, updated);
        toast.success(`${provider.name} updated`);
      } else {
        if (!allRequiredFilled) return;
        const summary = await api.credentials.create({
          name: provider.name,
          type: provider.credentialType,
          data: fields,
        });
        addCredential(summary);
        toast.success(`${provider.name} connected`);
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save credential");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon icon={provider.icon} size={16} />
        <span className="text-xs font-medium text-foreground">
          {isEdit ? `Edit ${provider.name}` : `Connect ${provider.name}`}
        </span>
      </div>

      {provider.requiredFields.map((field) => (
        <div key={field.key} className="space-y-1">
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {field.label}
            </label>
            {field.optional && (
              <span className="text-[8px] text-muted-foreground/50">(optional)</span>
            )}
            {field.helpUrl && (
              <a
                href={field.helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[9px] text-primary hover:underline"
              >
                Get key
              </a>
            )}
          </div>
          <input
            type={field.type === "password" ? "password" : "text"}
            value={fields[field.key] ?? ""}
            onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
            placeholder={
              isEdit
                ? editCredential.redactedFields?.[field.key] ?? field.placeholder
                : field.placeholder
            }
            className="w-full rounded border border-border/50 bg-background/50 px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/40"
          />
          {isEdit && (
            <p className="text-[8px] text-muted-foreground/50">Leave empty to keep current value</p>
          )}
          {!isEdit && field.helpText && (
            <p className="text-[9px] leading-relaxed text-muted-foreground/70">{field.helpText}</p>
          )}
        </div>
      ))}

      {testResult && (
        <div className={cn(
          "rounded-md px-2.5 py-1.5 text-[10px]",
          testResult.success ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
        )}>
          {testResult.success ? "Connection verified" : `Failed: ${testResult.error}`}
        </div>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <button
          onClick={handleTest}
          disabled={!canTest || testing}
          className="rounded-md border border-border/50 px-2.5 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-40 transition-colors"
        >
          {testing ? "Testing..." : "Test"}
        </button>
        <button
          onClick={handleSave}
          disabled={(!isEdit && !allRequiredFilled) || saving}
          className="rounded-md bg-primary/15 px-2.5 py-1 text-[10px] font-medium text-primary hover:bg-primary/25 disabled:opacity-40 transition-colors"
        >
          {saving ? "Saving..." : isEdit ? "Update" : "Save & Connect"}
        </button>
        <button
          onClick={onCancel}
          className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ─── Model Dropdown ─── */

function ModelDropdown({
  models,
  selectedModelId,
  onSelect,
  loading,
  allowFreeText,
}: {
  models: ModelDef[];
  selectedModelId: string;
  onSelect: (modelId: string) => void;
  loading: boolean;
  allowFreeText?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [freeText, setFreeText] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);

  const selectedModel = models.find((m) => m.id === selectedModelId);

  const filtered = search
    ? models.filter((m) =>
        m.name.toLowerCase().includes(search.toLowerCase()) ||
        m.id.toLowerCase().includes(search.toLowerCase())
      )
    : models;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus search on open
  useEffect(() => {
    if (open) {
      searchRef.current?.focus();
      setHighlightIdx(0);
    }
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlightIdx]) {
        onSelect(filtered[highlightIdx].id);
        setOpen(false);
        setSearch("");
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setSearch("");
    }
  };

  return (
    <div ref={dropdownRef} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
          open ? "border-primary/50 bg-primary/5" : "border-border/50 bg-muted/5 hover:border-border/80"
        )}
      >
        <div className="flex-1 min-w-0">
          {selectedModel ? (
            <div>
              <p className="text-xs font-medium text-foreground truncate">{selectedModel.name}</p>
              <div className="flex items-center gap-2 mt-0.5">
                {selectedModel.contextWindow > 0 && (
                  <span className="text-[9px] text-muted-foreground">
                    {formatCtx(selectedModel.contextWindow)} ctx
                  </span>
                )}
                {selectedModel.cost && (
                  <span className="text-[9px] text-muted-foreground">
                    {formatCost(selectedModel.cost)}/M
                  </span>
                )}
              </div>
            </div>
          ) : selectedModelId ? (
            <p className="text-xs text-foreground truncate">{selectedModelId}</p>
          ) : (
            <p className="text-xs text-muted-foreground/50">Select a model...</p>
          )}
        </div>
        {loading ? (
          <span className="text-[9px] text-muted-foreground animate-pulse shrink-0">loading...</span>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-border/50 bg-card shadow-lg overflow-hidden">
          {/* Search */}
          {(models.length > 4 || allowFreeText) && (
            <div className="border-b border-border/30 p-1.5">
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setHighlightIdx(0); }}
                onKeyDown={handleKeyDown}
                placeholder={allowFreeText ? "Search or type model ID..." : "Search models..."}
                className="w-full rounded bg-transparent px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/40 outline-none"
              />
            </div>
          )}

          {/* Model list */}
          <div className="max-h-[240px] overflow-y-auto py-1">
            {filtered.length === 0 && !allowFreeText && (
              <p className="px-3 py-2 text-[10px] text-muted-foreground/60">No models found</p>
            )}
            {filtered.map((m, idx) => {
              const isSelected = m.id === selectedModelId;
              const isHighlighted = idx === highlightIdx;
              return (
                <button
                  key={m.id}
                  onClick={() => { onSelect(m.id); setOpen(false); setSearch(""); }}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  className={cn(
                    "flex w-full flex-col items-start px-3 py-2 text-left transition-colors",
                    isHighlighted ? "bg-primary/10" : "hover:bg-muted/20",
                    isSelected && "border-l-2 border-primary"
                  )}
                >
                  <div className="flex w-full items-center gap-2">
                    <span className={cn("text-xs font-medium", isSelected ? "text-primary" : "text-foreground")}>
                      {m.name}
                    </span>
                    {isSelected && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-primary ml-auto shrink-0">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    {m.contextWindow > 0 && (
                      <span className="rounded bg-muted/30 px-1 py-0.5 text-[9px] text-muted-foreground">
                        {formatCtx(m.contextWindow)}
                      </span>
                    )}
                    {m.cost && (
                      <span className="rounded bg-muted/30 px-1 py-0.5 text-[9px] text-muted-foreground">
                        {formatCost(m.cost)}/M
                      </span>
                    )}
                    {m.capabilities?.map((cap) => (
                      <span key={cap} className={cn("rounded px-1 py-0.5 text-[9px]", CAPABILITY_COLORS[cap] ?? "bg-muted/30 text-muted-foreground")}>
                        {cap}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}

            {/* Free text option when search doesn't match */}
            {allowFreeText && search.trim() && !filtered.some((m) => m.id === search.trim()) && (
              <button
                onClick={() => { onSelect(search.trim()); setOpen(false); setSearch(""); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 border-t border-border/20"
              >
                <span className="text-xs text-muted-foreground">Use custom:</span>
                <span className="text-xs font-medium text-foreground font-mono">{search.trim()}</span>
              </button>
            )}
          </div>

          {/* Free text input for providers that support it */}
          {allowFreeText && !search && (
            <div className="border-t border-border/30 p-2">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={freeText}
                  onChange={(e) => setFreeText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && freeText.trim()) {
                      onSelect(freeText.trim());
                      setFreeText("");
                      setOpen(false);
                    }
                  }}
                  placeholder="Custom model ID..."
                  className="flex-1 rounded border border-border/50 bg-transparent px-2 py-1 font-mono text-[10px] text-foreground placeholder:text-muted-foreground/40 outline-none"
                />
                <button
                  onClick={() => { if (freeText.trim()) { onSelect(freeText.trim()); setFreeText(""); setOpen(false); } }}
                  disabled={!freeText.trim()}
                  className="rounded bg-primary/15 px-2 py-1 text-[10px] font-medium text-primary hover:bg-primary/25 disabled:opacity-40"
                >
                  Use
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Fallback List ─── */

function FallbackList({ role }: { role: ModelRole }) {
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

/* ─── Role Selector (redesigned) ─── */

function RoleSelector({
  role,
  label,
  description,
}: {
  role: ModelRole;
  label: string;
  description: string;
}) {
  const { roles, defaults, setRole } = useConfigStore();
  const { credentials, llmProviders, fetchCredentials: fetchAll } = useFeatureStore();

  const config = roles[role];
  const effectiveConfig = config ?? defaults[role] ?? null;
  const isDefault = !config && role !== "primary";

  // Inline credential form state
  const [credFormProvider, setCredFormProvider] = useState<LLMProviderDef | null>(null);
  const [credFormEdit, setCredFormEdit] = useState<CredentialSummary | undefined>(undefined);

  const hasCredential = (p: LLMProviderDef) =>
    credentials.some((c) => c.type === p.credentialType && c.testStatus !== "failed");

  const configuredProviders = llmProviders.filter(hasCredential);
  const unconfiguredProviders = llmProviders.filter((p) => !hasCredential(p));

  const activeProvider =
    configuredProviders.find((p) => p.id === effectiveConfig?.providerId) ??
    configuredProviders[0];

  const { getModels, fetchModels, loading: loadingModels } = useDynamicModels();

  useEffect(() => {
    fetchModels(activeProvider);
  }, [activeProvider?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayModels = getModels(activeProvider);

  const handleProviderSwitch = async (provider: LLMProviderDef) => {
    fetchModels(provider);
    const models = getModels(provider);
    const firstModel = models[0]?.id ?? "";
    if (firstModel) {
      await setRole(role, provider.id, firstModel);
    } else {
      // For providers with empty static models (Ollama, OpenRouter, etc.),
      // fetch dynamic models first, then set role with the first discovered model.
      try {
        const result = await api.providers.models(provider.id);
        if (result.models.length > 0) {
          await setRole(role, provider.id, result.models[0].id);
        } else {
          // No models discovered — set provider anyway, user must type model name
          await setRole(role, provider.id, "");
        }
      } catch (err) {
        toast.error(`Failed to fetch models for ${provider.name}`);
        await setRole(role, provider.id, "");
      }
    }
  };

  const handleModelChange = async (modelId: string) => {
    if (!activeProvider) return;
    await setRole(role, activeProvider.id, modelId);
  };

  const handleClearRole = async () => {
    await setRole(role, null, null);
  };

  const handleCredentialDone = () => {
    setCredFormProvider(null);
    setCredFormEdit(undefined);
    fetchAll(); // Refresh credentials
  };

  const handleEditProvider = (p: LLMProviderDef, e: React.MouseEvent) => {
    e.stopPropagation();
    const cred = credentials.find((c) => c.type === p.credentialType);
    setCredFormProvider(p);
    setCredFormEdit(cred);
  };

  return (
    <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
      {/* Header */}
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">{label}</span>
          {isDefault && (
            <span className="rounded-full bg-muted/40 px-1.5 py-0.5 text-[8px] font-medium text-muted-foreground">
              using default
            </span>
          )}
        </div>
        {!isDefault && role !== "primary" && (
          <button
            onClick={handleClearRole}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Reset
          </button>
        )}
      </div>
      <p className="mb-3 text-[10px] text-muted-foreground/80">{description}</p>

      {/* Configured Providers */}
      {configuredProviders.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-1.5">
          {configuredProviders.map((p) => {
            const isActive = p.id === activeProvider?.id;
            const cred = credentials.find((c) => c.type === p.credentialType);
            const status = cred?.testStatus ?? "untested";
            return (
              <div
                key={p.id}
                onClick={() => !isActive && handleProviderSwitch(p)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border p-2 text-left transition-all cursor-pointer",
                  isActive
                    ? "border-primary/50 bg-primary/8"
                    : "border-border/40 hover:border-border/70 hover:bg-muted/10"
                )}
              >
                <ProviderIcon icon={p.icon} size={18} className={isActive ? "text-primary" : ""} />
                <div className="min-w-0 flex-1">
                  <p className={cn("text-[11px] font-medium truncate", isActive ? "text-primary" : "text-foreground")}>
                    {p.name}
                  </p>
                </div>
                <button
                  onClick={(e) => handleEditProvider(p, e)}
                  className="rounded p-0.5 text-muted-foreground/40 hover:text-foreground hover:bg-muted/20 transition-colors shrink-0"
                  title={`Edit ${p.name} configuration`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <span className={cn(
                  "inline-block h-2 w-2 rounded-full shrink-0",
                  status === "success" ? "bg-green-500" : status === "failed" ? "bg-red-500" : "bg-muted-foreground/40"
                )} />
              </div>
            );
          })}
        </div>
      )}

      {/* Model Selector */}
      {activeProvider && (
        <ModelDropdown
          models={displayModels}
          selectedModelId={effectiveConfig?.model ?? ""}
          onSelect={handleModelChange}
          loading={loadingModels === activeProvider.id}
          allowFreeText={activeProvider.freeTextModel}
        />
      )}

      {/* No configured providers message */}
      {configuredProviders.length === 0 && !credFormProvider && (
        <div className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-2.5 mb-3">
          <p className="text-[11px] font-medium text-status-warning">No providers connected</p>
          <p className="mt-0.5 text-[9px] text-muted-foreground">
            Add an API key below to get started
          </p>
        </div>
      )}

      {/* Inline credential form */}
      {credFormProvider && (
        <div className="mt-3">
          <InlineCredentialForm
            provider={credFormProvider}
            editCredential={credFormEdit}
            onDone={handleCredentialDone}
            onCancel={() => { setCredFormProvider(null); setCredFormEdit(undefined); }}
          />
        </div>
      )}

      {/* Unconfigured providers (add key) */}
      {unconfiguredProviders.length > 0 && !credFormProvider && (
        <div className="mt-3">
          <p className="mb-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Add provider
          </p>
          <div className="flex flex-wrap gap-1">
            {unconfiguredProviders.map((p) => (
              <button
                key={p.id}
                onClick={() => setCredFormProvider(p)}
                className="flex items-center gap-1.5 rounded-md border border-dashed border-border/40 px-2 py-1 text-[10px] text-muted-foreground/60 hover:border-primary/40 hover:text-primary/80 transition-all"
              >
                <ProviderIcon icon={p.icon} size={14} className="opacity-50" />
                {p.name}
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="opacity-50">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Fallback chain */}
      <FallbackList role={role} />
    </div>
  );
}

/* ─── Embeddings Section ─── */

interface EmbeddingHealth {
  embedderAvailable: boolean;
  activeProvider: string;
  vecAvailable: boolean;
}

function EmbeddingsSection() {
  const { embedding, setEmbedding, reembedStatus, triggerReembed, pollReembedStatus } = useConfigStore();
  const { credentials, embeddingProviders } = useFeatureStore();

  const [showWarning, setShowWarning] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<{ providerId: string; model: string } | null>(null);
  const [health, setHealth] = useState<EmbeddingHealth | null>(null);
  const [modelStatus, setModelStatus] = useState<{ status: string; percent: number; error?: string } | null>(null);
  const modelPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const startModelPoll = () => {
    if (modelPollRef.current) return;
    modelPollRef.current = setInterval(async () => {
      if (!mountedRef.current) { clearInterval(modelPollRef.current!); modelPollRef.current = null; return; }
      try {
        const res = await api.models.embeddingModelStatus();
        if (!mountedRef.current) return;
        setModelStatus(res);
        if (res.status === "ready" || res.status === "error") {
          clearInterval(modelPollRef.current!);
          modelPollRef.current = null;
          api.models.embeddingHealth().then(setHealth).catch(() => {});
        }
      } catch { /* ignore */ }
    }, 2000);
  };

  useEffect(() => {
    api.models.embeddingHealth().then(setHealth).catch(() => toast.error("Failed to check embedding health"));
  }, [embedding.providerId]);

  useEffect(() => {
    if (embedding.providerId !== "local") { setModelStatus(null); return; }
    api.models.embeddingModelStatus().then((s) => {
      if (!mountedRef.current) return;
      setModelStatus(s);
      if (s.status === "downloading") startModelPoll();
    }).catch(() => {});
    return () => { if (modelPollRef.current) { clearInterval(modelPollRef.current); modelPollRef.current = null; } };
  }, [embedding.providerId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (reembedStatus.status !== "running") return;
    const interval = setInterval(pollReembedStatus, 2000);
    return () => clearInterval(interval);
  }, [reembedStatus.status, pollReembedStatus]);

  const providerHasCreds = (p: EmbeddingProviderDef) =>
    p.isLocal || credentials.some(
      (c) => c.type === p.credentialType && c.testStatus !== "failed"
    );

  const activeProvider =
    embeddingProviders.find((p) => p.id === embedding.providerId && providerHasCreds(p)) ??
    embeddingProviders.find((p) => p.isLocal);

  const handleProviderSwitch = (provider: EmbeddingProviderDef) => {
    if (!providerHasCreds(provider)) return;
    const firstModel = provider.models[0];
    if (!firstModel) return;

    if (provider.id !== embedding.providerId) {
      setShowWarning(true);
      setPendingProvider({ providerId: provider.id, model: firstModel.id });
    } else {
      setEmbedding(provider.id, firstModel.id);
    }
  };

  const handleConfirmSwitch = async () => {
    if (!pendingProvider) return;
    await setEmbedding(pendingProvider.providerId, pendingProvider.model);
    setShowWarning(false);
    setPendingProvider(null);
  };

  return (
    <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
      <h4 className="mb-2 text-xs font-medium text-foreground">Embeddings</h4>
      <p className="mb-2 text-[10px] text-muted-foreground">
        Used for semantic memory search. Local model is free but requires download.
      </p>

      <div className="mb-2 flex flex-wrap gap-1.5">
        {embeddingProviders.map((p) => {
          const hasCreds = providerHasCreds(p);
          const isActive = p.id === activeProvider?.id;
          return (
            <button
              key={p.id}
              onClick={() => {
                if (!hasCreds) {
                  useUIStore.getState().openSettings("connections");
                  return;
                }
                if (!isActive) handleProviderSwitch(p);
              }}
              title={!hasCreds ? `Add ${p.credentialType} API key in Settings > Connections` : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all",
                !hasCreds
                  ? "border-border/30 text-muted-foreground/50 hover:border-primary/30 hover:text-muted-foreground"
                  : isActive
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
              )}
            >
              <ProviderIcon icon={p.icon ?? p.id} size={16} />
              {p.name}
              {!hasCreds && <span className="ml-1 text-[8px] text-primary/60">+ add key</span>}
            </button>
          );
        })}
      </div>

      {activeProvider && activeProvider.models.length > 1 && (
        <select
          value={embedding.model}
          onChange={(e) => setEmbedding(embedding.providerId, e.target.value)}
          className="mb-2 w-full rounded border border-border/50 bg-transparent px-2 py-1.5 text-xs text-foreground"
        >
          {activeProvider.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.dimensions}d)
            </option>
          ))}
        </select>
      )}

      {health ? (
        <div className="flex items-center gap-1.5 text-[10px]">
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              health.embedderAvailable && health.vecAvailable
                ? "bg-green-500"
                : health.embedderAvailable || health.vecAvailable
                  ? "bg-yellow-500"
                  : "bg-red-500"
            )}
          />
          <span className="text-muted-foreground">
            {health.embedderAvailable && health.vecAvailable
              ? "Semantic search active"
              : health.embedderAvailable
                ? "Vector store unavailable \u2014 using recency"
                : health.vecAvailable
                  ? "Embedder unavailable"
                  : "Memory search degraded"}
          </span>
          <span className="ml-auto text-muted-foreground/60">{embedding.dimensions}d</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>Dimensions: {embedding.dimensions}</span>
        </div>
      )}

      {/* Local model download */}
      {embedding.providerId === "local" && modelStatus && modelStatus.status !== "ready" && (
        <div className="mt-2">
          {modelStatus.status === "downloading" ? (
            <div>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                <span>Downloading model...</span>
                <span>{modelStatus.percent}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted/50">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${modelStatus.percent}%` }}
                />
              </div>
            </div>
          ) : modelStatus.status === "error" ? (
            <div>
              <p className="text-[10px] text-destructive mb-1">{modelStatus.error ?? "Download failed"}</p>
              <button
                onClick={async () => {
                  setModelStatus({ status: "downloading", percent: 0 });
                  try {
                    await api.models.embeddingModelDownload();
                    if (mountedRef.current) startModelPoll();
                  } catch (err) {
                    if (mountedRef.current) {
                      setModelStatus({ status: "error", percent: 0, error: err instanceof Error ? err.message : "Download request failed" });
                    }
                  }
                }}
                className="rounded-md bg-primary/10 px-3 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                Retry Download
              </button>
            </div>
          ) : (
            <button
              onClick={async () => {
                setModelStatus({ status: "downloading", percent: 0 });
                try {
                  await api.models.embeddingModelDownload();
                  if (mountedRef.current) startModelPoll();
                } catch (err) {
                  if (mountedRef.current) {
                    setModelStatus({ status: "error", percent: 0, error: err instanceof Error ? err.message : "Download request failed" });
                  }
                }
              }}
              className="w-full rounded-md bg-primary/10 px-3 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/20 transition-colors"
            >
              Download Model (~23MB)
            </button>
          )}
        </div>
      )}

      {/* Warning banner */}
      {showWarning && pendingProvider && (
        <div className="mt-2 rounded-md border border-status-warning/40 bg-status-warning/6 p-2">
          <p className="text-[10px] text-status-warning">
            Switching embedding providers requires re-embedding all memories. Old vectors will be purged.
          </p>
          <div className="mt-1.5 flex gap-2">
            <button
              onClick={handleConfirmSwitch}
              className="rounded bg-status-warning/20 px-2 py-0.5 text-[10px] font-medium text-status-warning hover:bg-status-warning/30"
            >
              Switch
            </button>
            <button
              onClick={() => { setShowWarning(false); setPendingProvider(null); }}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Re-embed button + progress */}
      <div className="mt-2">
        <button
          onClick={triggerReembed}
          disabled={reembedStatus.status === "running"}
          className={cn(
            "rounded-md border px-2 py-1 text-[10px] font-medium transition-all",
            reembedStatus.status === "running"
              ? "border-border/30 text-muted-foreground/50 cursor-not-allowed"
              : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
          )}
        >
          {reembedStatus.status === "running" ? "Re-embedding..." : "Re-embed All Memories"}
        </button>

        {reembedStatus.status === "running" && reembedStatus.total > 0 && (
          <div className="mt-1.5">
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted/30">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${(reembedStatus.done / reembedStatus.total) * 100}%` }}
              />
            </div>
            <p className="mt-0.5 text-[9px] text-muted-foreground">
              {reembedStatus.done}/{reembedStatus.total}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Main Panel ─── */

export function ModelsPanel() {
  const { fetchModelsConfig, modelsLoading: loading } = useConfigStore();
  const { fetchCredentials: fetchAll } = useFeatureStore();
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    fetchModelsConfig();
    fetchAll();
  }, [fetchModelsConfig, fetchAll]);

  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Chat Models */}
      <div>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Chat Models
        </h3>
        <div className="flex flex-col gap-3">
          <RoleSelector
            role="primary"
            label="Primary"
            description="Main model for chat and reasoning"
          />
          <RoleSelector
            role="reasoning"
            label="Reasoning"
            description="Complex tasks — can use reasoning models like DeepSeek-R1 or o3"
          />
        </div>
      </div>

      {/* Advanced */}
      <div>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={cn("transition-transform", showAdvanced && "rotate-90")}>
            <polyline points="9 6 15 12 9 18" />
          </svg>
          Advanced
        </button>
        {showAdvanced && (
          <div className="mt-2 flex flex-col gap-3">
            <RoleSelector
              role="lightweight"
              label="Lightweight"
              description="Memory extraction, summarization, pipeline steps"
            />
            <RoleSelector
              role="heartbeat"
              label="Heartbeat"
              description="Pulse/awareness checks — runs periodically"
            />
          </div>
        )}
      </div>

      {/* Embeddings */}
      <div>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Embeddings
        </h3>
        <EmbeddingsSection />
      </div>
    </div>
  );
}
