import { isIP } from "node:net";
import {
  INTEGRATION_MANIFEST_LIMITS,
  type IntegrationAuthStatus,
  type IntegrationManifest,
} from "@chvor/shared";
import { DIRECT_OAUTH_PROVIDERS } from "./oauth-providers.ts";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

type ManifestCredentialField = IntegrationManifest["credentials"][number]["fields"][number];

function localHttpHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    (isIP(host) === 4 && host.split(".")[0] === "127") ||
    host.endsWith(".local")
  );
}

export function validIntegrationCredentialFieldValue(
  field: ManifestCredentialField,
  value: string | undefined
): boolean {
  if (value === undefined || value === "" || CONTROL_CHARACTER.test(value)) {
    return false;
  }
  if (field.sensitivity === "url") {
    if (value.length > INTEGRATION_MANIFEST_LIMITS.reference) return false;
    try {
      const url = new URL(value);
      return (
        url.username === "" &&
        url.password === "" &&
        url.hash === "" &&
        (url.protocol === "https:" || (url.protocol === "http:" && localHttpHost(url)))
      );
    } catch {
      return false;
    }
  }
  if (field.sensitivity === "path") {
    if (value.length > INTEGRATION_MANIFEST_LIMITS.reference) return false;
    return (
      value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith(".\\") ||
      WINDOWS_ABSOLUTE_PATH.test(value)
    );
  }
  return true;
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  const expected = [...left].sort();
  const actual = [...right].sort();
  return (
    expected.length === actual.length && expected.every((scope, index) => scope === actual[index])
  );
}

function sameParameters(
  declared: readonly { name: string; value: string }[] | undefined,
  configured: Readonly<Record<string, string>> | undefined
): boolean {
  const expected = [...(declared ?? [])]
    .map(({ name, value }) => [name, value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const actual = Object.entries(configured ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return (
    expected.length === actual.length &&
    expected.every(
      ([name, value], index) => name === actual[index]?.[0] && value === actual[index]?.[1]
    )
  );
}

export type IntegrationOAuthAccountScope = {
  manifestId: string;
  manifestVersion: string;
  manifestOAuthId: string;
  provider: string;
  credentialType: string;
  scopes: string[];
};

export type IntegrationOAuthBindingReuseMetadata = {
  manifestId: string;
  manifestVersion: string;
  manifestCredentialId: string;
  authMethod: string;
  authStatus: IntegrationAuthStatus;
  tokenExpiresAt?: string;
  scopes: readonly string[];
};

/** An account remains reusable only while its persisted grant covers the exact active contract. */
export function reusableIntegrationOAuthAccountBinding(
  scope: IntegrationOAuthAccountScope,
  binding: IntegrationOAuthBindingReuseMetadata,
  now = Date.now()
): boolean {
  if (
    binding.manifestId !== scope.manifestId ||
    binding.manifestVersion !== scope.manifestVersion ||
    binding.manifestCredentialId !== scope.manifestOAuthId ||
    (binding.authMethod !== "oauth" && binding.authMethod !== "oauth2") ||
    binding.authStatus !== "active"
  ) {
    return false;
  }
  const grantedScopes = new Set(binding.scopes);
  if (scope.scopes.some((requiredScope) => !grantedScopes.has(requiredScope))) return false;
  if (!binding.tokenExpiresAt) return true;
  const expiresAt = Date.parse(binding.tokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** Resolve the exact account namespace represented by one active direct OAuth setup step. */
export function integrationOAuthAccountScope(
  manifest: IntegrationManifest,
  setupStepId: string | undefined
): IntegrationOAuthAccountScope | null {
  const setup = manifest.setup.find((step) => step.id === setupStepId);
  if (!setup || setup.kind !== "oauth") return null;
  const declaration = manifest.oauth.find((oauth) => oauth.id === setup.oauthId);
  if (
    !declaration ||
    declaration.mode !== "direct" ||
    !("provider" in declaration) ||
    typeof declaration.provider !== "string"
  ) {
    return null;
  }
  const matches = DIRECT_OAUTH_PROVIDERS.filter(
    (provider) =>
      provider.id === declaration.provider &&
      provider.authUrl === declaration.authorizationUrl &&
      provider.tokenUrl === declaration.tokenUrl &&
      sameScopes(provider.scopes, declaration.scopes) &&
      sameParameters(declaration.authorizationParams, provider.extraAuthParams) &&
      sameParameters(declaration.tokenParams, provider.extraTokenParams)
  );
  return matches.length === 1
    ? {
        manifestId: manifest.id,
        manifestVersion: manifest.version,
        manifestOAuthId: declaration.id,
        provider: declaration.provider,
        credentialType: `oauth-token-${declaration.provider}`,
        scopes: [...declaration.scopes],
      }
    : null;
}
