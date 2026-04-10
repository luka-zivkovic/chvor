import { useState, useEffect, useRef, useCallback } from "react";
import type { AnyProviderDef, CredentialSummary, ProviderField } from "@chvor/shared";
import { useCredentialStore } from "../../stores/credential-store";
import { api } from "../../lib/api";
import { CredentialForm } from "./CredentialForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { WhatsAppPairingDialog } from "./WhatsAppPairingDialog";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface Props {
  onClose: () => void;
  /** If set, skip provider picker and jump straight to this credential type's form. */
  initialCredType?: string;
  /** Filter which providers appear in the picker. Default: "all". */
  filter?: "llm" | "integration" | "all";
  /** If set, open in edit mode for this credential. */
  editCredential?: CredentialSummary;
}

type Step = "pick-provider" | "fill-fields" | "custom-integration";

export function AddCredentialDialog({ onClose, initialCredType, filter = "all", editCredential }: Props) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const { providers: allProviders, addCredential, updateCredential } = useCredentialStore();
  const providers = allProviders.filter((p) => {
    if (filter === "all") return true;
    const isLLM = "models" in p;
    return filter === "llm" ? isLLM : !isLLM;
  });

  const isEditMode = !!editCredential;

  const [step, setStep] = useState<Step>(isEditMode ? "fill-fields" : "pick-provider");
  const [selectedProvider, setSelectedProvider] =
    useState<AnyProviderDef | null>(null);
  const [name, setName] = useState(isEditMode ? editCredential.name : "");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<Set<string>>(new Set());
  const [customName, setCustomName] = useState("");

  // Auto-discover running local providers when picker is shown
  useEffect(() => {
    if (step !== "pick-provider") return;
    api.providers.discovery()
      .then((res) => setDiscovered(new Set(res.discovered)))
      .catch(() => {}); // silent — discovery is best-effort
  }, [step]);

  // Auto-select provider for edit mode or initialCredType
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    if (allProviders.length === 0) return;

    const credType = isEditMode ? editCredential.type : initialCredType;
    if (!credType) return;

    const match = allProviders.find((p) => p.credentialType === credType);
    if (match) {
      setSelectedProvider(match);
      if (!isEditMode) {
        setName(match.name);
      }
      setStep("fill-fields");
      initializedRef.current = true;
    } else if (isEditMode) {
      // No provider found for this type — still enter fill-fields mode
      setStep("fill-fields");
      initializedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editCredential, initialCredType, allProviders]);

  const selectProvider = (provider: AnyProviderDef) => {
    setSelectedProvider(provider);
    setName(provider.name);
    const defaults: Record<string, string> = {};
    if ("requiredFields" in provider) {
      for (const f of provider.requiredFields) {
        if (f.defaultValue) defaults[f.key] = f.defaultValue;
      }
    }
    setFields(defaults);
    setTestResult(null);
    setError(null);
    setStep("fill-fields");
  };

  const updateField = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const handleTest = async () => {
    if (!editCredential && !selectedProvider) return;
    setTesting(true);
    setTestResult(null);
    try {
      const hasNewFields = Object.values(fields).some((v) => v.trim());
      if (isEditMode && !hasNewFields) {
        // Test saved credential as-is
        const result = await api.credentials.testSaved(editCredential.id);
        setTestResult(result);
        if (result.success) {
          updateCredential(editCredential.id, { testStatus: "success" });
        }
      } else {
        const credType = isEditMode ? editCredential.type : selectedProvider!.credentialType;
        const result = await api.credentials.test({
          type: credType,
          data: fields,
        });
        setTestResult(result);
      }
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (isEditMode) {
        const hasNewFields = Object.values(fields).some((v) => v.trim());
        const body: { name?: string; data?: Record<string, string> } = {};
        if (name.trim() !== editCredential.name) body.name = name.trim();
        if (hasNewFields) {
          // Only send fields that were actually filled in
          const filledFields: Record<string, string> = {};
          for (const [k, v] of Object.entries(fields)) {
            if (v.trim()) filledFields[k] = v;
          }
          body.data = filledFields;
        }
        if (!body.name && !body.data) {
          onClose();
          return;
        }
        const updated = await api.credentials.update(editCredential.id, body);
        updateCredential(editCredential.id, updated);
      } else {
        if (!selectedProvider) return;
        const summary = await api.credentials.create({
          name: name.trim(),
          type: selectedProvider.credentialType,
          data: fields,
        });
        addCredential(summary);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // In edit mode: allow save if name changed or any field filled. In create mode: all non-optional fields required.
  const hasNewFields = Object.values(fields).some((v) => v.trim());
  const canSave = isEditMode
    ? name.trim() && (name.trim() !== editCredential.name || hasNewFields)
    : selectedProvider?.requiredFields
        .filter((f) => !f.optional)
        .every((f) => fields[f.key]?.trim()) && name.trim();

  // Determine which fields to render
  const providerFields = selectedProvider?.requiredFields ?? [];
  // For edit mode without a matching provider, derive fields from the credential's redactedFields
  const editFallbackFields = isEditMode && providerFields.length === 0
    ? Object.keys(editCredential.redactedFields ?? {}).map((key) => ({
        key,
        label: key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()),
        type: "password" as const,
        placeholder: (editCredential.redactedFields ?? {})[key],
      }))
    : [];
  const fieldsToRender = providerFields.length > 0 ? providerFields : editFallbackFields;

  // Can test: in edit mode always (test saved), in create mode when all non-optional fields filled
  const canTest = isEditMode || (selectedProvider?.requiredFields
    .filter((f) => !f.optional)
    .every((f) => fields[f.key]?.trim()) ?? false);

  const handleCustomSubmit = useCallback(
    async (data: { name: string; fields: Record<string, string> }) => {
      setSaving(true);
      setError(null);
      try {
        const credType = slugify(customName) || "custom";
        const summary = await api.credentials.create({
          name: data.name,
          type: credType,
          data: data.fields,
        });
        addCredential(summary);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [customName, addCredential, onClose],
  );

  const defaultCustomFields: ProviderField[] = [
    { key: "apiKey", label: "API Key", type: "password" },
    { key: "baseUrl", label: "Base URL", type: "text", optional: true, placeholder: "https://api.example.com" },
  ];

  // WhatsApp uses QR pairing instead of field form
  if (selectedProvider?.credentialType === "whatsapp" || initialCredType === "whatsapp") {
    return <WhatsAppPairingDialog onClose={onClose} />;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="animate-scale-in w-full max-w-md max-h-[85vh] flex flex-col rounded-xl border border-border bg-card p-6 shadow-2xl">
        {step === "pick-provider" && (
          <>
            <h2 className="mb-1 shrink-0 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Select Provider
            </h2>
            <p className="mb-4 shrink-0 text-[10px] text-muted-foreground/70">
              Choose an AI provider to connect
            </p>
            <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
              <div className="grid grid-cols-2 gap-2">
                {providers.map((p) => (
                  <Card
                    key={p.id}
                    className="cursor-pointer p-3 text-left transition-colors hover:border-primary/30 hover:bg-muted"
                    onClick={() => selectProvider(p)}
                  >
                    <div className="flex items-center gap-2.5">
                      <ProviderIcon icon={p.icon} size={20} className="shrink-0 text-foreground/80" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium">{p.name}</p>
                          {discovered.has(p.id) && (
                            <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[8px] font-medium text-green-400">
                              Detected
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {"models" in p
                            ? `${p.models.length} model${p.models.length !== 1 ? "s" : ""}`
                            : p.description}
                        </p>
                      </div>
                    </div>
                  </Card>
                ))}
                {/* Custom Integration */}
                <Card
                  className="cursor-pointer p-3 text-left transition-colors hover:border-primary/30 hover:bg-muted border-dashed"
                  onClick={() => setStep("custom-integration")}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="shrink-0 text-foreground/50 text-lg">+</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">Custom Integration</p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        Any API or service
                      </p>
                    </div>
                  </div>
                </Card>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="mt-4 shrink-0 text-[10px] text-muted-foreground"
            >
              Cancel
            </Button>
          </>
        )}

        {step === "fill-fields" && (
          <>
            <div className="mb-4 shrink-0 flex items-center gap-2">
              {!isEditMode && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => initialCredType ? onClose() : setStep("pick-provider")}
                  className="h-auto px-1 py-0 text-[10px] text-muted-foreground"
                >
                  &larr;
                </Button>
              )}
              {selectedProvider && (
                <ProviderIcon icon={selectedProvider.icon} size={16} className="text-foreground/70" />
              )}
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                {isEditMode ? "Edit Credential" : selectedProvider?.name ?? "Credential"}
              </h2>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Name
                  </Label>
                  <Input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My API Key"
                  />
                </div>

                {fieldsToRender.map((field) => (
                  <div key={field.key} className="flex flex-col gap-1">
                    <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {field.label}
                      {"optional" in field && field.optional && (
                        <span className="ml-1 normal-case text-muted-foreground/50">(optional)</span>
                      )}
                      {"helpUrl" in field && field.helpUrl && (
                        <a
                          href={field.helpUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-1 text-primary normal-case underline"
                        >
                          Get key
                        </a>
                      )}
                    </Label>
                    <Input
                      type={field.type === "password" ? "password" : "text"}
                      value={fields[field.key] ?? ""}
                      onChange={(e) => updateField(field.key, e.target.value)}
                      placeholder={
                        isEditMode
                          ? editCredential.redactedFields[field.key] ?? field.placeholder
                          : field.placeholder
                      }
                      className="font-mono"
                    />
                    {isEditMode && (
                      <p className="text-[9px] text-muted-foreground/60">
                        Leave empty to keep current value
                      </p>
                    )}
                    {"helpText" in field && field.helpText && !isEditMode && (
                      <p className="text-[9px] leading-relaxed text-muted-foreground">
                        {field.helpText}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {testResult && (
                <div
                  className={`mt-3 rounded-md px-3 py-2 text-[10px] ${
                    testResult.success
                      ? "bg-green-500/10 text-green-400"
                      : "bg-red-500/10 text-red-400"
                  }`}
                >
                  {testResult.success
                    ? "Connection OK"
                    : `Failed: ${testResult.error}`}
                </div>
              )}

              {error && (
                <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-[10px] text-destructive">
                  {error}
                </div>
              )}
            </div>

            <div className="mt-4 shrink-0 flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleTest}
                disabled={!canTest || testing}
                className="text-[10px]"
              >
                {testing ? "Testing..." : "Test Connection"}
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onClose}
                  className="text-[10px]"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!canSave || saving}
                  className="text-[10px]"
                >
                  {saving ? "Saving..." : isEditMode ? "Update" : "Save"}
                </Button>
              </div>
            </div>
          </>
        )}

        {step === "custom-integration" && (
          <>
            <div className="mb-4 shrink-0 flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStep("pick-provider")}
                className="h-auto px-1 py-0 text-[10px] text-muted-foreground"
              >
                &larr;
              </Button>
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Custom Integration
              </h2>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex flex-col gap-1">
                  <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Integration Name
                  </Label>
                  <Input
                    type="text"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="e.g. My Cool API"
                    autoFocus
                  />
                  {customName.trim() && (
                    <p className="text-[9px] text-muted-foreground/60 font-mono">
                      Type: {slugify(customName) || "custom"}
                    </p>
                  )}
                </div>
              </div>

              {customName.trim() && (
                <CredentialForm
                  providerName={customName.trim()}
                  credentialType={slugify(customName) || "custom"}
                  fields={defaultCustomFields}
                  suggestedName={`${customName.trim()} API Key`}
                  source="ai-research"
                  allowFieldEditing
                  onSubmit={handleCustomSubmit}
                  onCancel={onClose}
                />
              )}

              {error && (
                <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-[10px] text-destructive">
                  {error}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
