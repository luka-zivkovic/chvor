# Credential Management Overhaul — Task 7: Build Shared CredentialForm Component

## Task 7: Build Shared CredentialForm Component

**Files:**
- Create: `apps/client/src/components/credentials/CredentialForm.tsx`

- [ ] **Step 1: Create the shared CredentialForm component**

Create `apps/client/src/components/credentials/CredentialForm.tsx`:

```tsx
import { useState, useCallback } from "react";
import type { ProviderField } from "@chvor/shared";

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
  const [name, setName] = useState(suggestedName || `${providerName} API Key`);
  const [fields, setFields] = useState<ProviderField[]>(initialFields);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of initialFields) {
      init[f.key] = "";
    }
    return init;
  });
  const [showOptional, setShowOptional] = useState(false);
  const [newFieldKey, setNewFieldKey] = useState("");
  const [newFieldLabel, setNewFieldLabel] = useState("");
  const [newFieldSecret, setNewFieldSecret] = useState(true);

  const requiredFields = fields.filter((f) => !f.optional);
  const optionalFields = fields.filter((f) => f.optional);

  const isValid = requiredFields.every((f) => values[f.key]?.trim());

  const handleSubmit = useCallback(() => {
    if (!isValid && !existingCredentialId) return;
    // For updates, filter out empty values (keep current)
    const data = existingCredentialId
      ? Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()))
      : values;
    onSubmit({ name, fields: data });
  }, [name, values, isValid, existingCredentialId, onSubmit]);

  const addCustomField = useCallback(() => {
    if (!newFieldKey.trim() || !newFieldLabel.trim()) return;
    const key = newFieldKey.trim().replace(/[^a-zA-Z0-9_]/g, "");
    setFields((prev) => [...prev, {
      key,
      label: newFieldLabel.trim(),
      type: newFieldSecret ? "password" : "text",
      optional: true,
    }]);
    setValues((prev) => ({ ...prev, [key]: "" }));
    setNewFieldKey("");
    setNewFieldLabel("");
    setNewFieldSecret(true);
  }, [newFieldKey, newFieldLabel, newFieldSecret]);

  const removeField = useCallback((key: string) => {
    setFields((prev) => prev.filter((f) => f.key !== key));
    setValues((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const sourceBadge = {
    "provider-registry": { label: "Built-in", color: "bg-emerald-500/20 text-emerald-400" },
    "chvor-registry": { label: "From Registry", color: "bg-blue-500/20 text-blue-400" },
    "ai-research": confidence === "inferred"
      ? { label: "AI Inferred", color: "bg-amber-500/20 text-amber-400" }
      : { label: "Researched", color: "bg-sky-500/20 text-sky-400" },
  }[source];

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg font-medium text-white">{providerName}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full ${sourceBadge.color}`}>
            {sourceBadge.label}
          </span>
        </div>
        <button onClick={onCancel} className="text-white/40 hover:text-white/70 text-sm">
          Cancel
        </button>
      </div>

      {/* Help text */}
      {helpText && (
        <p className="text-sm text-white/50">{helpText}</p>
      )}

      {/* Credential name */}
      <div>
        <label className="block text-xs text-white/50 mb-1">Credential Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none"
          placeholder="My API Key"
        />
      </div>

      {/* Required fields */}
      {requiredFields.map((field) => (
        <div key={field.key}>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-white/50">{field.label}</label>
            {allowFieldEditing && (
              <button
                onClick={() => removeField(field.key)}
                className="text-xs text-red-400/60 hover:text-red-400"
              >
                Remove
              </button>
            )}
          </div>
          {field.helpText && <p className="text-xs text-white/30 mb-1">{field.helpText}</p>}
          {redactedValues?.[field.key] && (
            <p className="text-xs text-white/30 mb-1">Current: {redactedValues[field.key]}</p>
          )}
          <input
            type={field.type === "password" ? "password" : "text"}
            value={values[field.key] || ""}
            onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none"
            placeholder={field.placeholder || (existingCredentialId ? "Leave empty to keep current" : "")}
          />
          {field.helpUrl && (
            <a href={field.helpUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline mt-1 inline-block">
              How to get this →
            </a>
          )}
        </div>
      ))}

      {/* Optional fields */}
      {optionalFields.length > 0 && (
        <div>
          <button
            onClick={() => setShowOptional(!showOptional)}
            className="text-xs text-white/40 hover:text-white/60"
          >
            {showOptional ? "Hide" : "Show"} {optionalFields.length} optional field{optionalFields.length > 1 ? "s" : ""}
          </button>
          {showOptional && optionalFields.map((field) => (
            <div key={field.key} className="mt-2">
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-white/50">{field.label} (optional)</label>
                {allowFieldEditing && (
                  <button onClick={() => removeField(field.key)} className="text-xs text-red-400/60 hover:text-red-400">
                    Remove
                  </button>
                )}
              </div>
              {field.helpText && <p className="text-xs text-white/30 mb-1">{field.helpText}</p>}
              <input
                type={field.type === "password" ? "password" : "text"}
                value={values[field.key] || ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none"
                placeholder={field.placeholder || ""}
              />
            </div>
          ))}
        </div>
      )}

      {/* Add custom field (only for AI research / editable forms) */}
      {allowFieldEditing && (
        <div className="border-t border-white/10 pt-3">
          <p className="text-xs text-white/40 mb-2">Add custom field</p>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <input
                type="text"
                value={newFieldKey}
                onChange={(e) => setNewFieldKey(e.target.value)}
                placeholder="key"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white placeholder-white/30 focus:border-white/30 focus:outline-none"
              />
            </div>
            <div className="flex-1">
              <input
                type="text"
                value={newFieldLabel}
                onChange={(e) => setNewFieldLabel(e.target.value)}
                placeholder="Label"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white placeholder-white/30 focus:border-white/30 focus:outline-none"
              />
            </div>
            <label className="flex items-center gap-1 text-xs text-white/40">
              <input
                type="checkbox"
                checked={newFieldSecret}
                onChange={(e) => setNewFieldSecret(e.target.checked)}
                className="rounded"
              />
              Secret
            </label>
            <button
              onClick={addCustomField}
              disabled={!newFieldKey.trim() || !newFieldLabel.trim()}
              className="px-2 py-1.5 text-xs rounded-lg bg-white/10 text-white/70 hover:bg-white/20 disabled:opacity-30"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* Submit */}
      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg border border-white/10 text-white/60 hover:text-white/80 hover:border-white/20"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!isValid && !existingCredentialId}
          className="px-4 py-2 text-sm rounded-lg bg-white/15 text-white hover:bg-white/25 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {existingCredentialId ? "Update credential" : "Save credential"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps/client && pnpm tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add apps/client/src/components/credentials/CredentialForm.tsx
git commit -m "feat: add shared CredentialForm component

Used by both chat inline modal and Settings page. Supports all three tiers
with source badges, editable fields for AI-researched integrations,
optional field collapsing, and credential updates."
```

---
