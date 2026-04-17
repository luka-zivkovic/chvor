import { listCredentials, getCredentialData } from "../db/credential-store.ts";

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
 * Resolve {{credentials.xxx}} placeholders in MCP env config.
 * Supports both simple refs ({{credentials.github}}) and field-specific
 * refs ({{credentials.n8n.apiUrl}}).
 */
export function resolveEnvPlaceholders(
  env: Record<string, string> | undefined,
  requiredCredentials: string[] | undefined
): Record<string, string> {
  if (!env) return {};

  const resolved: Record<string, string> = {};

  // Pre-load credential data for required types
  const credentialsByType = new Map<string, Record<string, string>>();
  if (requiredCredentials) {
    const allCreds = listCredentials();
    for (const reqType of requiredCredentials) {
      const match = allCreds.find((c) => c.type === reqType);
      if (match) {
        const full = getCredentialData(match.id);
        if (full) {
          credentialsByType.set(reqType, full.data);
        }
      }
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
  requiredCredentials: string[] | undefined
): string {
  if (!url.includes("{{credentials.")) return url;

  const credentialsByType = new Map<string, Record<string, string>>();
  if (requiredCredentials) {
    const allCreds = listCredentials();
    for (const reqType of requiredCredentials) {
      const match = allCreds.find((c) => c.type === reqType);
      if (match) {
        const full = getCredentialData(match.id);
        if (full) credentialsByType.set(reqType, full.data);
      }
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
