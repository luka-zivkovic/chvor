import { getCredentialData, listCredentialMetadata } from "../db/credential-store.ts";
import { getIntegrationSetupFlow } from "../db/integration-setup-store.ts";
import {
  assertCredentialAuthUsable,
  getPersistedCredentialAuthBlock,
} from "./credential-auth-usability.ts";
import { OAUTH_PROVIDERS } from "./provider-registry.ts";
import type { OAuthTokens } from "./oauth-engine.ts";
import type { DirectOAuthInitiate, OAuthCredentialData } from "./oauth-route-types.ts";

type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function directAppCredentials(provider: OAuthProvider) {
  return provider.setupCredentialType
    ? listCredentialMetadata().filter(
        (item) =>
          item.type === provider.setupCredentialType && !getPersistedCredentialAuthBlock(item.id)
      )
    : [];
}

function readDirectAppCredential(credentialId: string) {
  // App credentials are authentication material too. Enforce the durable gate
  // before decrypting or using a client secret, rather than only gating the
  // OAuth account token produced with it.
  assertCredentialAuthUsable(credentialId);
  const stored = getCredentialData(credentialId);
  const values = stored?.data as OAuthCredentialData | undefined;
  return stored && values?.clientId
    ? {
        credentialId: stored.cred.id,
        credentialType: stored.cred.type,
        encryptedData: stored.cred.encryptedData,
        clientId: values.clientId,
        ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}),
      }
    : null;
}

/** Resolve a unique/exact app credential; never use an arbitrary first match. */
export function getClientSecretForProvider(
  providerId: string,
  clientId?: string,
  appCredentialId?: string
): string | undefined {
  const provider = OAUTH_PROVIDERS.find((item) => item.id === providerId);
  if (!provider?.setupCredentialType) return undefined;
  const candidates = directAppCredentials(provider).filter((item) => {
    if (appCredentialId) return item.id === appCredentialId;
    const selected = readDirectAppCredential(item.id);
    return clientId ? selected?.clientId === clientId : true;
  });
  if (candidates.length !== 1) return undefined;
  return readDirectAppCredential(candidates[0].id)?.clientSecret;
}

export function selectDirectOAuthCredentials(
  provider: OAuthProvider,
  body: DirectOAuthInitiate,
  oauthCredentialId?: string
):
  | { selected: NonNullable<ReturnType<typeof readDirectAppCredential>> }
  | { candidateIds: string[] } {
  const candidates = directAppCredentials(provider);
  let selectedId = body.appCredentialId;
  const flow = body.flowId ? getIntegrationSetupFlow(body.flowId) : null;
  if (!selectedId && flow?.targetCredentialId) {
    const target = candidates.find((item) => item.id === flow.targetCredentialId);
    if (target) selectedId = target.id;
  }
  if (!selectedId && oauthCredentialId) {
    const token = getCredentialData(oauthCredentialId)?.data as OAuthCredentialData | undefined;
    if (token?.oauthAppCredentialId) selectedId = token.oauthAppCredentialId;
    else if (token?.clientId) {
      const matching = candidates.filter(
        (item) => readDirectAppCredential(item.id)?.clientId === token.clientId
      );
      if (matching.length === 1) selectedId = matching[0].id;
    }
  }
  if (!selectedId && candidates.length === 1) selectedId = candidates[0].id;
  const selected = selectedId ? readDirectAppCredential(selectedId) : null;
  if (selected && candidates.some((item) => item.id === selected.credentialId)) {
    return { selected };
  }
  return { candidateIds: candidates.map((item) => item.id) };
}

export function hasComposioKey(): boolean {
  return listCredentialMetadata().some(
    (credential) =>
      credential.type === "composio" && !getPersistedCredentialAuthBlock(credential.id)
  );
}

export function splitOAuthScopes(
  value: string | undefined,
  fallback: readonly string[] = []
): string[] {
  const values = value ? value.split(/\s+/).filter(Boolean) : [...fallback];
  return [...new Set(values)].slice(0, 128);
}

export class OAuthInsufficientScopeError extends Error {}

export function validatedGrantedScopes(
  tokens: OAuthTokens,
  requiredScopes: readonly string[]
): string[] {
  const granted = splitOAuthScopes(tokens.scope, requiredScopes);
  if (tokens.scope) {
    const grantedSet = new Set(granted);
    if (requiredScopes.some((scope) => !grantedSet.has(scope))) {
      throw new OAuthInsufficientScopeError("OAuth provider omitted a required scope");
    }
  }
  return granted;
}

export function oauthCallbackOrigin(callbackUrl: string): string {
  try {
    return new URL(callbackUrl).origin;
  } catch {
    return "null";
  }
}

export function exactHttpOrigin(value: string | undefined): string | undefined {
  if (!value || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function oauthPostMessageOrigin(callbackUrl: string): string {
  const configured = process.env.CHVOR_APP_ORIGIN?.trim();
  if (configured) {
    const origin = exactHttpOrigin(configured);
    if (!origin) throw new TypeError("CHVOR_APP_ORIGIN must be an exact HTTP(S) origin");
    return origin;
  }
  const origin = exactHttpOrigin(oauthCallbackOrigin(callbackUrl));
  if (!origin) throw new TypeError("OAuth callback origin is invalid");
  return origin;
}
