import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useConfigStore } from "../../../stores/config-store";
import { useFeatureStore } from "../../../stores/feature-store";
import { useUIStore } from "../../../stores/ui-store";
import { api } from "../../../lib/api";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import type { EmbeddingProviderDef } from "@chvor/shared";

/* ─── Embeddings Section ─── */

interface EmbeddingHealth {
  embedderAvailable: boolean;
  activeProvider: string;
  vecAvailable: boolean;
}

export function EmbeddingsSection() {
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
  }, [embedding.providerId]);

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
