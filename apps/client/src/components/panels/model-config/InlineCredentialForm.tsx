import { useState } from "react";
import { toast } from "sonner";
import { useFeatureStore } from "../../../stores/feature-store";
import { api } from "../../../lib/api";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import type { CredentialSummary, LLMProviderDef } from "@chvor/shared";

/* ─── Inline Credential Form ─── */

export function InlineCredentialForm({
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
