import { listCredentials, getCredentialData } from "../db/credential-store.ts";
import { pickCredential, type PickResult } from "./credential-picker.ts";

const PLACEHOLDER_RE = /\{\{credentials\.([^}]+)\}\}/g;

/**
 * Parse a credential reference like "n8n" or "n8n.apiUrl" into type and optional field.
 * "github" → { type: "github", field: undefined }
 * "n8n.apiUrl" → { type: "n8n", field: "apiUrl" }
 */
function parseCredRef(ref: string): { type: string; field?: string } {
  const dotIdx = ref.indexOf(".");
  if (dotIdx === -1) return { type: ref };
  return { type: ref.slice(0, dotIdx), field: ref.slice(dotIdx + 1) };
}

/**
 * Extract a value from credential data, optionally by specific field name.
 * Falls back to well-known field names, then first value.
 */
function extractCredValue(data: Record<string, string>, field?: string): string | undefined {
  if (field) return data[field];
  return data.apiKey ?? data.token ?? data.key ?? Object.values(data)[0];
}

/**
 * Check whether all required credential types have been saved.
 * Returns true when no credentials are required OR all exist.
 */
export function hasRequiredCredentials(
  requiredTypes: string[] | undefined
): boolean {
  if (!requiredTypes || requiredTypes.length === 0) return true;
  const allCreds = listCredentials();
  return requiredTypes.every((t) => allCreds.some((c) => c.type === t));
}

/**
 * Optional context to drive the multi-credential picker (Phase E).
 * - `sessionId` enables session pin lookup.
 * - `preferredUsageContext` is the union of active skills' hints — used to
 *   tie-break between candidates by `usage_context` token overlap.
 * - `onPick` is a sink for picker rationale; orchestrator wires it to a
 *   canvas event so users can see *which* credential fired.
 */
export interface PickerContext {
  sessionId?: string | null;
  preferredUsageContext?: string[];
  onPick?: (info: {
    credentialType: string;
    credentialId: string;
    credentialName: string;
    reason: PickResult["reason"];
    candidateCount: number;
    detail?: string;
  }) => void;
}

function loadPickedCredentialData(
  reqType: string,
  pickerCtx: PickerContext | undefined
): Record<string, string> | null {
  const pick = pickCredential(reqType, {
    sessionId: pickerCtx?.sessionId ?? null,
    preferredUsageContext: pickerCtx?.preferredUsageContext,
  });
  if (!pick) return null;
  const full = getCredentialData(pick.credentialId);
  if (!full) return null;
  if (pickerCtx?.onPick) {
    try {
      const summary = listCredentials().find((c) => c.id === pick.credentialId);
      pickerCtx.onPick({
        credentialType: reqType,
        credentialId: pick.credentialId,
        credentialName: summary?.name ?? pick.credentialId,
        reason: pick.reason,
        candidateCount: pick.candidateCount,
        detail: pick.detail,
      });
    } catch (err) {
      console.warn(
        "[credential-resolver] picker rationale callback failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return full.data;
}

/**
 * Resolve {{credentials.xxx}} placeholders in MCP env config.
 * Supports both simple refs ({{credentials.github}}) and field-specific
 * refs ({{credentials.n8n.apiUrl}}).
 *
 * `pickerContext` is optional and only meaningful when multiple credentials
 * of the same type exist. MCP servers typically spawn once and reuse the
 * resolved env, so the picker context is often spawn-time-only.
 */
export function resolveEnvPlaceholders(
  env: Record<string, string> | undefined,
  requiredCredentials: string[] | undefined,
  pickerContext?: PickerContext
): Record<string, string> {
  if (!env) return {};

  const resolved: Record<string, string> = {};
  const credentialsByType = new Map<string, Record<string, string>>();
  if (requiredCredentials) {
    for (const reqType of requiredCredentials) {
      const data = loadPickedCredentialData(reqType, pickerContext);
      if (data) credentialsByType.set(reqType, data);
    }
  }

  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.replace(PLACEHOLDER_RE, (_match, credRef: string) => {
      const { type, field } = parseCredRef(credRef);
      const data = credentialsByType.get(type);
      if (!data) {
        throw new Error(`[credential-resolver] missing credential for type "${type}" in env var "${key}" — add it in Settings > Credentials`);
      }
      const val = extractCredValue(data, field);
      if (!val) {
        throw new Error(`[credential-resolver] credential "${type}"${field ? ` field "${field}"` : ""} has no usable value for env var "${key}"`);
      }
      return val;
    });
  }

  return resolved;
}

/**
 * Resolve {{credentials.xxx}} placeholders in a URL string.
 * Used for remote MCP transports (SSE/HTTP) where the API key is embedded in the URL.
 */
export function resolveUrlPlaceholders(
  url: string,
  requiredCredentials: string[] | undefined,
  pickerContext?: PickerContext
): string {
  if (!url.includes("{{credentials.")) return url;

  const credentialsByType = new Map<string, Record<string, string>>();
  if (requiredCredentials) {
    for (const reqType of requiredCredentials) {
      const data = loadPickedCredentialData(reqType, pickerContext);
      if (data) credentialsByType.set(reqType, data);
    }
  }

  return url.replace(PLACEHOLDER_RE, (_match, credRef: string) => {
    const { type, field } = parseCredRef(credRef);
    const data = credentialsByType.get(type);
    if (!data) {
      throw new Error(`[credential-resolver] missing credential for type "${type}" — add it in Settings > Credentials`);
    }
    const value = extractCredValue(data, field);
    if (!value) {
      throw new Error(`[credential-resolver] credential "${type}"${field ? ` field "${field}"` : ""} has no usable value`);
    }
    return encodeURIComponent(value);
  });
}
