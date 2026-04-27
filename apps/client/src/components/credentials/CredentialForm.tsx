import { useState, useCallback, useMemo } from "react";
import type { ProviderField, ConnectionConfig } from "@chvor/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

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
  confidence?: "researched" | "inferred" | "fallback";
  helpText?: string;
  /** OpenAPI spec URL discovered during research (may be unverified). */
  specUrl?: string;
  /** True iff specUrl was server-verified to be a valid OpenAPI document. */
  specVerified?: boolean;
  /** Auth scheme proposed by research (bearer, oauth2, etc.). Surfaced for transparency. */
  authScheme?: string;
  /** Base URL of the API; required for the 'Test connection' probe to function. */
  baseUrl?: string;
  /** Optional path on baseUrl that returns 2xx with valid auth (e.g. `/v1/me`). */
  probePath?: string;
  allowFieldEditing: boolean;
  existingCredentialId?: string;
  redactedValues?: Record<string, string>;
  onSubmit: (data: CredentialFormData) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Source badge — concise pill for the header.
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
  if (confidence === "fallback") {
    return (
      <Badge className="border-transparent bg-orange-500/20 text-orange-400">
        Manual Fallback
      </Badge>
    );
  }
  if (confidence === "inferred") {
    return (
      <Badge className="border-transparent bg-amber-500/20 text-amber-400">
        AI Inferred
      </Badge>
    );
  }
  return (
    <Badge className="border-transparent bg-sky-500/20 text-sky-400">
      AI Researched
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Provenance banner — explains *what the badge means* in plain language and
// surfaces the OpenAPI spec status. Renders only when there's something
// non-obvious to say (i.e. AI-research source).
// ---------------------------------------------------------------------------

function ProvenanceBanner({
  source,
  confidence,
  specUrl,
  specVerified,
  authScheme,
}: {
  source: CredentialFormProps["source"];
  confidence?: CredentialFormProps["confidence"];
  specUrl?: string;
  specVerified?: boolean;
  authScheme?: string;
}) {
  if (source !== "ai-research") return null;

  let tone: "info" | "warn" | "danger" = "info";
  let title = "";
  let body = "";

  if (confidence === "researched") {
    tone = "info";
    title = "AI-researched from web docs";
    body = "I found these field requirements by searching the web. Verify them against the service's official docs before relying on this in production.";
  } else if (confidence === "inferred") {
    tone = "warn";
    title = "AI-inferred from training data";
    body = "I'm guessing the field requirements from what I learned during training. They may be outdated or incorrect — double-check with the service's official docs.";
  } else if (confidence === "fallback") {
    tone = "danger";
    title = "No information found";
    body = "I couldn't find any documentation for this service. The form below is a generic API key + base URL shape; you'll need to fill in the real values manually.";
  }

  const toneClass = {
    info: "border-sky-500/30 bg-sky-500/10 text-sky-100",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-100",
    danger: "border-orange-500/30 bg-orange-500/10 text-orange-100",
  }[tone];

  const titleColor = {
    info: "text-sky-300",
    warn: "text-amber-300",
    danger: "text-orange-300",
  }[tone];

  return (
    <div className={cn("rounded-md border px-3 py-2 space-y-1.5", toneClass)}>
      <p className={cn("text-xs font-medium", titleColor)}>{title}</p>
      <p className="text-[11px] leading-relaxed opacity-80">{body}</p>
      {(authScheme || specUrl) && (
        <div className="pt-1.5 border-t border-white/10 space-y-0.5 text-[11px] opacity-80">
          {authScheme && (
            <div>
              <span className="opacity-60">Auth scheme: </span>
              <span className="font-mono">{authScheme}</span>
            </div>
          )}
          {specUrl && (
            <div className="break-all">
              <span className="opacity-60">OpenAPI spec: </span>
              {specVerified ? (
                <span>
                  <span className="text-emerald-300">verified</span>{" "}
                  <a
                    href={specUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono underline-offset-2 hover:underline"
                  >
                    {specUrl}
                  </a>
                </span>
              ) : (
                <span className="text-orange-300">
                  unverified — Chvor will not synthesize tools from it
                </span>
              )}
            </div>
          )}
          {!specUrl && (
            <div>
              <span className="opacity-60">OpenAPI spec: </span>
              <span className="text-orange-300">none discovered</span>
            </div>
          )}
        </div>
      )}
    </div>
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
  specUrl,
  specVerified,
  authScheme,
  baseUrl,
  probePath,
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

  // probe state (Track 0.3)
  type ProbeState =
    | { status: "idle" }
    | { status: "running" }
    | { status: "ok"; httpStatus?: number; probedUrl?: string; bodyPreview?: string }
    | { status: "fail"; error: string; httpStatus?: number; probedUrl?: string; bodyPreview?: string };
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });

  // ---- derived ----
  const requiredFields = fields.filter((f) => !f.optional);
  const optionalFields = fields.filter((f) => f.optional);

  const allRequiredFilled = requiredFields.every((f) => {
    if (isUpdate) return true; // empty = keep current
    return values[f.key]?.trim().length > 0;
  });

  /**
   * Resolve the effective base URL: prefer the value the user typed into a
   * baseUrl field (so they can override an AI suggestion), then fall back to
   * the prop. Returns an empty string if nothing usable is set.
   */
  const effectiveBaseUrl = useMemo(() => {
    const userBase = values.baseUrl?.trim();
    if (userBase) return userBase;
    return baseUrl?.trim() ?? "";
  }, [values.baseUrl, baseUrl]);

  /**
   * Build a candidate ConnectionConfig from the current form state for the
   * probe. The probe is only meaningful for AI-research credentials where the
   * authScheme is a simple HTTP scheme (not oauth2, which needs a separate
   * dance).
   */
  const probeReady = useMemo(() => {
    if (source !== "ai-research") return false;
    if (!effectiveBaseUrl) return false;
    if (!allRequiredFilled) return false;
    if (authScheme === "oauth2") return false;
    return true;
  }, [source, effectiveBaseUrl, allRequiredFilled, authScheme]);

  const buildConnectionConfig = useCallback((): ConnectionConfig => {
    const scheme = (authScheme ?? "bearer").toLowerCase();
    let auth: ConnectionConfig["auth"];
    if (scheme === "basic") {
      auth = { scheme: "basic" };
    } else if (scheme === "header" || scheme === "api-key-header") {
      auth = { scheme: "api-key-header", headerName: "x-api-key" };
    } else if (scheme === "query-param") {
      auth = { scheme: "query-param", queryParam: "api_key" };
    } else if (scheme === "custom") {
      auth = { scheme: "custom" };
    } else {
      auth = { scheme: "bearer" };
    }
    return {
      auth,
      baseUrl: effectiveBaseUrl,
      source: "llm-researched",
      confidence: confidence === "researched" ? "medium" : "low",
    };
  }, [authScheme, effectiveBaseUrl, confidence]);

  const runProbe = useCallback(async () => {
    setProbe({ status: "running" });
    try {
      const fieldData: Record<string, string> = {};
      for (const f of fields) {
        const v = values[f.key] ?? "";
        if (v.trim()) fieldData[f.key] = v;
      }
      const result = await api.credentials.testGeneric({
        connectionConfig: buildConnectionConfig(),
        data: fieldData,
        probePath,
      });
      if (result.ok) {
        setProbe({
          status: "ok",
          httpStatus: result.status,
          probedUrl: result.probedUrl,
          bodyPreview: result.bodyPreview,
        });
      } else {
        setProbe({
          status: "fail",
          error: result.error ?? `HTTP ${result.status ?? "?"}`,
          httpStatus: result.status,
          probedUrl: result.probedUrl,
          bodyPreview: result.bodyPreview,
        });
      }
    } catch (err) {
      setProbe({
        status: "fail",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [fields, values, buildConnectionConfig, probePath]);

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

      {/* Provenance banner — explains badge meaning + spec status (AI-research only) */}
      <ProvenanceBanner
        source={source}
        confidence={confidence}
        specUrl={specUrl}
        specVerified={specVerified}
        authScheme={authScheme}
      />

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

      {/* Test connection (AI-research only — known providers already have a test path on save) */}
      {source === "ai-research" && (
        <div className="space-y-2 pt-2 border-t border-white/10">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-white/50">
              {authScheme === "oauth2"
                ? "OAuth2 services need a separate auth dance — saving without test."
                : effectiveBaseUrl
                  ? "Probe this baseUrl with the values above before saving."
                  : "Provide a base URL above to enable connection testing."}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={runProbe}
              disabled={!probeReady || probe.status === "running"}
              className={cn(
                "h-8 border-white/10 text-white/70 hover:bg-white/10 text-xs",
                (!probeReady || probe.status === "running") && "opacity-40",
              )}
            >
              {probe.status === "running" ? "Testing…" : "Test connection"}
            </Button>
          </div>
          {probe.status === "ok" && (
            <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-100 space-y-0.5">
              <p className="font-medium text-emerald-300">
                Connection OK{probe.httpStatus ? ` (HTTP ${probe.httpStatus})` : ""}
              </p>
              {probe.probedUrl && (
                <p className="font-mono opacity-70 break-all">{probe.probedUrl}</p>
              )}
              {probe.bodyPreview && (
                <p className="opacity-70">{probe.bodyPreview}</p>
              )}
            </div>
          )}
          {probe.status === "fail" && (
            <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-100 space-y-0.5">
              <p className="font-medium text-red-300">
                Connection failed{probe.httpStatus ? ` (HTTP ${probe.httpStatus})` : ""}
              </p>
              <p className="opacity-80">{probe.error}</p>
              {probe.probedUrl && (
                <p className="font-mono opacity-60 break-all">{probe.probedUrl}</p>
              )}
              {probe.bodyPreview && (
                <p className="opacity-60 break-all">{probe.bodyPreview}</p>
              )}
            </div>
          )}
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
