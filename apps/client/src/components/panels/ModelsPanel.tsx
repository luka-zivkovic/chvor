import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { useModelsStore } from "../../stores/models-store";
import { useCredentialStore } from "../../stores/credential-store";
import { api } from "../../lib/api";
import { cn } from "@/lib/utils";
import type { ModelRole, ModelDef, LLMProviderDef, EmbeddingProviderDef, RoleFallbackEntry } from "@chvor/shared";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { AddCredentialDialog } from "@/components/credentials/AddCredentialDialog";

function formatCtx(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${Math.round(tokens / 1_000)}K`;
}

function formatModelLabel(m: ModelDef): string {
  const parts = [m.name];
  const meta: string[] = [];
  if (m.contextWindow) meta.push(`${formatCtx(m.contextWindow)} ctx`);
  if (m.cost) meta.push(`$${m.cost.input}/$${m.cost.output}/M`);
  if (meta.length) parts.push(`(${meta.join(", ")})`);
  return parts.join(" ");
}

/** Shared cache for dynamic models — survives across component instances. */
const _dynamicModelCache = new Map<string, ModelDef[]>();

/** Fetch dynamic models for a provider, caching results across re-renders. */
function useDynamicModels() {
  const cacheRef = useRef(_dynamicModelCache);
  const [loading, setLoading] = useState<string | null>(null);
  const [, forceUpdate] = useState(0);

  // Invalidate cache when credentials change so stale models don't persist
  const credentials = useCredentialStore((s) => s.credentials);
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
      .catch(() => {
        // Silently fall back to static models
      })
      .finally(() => setLoading(null));
  };

  return { getModels, fetchModels, loading };
}

function FallbackList({ role }: { role: ModelRole }) {
  const { fallbacks, setFallbacks } = useModelsStore();
  const { credentials, llmProviders } = useCredentialStore();
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
    // Prevent duplicate provider+model entries
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
    <div className="mt-2">
      <button
        onClick={() => setShowAdd(!showAdd && entries.length === 0 ? true : !showAdd)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        <span className={cn("text-[8px] transition-transform", (showAdd || entries.length > 0) && "rotate-90")}>
          {"\u25B6"}
        </span>
        Fallbacks{entries.length > 0 && ` (${entries.length})`}
      </button>

      {(showAdd || entries.length > 0) && (
        <div className="mt-1.5 space-y-1">
          {entries.map((entry, idx) => {
            const pDef = getProviderDef(entry.providerId);
            return (
              <div
                key={`${entry.providerId}-${entry.model}-${idx}`}
                className="flex items-center gap-1.5 rounded border border-border/30 bg-muted/5 px-2 py-1"
              >
                {pDef && <ProviderIcon icon={pDef.icon} size={12} />}
                <span className="flex-1 truncate text-[10px] text-foreground">
                  {entry.alias ? (
                    <>{entry.alias} <span className="text-muted-foreground/60">({entry.model})</span></>
                  ) : (
                    entry.model
                  )}
                </span>
                <button
                  onClick={() => move(idx, -1)}
                  disabled={idx === 0}
                  className="px-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-30"
                  title="Move up"
                >
                  {"\u2191"}
                </button>
                <button
                  onClick={() => move(idx, 1)}
                  disabled={idx === entries.length - 1}
                  className="px-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-30"
                  title="Move down"
                >
                  {"\u2193"}
                </button>
                <button
                  onClick={() => remove(idx)}
                  className="px-0.5 text-[10px] text-muted-foreground hover:text-destructive"
                  title="Remove"
                >
                  {"\u00D7"}
                </button>
              </div>
            );
          })}

          {showAdd ? (
            <div className="space-y-1.5 rounded border border-border/30 bg-muted/5 p-2">
              <div className="flex flex-wrap gap-1">
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
                      "flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-all",
                      addProvider?.id === p.id
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                    )}
                  >
                    <ProviderIcon icon={p.icon} size={12} />
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
                    placeholder={getModels(addProvider).length > 0 ? "Select or type a model…" : "Type a model name…"}
                    className="w-full rounded border border-border/50 bg-transparent px-2 py-1 text-[10px] text-foreground placeholder:text-muted-foreground/50"
                  />
                  <datalist id={`fallback-models-${role}-${addProvider.id}`}>
                    {getModels(addProvider).map((m) => (
                      <option key={m.id} value={m.id}>
                        {formatModelLabel(m)}
                      </option>
                    ))}
                  </datalist>
                  <input
                    type="text"
                    value={addAlias}
                    onChange={(e) => setAddAlias(e.target.value)}
                    placeholder="Display alias (optional)"
                    className="w-full rounded border border-border/50 bg-transparent px-2 py-1 text-[10px] text-foreground placeholder:text-muted-foreground/50"
                  />
                  <div className="flex gap-1.5">
                    <button
                      onClick={handleAdd}
                      disabled={!addModel}
                      className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/20 disabled:opacity-40"
                    >
                      Add
                    </button>
                    <button
                      onClick={() => { setShowAdd(false); setAddProvider(null); setAddModel(""); setAddAlias(""); }}
                      className="text-[10px] text-muted-foreground hover:text-foreground"
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
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              + Add fallback
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RoleSelector({
  role,
  label,
  description,
}: {
  role: ModelRole;
  label: string;
  description: string;
}) {
  const { roles, defaults, setRole } = useModelsStore();
  const { credentials, llmProviders, fetchAll } = useCredentialStore();
  const [credDialogType, setCredDialogType] = useState<string | null>(null);

  const config = roles[role];
  const effectiveConfig = config ?? defaults[role] ?? null;
  const isDefault = !config && role !== "primary";

  const hasCredential = (p: LLMProviderDef) =>
    credentials.some((c) => c.type === p.credentialType && c.testStatus !== "failed");

  // Show ALL providers — configured ones first, then unconfigured with "needs key"
  const configuredProviders = llmProviders.filter(hasCredential);
  const unconfiguredProviders = llmProviders.filter((p) => !hasCredential(p));
  const availableProviders = [...configuredProviders, ...unconfiguredProviders];

  const activeProvider =
    configuredProviders.find((p) => p.id === effectiveConfig?.providerId) ??
    configuredProviders[0];

  const { getModels, fetchModels, loading: loadingModels } = useDynamicModels();

  // Fetch dynamic models when active provider changes
  useEffect(() => {
    fetchModels(activeProvider);
  }, [activeProvider?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayModels = getModels(activeProvider);

  const [freeTextModel, setFreeTextModel] = useState(effectiveConfig?.model ?? "");

  // Sync free-text model state when effective config or active provider changes
  useEffect(() => {
    setFreeTextModel(effectiveConfig?.model ?? "");
  }, [activeProvider?.id, effectiveConfig?.model]);

  const handleProviderSwitch = async (provider: LLMProviderDef) => {
    fetchModels(provider);
    const models = getModels(provider);
    const firstModel = models[0]?.id ?? "";
    await setRole(role, provider.id, firstModel);
  };

  const handleModelChange = async (modelId: string) => {
    if (!activeProvider) return;
    await setRole(role, activeProvider.id, modelId);
  };

  const handleClearRole = async () => {
    await setRole(role, null, null);
  };

  return (
    <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <span className="text-xs font-medium text-foreground">{label}</span>
          {isDefault && (
            <span className="ml-2 rounded bg-muted/40 px-1.5 py-0.5 text-[9px] text-muted-foreground">
              default
            </span>
          )}
        </div>
        {isDefault ? null : role !== "primary" ? (
          <button
            onClick={handleClearRole}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            Reset
          </button>
        ) : null}
      </div>
      <p className="mb-2 text-[10px] text-muted-foreground">{description}</p>

      {availableProviders.length > 0 ? (
        <>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {availableProviders.map((p) => {
              const isActive = p.id === activeProvider?.id;
              const configured = hasCredential(p);
              const cred = credentials.find((c) => c.type === p.credentialType);
              const status = cred?.testStatus ?? "untested";
              return (
                <button
                  key={p.id}
                  onClick={() => {
                    if (!configured) {
                      setCredDialogType(p.credentialType);
                      return;
                    }
                    if (!isActive) handleProviderSwitch(p);
                  }}
                  title={configured
                    ? `${p.name} — ${status === "success" ? "Credential verified" : status === "failed" ? "Credential failed" : "Credential untested"}`
                    : `${p.name} — needs API key`}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all",
                    isActive
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : configured
                        ? "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                        : "border-border/30 text-muted-foreground/50 hover:border-border/50 hover:text-muted-foreground"
                  )}
                >
                  <span className={cn(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    configured
                      ? status === "success" ? "bg-green-500" : status === "failed" ? "bg-red-500" : "bg-muted-foreground/50"
                      : "bg-muted-foreground/20"
                  )} />
                  <ProviderIcon icon={p.icon} size={16} />
                  {p.name}
                  {!configured && (
                    <span className="text-[8px] text-muted-foreground/50">needs key</span>
                  )}
                </button>
              );
            })}
          </div>

          {activeProvider && (
            <>
              <div className="relative">
                <input
                  type="text"
                  list={`models-${role}-${activeProvider.id}`}
                  value={freeTextModel}
                  onChange={(e) => setFreeTextModel(e.target.value)}
                  onBlur={() => {
                    if (freeTextModel.trim()) {
                      handleModelChange(freeTextModel.trim());
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && freeTextModel.trim()) {
                      handleModelChange(freeTextModel.trim());
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  placeholder={displayModels.length > 0 ? "Select or type a model name…" : "Type a model name…"}
                  className="w-full rounded border border-border/50 bg-transparent px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50"
                />
                <datalist id={`models-${role}-${activeProvider.id}`}>
                  {displayModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {formatModelLabel(m)}
                    </option>
                  ))}
                </datalist>
                {loadingModels === activeProvider?.id && (
                  <span className="absolute right-7 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground animate-pulse">
                    loading…
                  </span>
                )}
              </div>
              {(() => {
                const selected = displayModels.find((m) => m.id === effectiveConfig?.model);
                return selected?.capabilities?.length ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {selected.capabilities.map((cap) => (
                      <span key={cap} className="rounded bg-muted/40 px-1 py-0.5 text-[9px] text-muted-foreground">
                        {cap}
                      </span>
                    ))}
                  </div>
                ) : null;
              })()}
            </>
          )}

          <FallbackList role={role} />
        </>
      ) : (
        <p className="text-[10px] text-muted-foreground/60">
          No providers available
        </p>
      )}

      {credDialogType && (
        <AddCredentialDialog
          initialCredType={credDialogType}
          filter="llm"
          onClose={() => {
            setCredDialogType(null);
            fetchAll();
          }}
        />
      )}
    </div>
  );
}

interface EmbeddingHealth {
  embedderAvailable: boolean;
  activeProvider: string;
  vecAvailable: boolean;
}

function EmbeddingsSection() {
  const { embedding, setEmbedding, reembedStatus, triggerReembed, pollReembedStatus } = useModelsStore();
  const { credentials, embeddingProviders, fetchAll } = useCredentialStore();

  const [showWarning, setShowWarning] = useState(false);
  const [credDialogType, setCredDialogType] = useState<string | null>(null);
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

  // Fetch embedding health on mount
  useEffect(() => {
    api.models.embeddingHealth().then(setHealth).catch(() => toast.error("Failed to check embedding health"));
  }, [embedding.providerId]);

  // Fetch local model status when local provider is active
  useEffect(() => {
    if (embedding.providerId !== "local") { setModelStatus(null); return; }
    api.models.embeddingModelStatus().then((s) => {
      if (!mountedRef.current) return;
      setModelStatus(s);
      if (s.status === "downloading") startModelPoll();
    }).catch(() => {});
    return () => { if (modelPollRef.current) { clearInterval(modelPollRef.current); modelPollRef.current = null; } };
  }, [embedding.providerId]);

  // Poll re-embed status while running
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
                  setCredDialogType(p.credentialType);
                  return;
                }
                if (!isActive) handleProviderSwitch(p);
              }}
              title={!hasCreds ? `${p.name} — needs API key` : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all",
                !hasCreds
                  ? "border-border/30 text-muted-foreground/50 hover:border-border/50 hover:text-muted-foreground"
                  : isActive
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
              )}
            >
              <ProviderIcon icon={p.icon ?? p.id} size={16} />
              {p.name}
              {!hasCreds && <span className="ml-1 text-[8px] opacity-60">needs key</span>}
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

      {credDialogType && (
        <AddCredentialDialog
          initialCredType={credDialogType}
          filter="llm"
          onClose={() => {
            setCredDialogType(null);
            fetchAll();
          }}
        />
      )}
    </div>
  );
}

export function ModelsPanel() {
  const { fetchConfig, loading } = useModelsStore();
  const { fetchAll } = useCredentialStore();
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    fetchConfig();
    fetchAll();
  }, [fetchConfig, fetchAll]);

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
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          <span className={cn("transition-transform", showAdvanced && "rotate-90")}>
            {"\u25B6"}
          </span>
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
