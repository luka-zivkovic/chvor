import { useState, useCallback } from "react";
import type { ProviderField } from "@chvor/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface CredentialFormData {
  name: string;
  fields: Record<string, string>;
}

interface CredentialFormProps {
  providerName: string;
  credentialType: string;
  fields: ProviderField[];
  suggestedName?: string;
  source: "provider-registry" | "chvor-registry" | "ai-research";
  confidence?: "researched" | "inferred";
  helpText?: string;
  allowFieldEditing: boolean;
  existingCredentialId?: string;
  redactedValues?: Record<string, string>;
  onSubmit: (data: CredentialFormData) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Source badge
// ---------------------------------------------------------------------------

function SourceBadge({
  source,
  confidence,
}: {
  source: CredentialFormProps["source"];
  confidence?: CredentialFormProps["confidence"];
}) {
  if (source === "provider-registry") {
    return (
      <Badge className="border-transparent bg-emerald-500/20 text-emerald-400">
        Built-in
      </Badge>
    );
  }
  if (source === "chvor-registry") {
    return (
      <Badge className="border-transparent bg-blue-500/20 text-blue-400">
        From Registry
      </Badge>
    );
  }
  // ai-research
  if (confidence === "inferred") {
    return (
      <Badge className="border-transparent bg-amber-500/20 text-amber-400">
        AI Inferred
      </Badge>
    );
  }
  return (
    <Badge className="border-transparent bg-sky-500/20 text-sky-400">
      Researched
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// CredentialForm
// ---------------------------------------------------------------------------

export function CredentialForm({
  providerName,
  credentialType,
  fields: initialFields,
  suggestedName,
  source,
  confidence,
  helpText,
  allowFieldEditing,
  existingCredentialId,
  redactedValues,
  onSubmit,
  onCancel,
}: CredentialFormProps) {
  const isUpdate = !!existingCredentialId;

  // ---- state ----
  const [name, setName] = useState(suggestedName || `${providerName} API Key`);
  const [fields, setFields] = useState<ProviderField[]>(initialFields);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of initialFields) {
      init[f.key] = f.defaultValue ?? "";
    }
    return init;
  });
  const [showOptional, setShowOptional] = useState(false);

  // custom field addition state
  const [customKey, setCustomKey] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [customSecret, setCustomSecret] = useState(false);

  // ---- derived ----
  const requiredFields = fields.filter((f) => !f.optional);
  const optionalFields = fields.filter((f) => f.optional);

  const allRequiredFilled = requiredFields.every((f) => {
    if (isUpdate) return true; // empty = keep current
    return values[f.key]?.trim().length > 0;
  });

