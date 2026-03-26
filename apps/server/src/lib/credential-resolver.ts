import { listCredentials, getCredentialData } from "../db/credential-store.ts";

const PLACEHOLDER_RE = /\{\{credentials\.([^}]+)\}\}/g;

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
 * Looks up credentials by type from the store, decrypts, and substitutes.
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
    resolved[key] = value.replace(PLACEHOLDER_RE, (_match, credType: string) => {
      const data = credentialsByType.get(credType);
      if (!data) {
        console.warn(
          `[credential-resolver] no credential found for type: ${credType}`
        );
        return "";
      }
      // Return the first value (most credentials have a single field like apiKey)
      const firstValue = Object.values(data)[0];
      return firstValue ?? "";
    });
  }

  return resolved;
}
