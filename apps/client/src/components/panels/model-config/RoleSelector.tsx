import { useEffect, useState } from "react";
import { toast } from "sonner";
import type * as React from "react";
import { useConfigStore } from "../../../stores/config-store";
import { useFeatureStore } from "../../../stores/feature-store";
import { api } from "../../../lib/api";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import type { CredentialSummary, LLMProviderDef, ModelRole } from "@chvor/shared";
import { FallbackList } from "./FallbackList";
import { InlineCredentialForm } from "./InlineCredentialForm";
import { ModelDropdown } from "./ModelDropdown";
import { useDynamicModels } from "./useDynamicModels";

/* ─── Role Selector (redesigned) ─── */

export function RoleSelector({
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
      } catch {
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