  // ---- callbacks ----
  const handleFieldChange = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleRemoveField = useCallback((key: string) => {
    setFields((prev) => prev.filter((f) => f.key !== key));
    setValues((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleAddCustomField = useCallback(() => {
    const key = customKey.trim();
    const label = customLabel.trim() || key;
    if (!key) return;
    // prevent duplicates
    if (fields.some((f) => f.key === key)) return;

    const newField: ProviderField = {
      key,
      label,
      type: customSecret ? "password" : "text",
      optional: true,
    };
    setFields((prev) => [...prev, newField]);
    setValues((prev) => ({ ...prev, [key]: "" }));
    setCustomKey("");
    setCustomLabel("");
    setCustomSecret(false);
  }, [customKey, customLabel, customSecret, fields]);

  const handleSubmit = useCallback(() => {
    const fieldData: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.key] ?? "";
      if (isUpdate && v === "") continue; // empty = keep current
      fieldData[f.key] = v;
    }
    onSubmit({ name, fields: fieldData });
  }, [fields, values, name, isUpdate, onSubmit]);

  // ---- render helpers ----
  function renderField(field: ProviderField) {
    const redacted = redactedValues?.[field.key];
    return (
      <div key={field.key} className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm text-white/80">
            {field.label}
            {field.optional && (
              <span className="ml-1 text-[10px] text-white/30">(optional)</span>
            )}
          </Label>
          {allowFieldEditing && (
            <button
              type="button"
              onClick={() => handleRemoveField(field.key)}
              className="text-[10px] text-white/30 hover:text-red-400 transition-colors"
            >
              Remove
            </button>
          )}
        </div>

        <Input
          type={field.type}
          value={values[field.key] ?? ""}
          onChange={(e) => handleFieldChange(field.key, e.target.value)}
          placeholder={
            field.placeholder ??
            (isUpdate ? "Leave blank to keep current" : undefined)
          }
          className="bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-0 focus-visible:border-white/30"
        />

        {field.helpText && (
          <p className="text-[11px] text-white/40">{field.helpText}</p>
        )}
        {field.helpUrl && (
          <a
            href={field.helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-blue-400 hover:underline"
          >
            Where do I find this?
          </a>
        )}
        {redacted && (
          <p className="text-[11px] font-mono text-white/30">
            Current: {redacted}
          </p>
        )}
      </div>
    );
  }

  // ---- render ----
  return (
    <div className="rounded-lg bg-white/5 border border-white/10 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-medium text-white truncate">
            {providerName}
          </h3>
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/30">
            {credentialType}
          </span>
        </div>
        <SourceBadge source={source} confidence={confidence} />
      </div>

      {/* Help text */}
      {helpText && (
        <p className="text-xs text-white/50 leading-relaxed">{helpText}</p>
      )}

      {/* Credential name */}
      <div className="space-y-1.5">
        <Label className="text-sm text-white/80">Credential name</Label>
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-0 focus-visible:border-white/30"
        />
      </div>

      {/* Required fields */}
      {requiredFields.length > 0 && (
        <div className="space-y-3">
          {requiredFields.map(renderField)}
        </div>
      )}

      {/* Optional fields — collapsible */}
      {optionalFields.length > 0 && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setShowOptional((s) => !s)}
            className="text-xs text-white/50 hover:text-white/70 transition-colors"
          >
            {showOptional
              ? "Hide optional fields"
              : `Show ${optionalFields.length} optional field${optionalFields.length === 1 ? "" : "s"}`}
          </button>
          {showOptional && (
            <div className="space-y-3">{optionalFields.map(renderField)}</div>
          )}
        </div>
      )}

      {/* Add custom field */}
      {allowFieldEditing && (
        <div className="space-y-2 pt-2 border-t border-white/10">
          <p className="text-[11px] text-white/40">Add custom field</p>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-[11px] text-white/40">Key</Label>
              <Input
                type="text"
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
                placeholder="e.g. org_id"
                className="h-8 bg-white/5 border-white/10 text-white text-xs placeholder:text-white/30 focus-visible:ring-0 focus-visible:border-white/30"
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label className="text-[11px] text-white/40">Label</Label>
              <Input
                type="text"
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                placeholder="e.g. Org ID"
                className="h-8 bg-white/5 border-white/10 text-white text-xs placeholder:text-white/30 focus-visible:ring-0 focus-visible:border-white/30"
              />
            </div>
            <label className="flex items-center gap-1 text-[11px] text-white/40 cursor-pointer pb-1">
              <input
                type="checkbox"
                checked={customSecret}
                onChange={(e) => setCustomSecret(e.target.checked)}
                className="rounded border-white/20"
              />
              Secret
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={handleAddCustomField}
              disabled={!customKey.trim()}
              className={cn(
                "h-8 border-white/10 text-white/70 hover:bg-white/10",
                !customKey.trim() && "opacity-40"
              )}
            >
              Add
            </Button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          className="border-white/10 text-white/70 hover:bg-white/10"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!allRequiredFilled || !name.trim()}
          className="bg-white/15 text-white hover:bg-white/25 disabled:opacity-40"
        >
          {isUpdate ? "Update" : "Save"}
        </Button>
      </div>
    </div>
  );
}
