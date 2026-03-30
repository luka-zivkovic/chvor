import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { useCredentialStore } from "@/stores/credential-store";
import { api } from "@/lib/api";
import type { LLMProviderDef } from "@chvor/shared";
import { staggerContainer, staggerItem, phaseVariants } from "../onboarding-variants";

interface Props {
  direction: number;
  onBack: () => void;
  onNext: () => void;
}

export function BrainPhase({ direction, onBack, onNext }: Props) {
  const { credentials, providers, llmProviders, embeddingProviders, fetchAll: fetchCredentials } = useCredentialStore();

  const [selectedSetup, setSelectedSetup] = useState<LLMProviderDef | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [setupError, setSetupError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEmbedder, setSelectedEmbedder] = useState("local");

  useEffect(() => { fetchCredentials(); }, [fetchCredentials]);

  const hasLLM = credentials.some((c) =>
    providers.some((p) => p.credentialType === c.type && "models" in p)
  );

  const activeLLMProvider = useMemo(() => {
    for (const c of credentials) {
      const p = providers.find((p) => p.credentialType === c.type && "models" in p);
      if (p) return p as LLMProviderDef;
    }
    return null;
  }, [credentials, providers]);

  useEffect(() => {
    if (activeLLMProvider && !selectedModel) {
      setSelectedModel(activeLLMProvider.models[0]?.id ?? "");
    }
  }, [activeLLMProvider, selectedModel]);

  async function handleConnect() {
    if (!selectedSetup) return;
    setSaving(true);
    setSetupError(null);
    try {
      const testResult = await api.credentials.test({
        type: selectedSetup.credentialType,
        data: fields,
      });
      if (!testResult.success) {
        const hint = selectedSetup.isLocal
          ? " Is Ollama running? Start it with `ollama serve`."
          : "";
        setSetupError((testResult.error ?? "Connection failed") + hint);
        return;
      }
      await api.credentials.create({
        name: selectedSetup.name,
        type: selectedSetup.credentialType,
        data: fields,
      });
      await fetchCredentials();
      setSelectedSetup(null);
      setFields({});
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleNext() {
    try {
      if (activeLLMProvider && selectedModel) {
        await api.llmConfig.set({ providerId: activeLLMProvider.id, model: selectedModel });
      }
      // Save embedder selection
      const embedProvider = embeddingProviders.find((p) => p.id === selectedEmbedder);
      if (embedProvider) {
        const defaultModel = embedProvider.models?.[0]?.id ?? "";
        if (defaultModel) {
          await api.models.setEmbedding({ embedding: { providerId: selectedEmbedder, model: defaultModel } });
        }
      }
      onNext();
    } catch {
      toast.error("Failed to save model configuration");
    }
  }

  // Check if a cloud embedder has the required credential
  const hasEmbedderCred = (providerId: string) => {
    const ep = embeddingProviders.find((p) => p.id === providerId);
    if (!ep || !ep.credentialType) return true; // local doesn't need creds
    return credentials.some((c) => c.type === ep.credentialType);
  };

  return (
    <motion.div
      key="brain"
      variants={phaseVariants}
      custom={direction}
      initial="enter"
      animate="center"
      exit="exit"
    >
      <motion.div variants={staggerContainer} initial="enter" animate="center" className="space-y-5">
        <motion.div variants={staggerItem}>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Give it a brain
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect an LLM provider. This is the only required step.
          </p>
        </motion.div>

        {hasLLM && activeLLMProvider ? (
          <>
            <motion.div variants={staggerItem} className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/8 px-4 py-3">
              <span className="text-green-400">{"\u2713"}</span>
              <ProviderIcon icon={activeLLMProvider.icon} size={18} className="text-foreground" />
              <span className="text-sm text-foreground">{activeLLMProvider.name} connected</span>
            </motion.div>
            <motion.div variants={staggerItem}>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Choose a model
              </label>
              {activeLLMProvider.freeTextModel ? (
                <Input
                  type="text"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  placeholder={activeLLMProvider.id === "ollama" || activeLLMProvider.id === "ollama-cloud"
                    ? "e.g. llama3.2, qwen2.5:14b"
                    : "e.g. meta-llama/llama-3.1-70b"}
                  className="bg-input/50 backdrop-blur-sm font-mono"
                />
              ) : (
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full rounded-md border border-border bg-input/50 backdrop-blur-sm px-3 py-2 text-sm text-foreground"
                >
                  {activeLLMProvider.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({Math.round(m.contextWindow / 1000)}k context)
                    </option>
                  ))}
                </select>
              )}
            </motion.div>

            {/* Embedder selection */}
            {embeddingProviders.length > 0 && (
              <motion.div variants={staggerItem}>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Memory embedder
                </label>
                <p className="mb-2 text-[10px] text-muted-foreground">
                  Used for semantic memory search. Local is free and runs on-device.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {embeddingProviders.map((ep) => {
                    const isActive = ep.id === selectedEmbedder;
                    const needsKey = ep.credentialType && !hasEmbedderCred(ep.id);
                    return (
                      <button
                        key={ep.id}
                        onClick={() => !needsKey && setSelectedEmbedder(ep.id)}
                        disabled={!!needsKey}
                        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                          isActive
                            ? "border-primary/60 bg-primary/10 text-foreground"
                            : needsKey
                              ? "border-border/30 text-muted-foreground/40"
                              : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                        }`}
                      >
                        <ProviderIcon icon={ep.icon ?? ep.id} size={14} />
                        {ep.name}
                        {needsKey && <span className="text-[8px] text-muted-foreground/50">needs key</span>}
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </>
        ) : providers.length === 0 ? (
          <motion.div variants={staggerItem}>
            <p className="py-8 text-center text-xs text-muted-foreground">Loading providers...</p>
          </motion.div>
        ) : !selectedSetup ? (
          <motion.div variants={staggerItem} className="grid grid-cols-2 gap-2">
            {llmProviders.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setSelectedSetup(p);
                  const defaults: Record<string, string> = {};
                  for (const f of p.requiredFields) {
                    if (f.defaultValue) defaults[f.key] = f.defaultValue;
                  }
                  setFields(defaults);
                  setSetupError(null);
                }}
                className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-card/30 backdrop-blur-sm p-3 text-left text-xs transition-colors hover:border-primary/30 hover:bg-muted/30"
              >
                <ProviderIcon icon={p.icon} size={20} className="shrink-0 text-foreground/80" />
                <div>
                  <p className="font-medium text-foreground">{p.name}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {p.models.length > 0
                      ? `${p.models.length} model${p.models.length !== 1 ? "s" : ""}`
                      : p.freeTextModel ? "Any model" : ""}
                  </p>
                </div>
              </button>
            ))}
          </motion.div>
        ) : (
          <motion.div variants={staggerItem} className="space-y-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setSelectedSetup(null); setFields({}); setSetupError(null); }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                &larr;
              </button>
              <ProviderIcon icon={selectedSetup.icon} size={16} className="text-foreground/70" />
              <span className="text-xs font-medium text-foreground">{selectedSetup.name}</span>
            </div>

            {selectedSetup.requiredFields.map((field) => (
              <div key={field.key} className="flex flex-col gap-1">
                <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {field.label}
                  {field.helpUrl && (
                    <a href={field.helpUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-primary normal-case underline">
                      Get key
                    </a>
                  )}
                </label>
                <Input
                  type={field.type === "password" ? "password" : "text"}
                  value={fields[field.key] ?? ""}
                  onChange={(e) => { setFields((prev) => ({ ...prev, [field.key]: e.target.value })); setSetupError(null); }}
                  placeholder={field.placeholder}
                  className="bg-input/50 backdrop-blur-sm font-mono"
                />
              </div>
            ))}

            {setupError && <p className="text-[10px] text-red-400">{setupError}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setSelectedSetup(null); setFields({}); setSetupError(null); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!selectedSetup.requiredFields.every((f) => fields[f.key]?.trim()) || saving}
                onClick={handleConnect}
              >
                {saving ? "Connecting..." : "Connect"}
              </Button>
            </div>
          </motion.div>
        )}

        <motion.div variants={staggerItem} className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
          <Button size="sm" onClick={handleNext} disabled={!hasLLM}>Next</Button>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
