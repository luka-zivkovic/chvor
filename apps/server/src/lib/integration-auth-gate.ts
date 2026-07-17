import { getCredentialData } from "../db/credential-store.ts";
import { getDb } from "../db/database.ts";
import {
  getIntegrationCredentialBinding,
  listIntegrationCredentialBindingsForCredential,
  updateIntegrationCredentialAuthState,
  type IntegrationCredentialBinding,
} from "../db/integration-setup-store.ts";
import { ensureOAuthCredentialBinding, isOAuthCredentialData } from "./oauth-token-refresh.ts";
import {
  CredentialReauthenticationRequiredError,
  getPersistedCredentialAuthBlock,
  type CredentialAuthBlock,
} from "./credential-auth-usability.ts";

export {
  CredentialReauthenticationRequiredError,
  type CredentialAuthBlock,
} from "./credential-auth-usability.ts";

/**
 * Mark one elapsed binding only while both the credential ciphertext and the
 * binding state still match the snapshots used by the runtime gate. The
 * immediate transaction makes this safe across server processes: a refresh
 * that wins first changes the ciphertext and active binding, while a refresh
 * that wins second restores the binding after this transition.
 */
export function markCredentialBindingElapsedIfCurrent(
  credentialId: string,
  expectedEncryptedData: string,
  expectedBinding: IntegrationCredentialBinding,
  hasRefreshToken: boolean,
  now = Date.now()
): IntegrationCredentialBinding | null {
  return getDb()
    .transaction(() => {
      const credential = getDb()
        .prepare("SELECT encrypted_data FROM credentials WHERE id = ?")
        .get(credentialId) as { encrypted_data: string } | undefined;
      const current = getIntegrationCredentialBinding(expectedBinding);
      if (!credential || !current) return current;
      if (credential.encrypted_data !== expectedEncryptedData) return current;
      if (
        current.authStatus !== expectedBinding.authStatus ||
        current.tokenExpiresAt !== expectedBinding.tokenExpiresAt
      ) {
        return current;
      }

      const expiry = current.tokenExpiresAt ? Date.parse(current.tokenExpiresAt) : Number.NaN;
      if (
        (current.authStatus !== "active" && current.authStatus !== "unknown") ||
        !Number.isFinite(expiry) ||
        expiry > now
      ) {
        return current;
      }
      return updateIntegrationCredentialAuthState(current, {
        authStatus: hasRefreshToken ? "expired" : "reauthentication-required",
        failureCode: hasRefreshToken ? null : "oauth_refresh_unavailable",
        tokenExpiresAt: current.tokenExpiresAt,
      });
    })
    .immediate();
}

/**
 * Return the strongest persisted auth block for a credential. OAuth
 * credentials are lazily adopted here so an elapsed token cannot bypass the
 * durable runtime gate merely because no setup screen has read it yet.
 */
export function getCredentialAuthBlock(
  credentialId: string,
  now = Date.now()
): CredentialAuthBlock | null {
  // Enforce an existing durable block before decrypting. Only credentials
  // without a persisted block need the lazy OAuth-adoption path below.
  const persistedBlock = getPersistedCredentialAuthBlock(credentialId);
  if (persistedBlock) return persistedBlock;

  const stored = getCredentialData(credentialId);
  const data = stored?.data as Record<string, string> | undefined;
  if (stored && data && isOAuthCredentialData(stored.cred.type, data)) {
    ensureOAuthCredentialBinding(credentialId, stored.cred.type, data, now);
  }

  const bindings: IntegrationCredentialBinding[] =
    listIntegrationCredentialBindingsForCredential(credentialId);
  for (const binding of bindings) {
    const expiry = binding.tokenExpiresAt ? Date.parse(binding.tokenExpiresAt) : Number.NaN;
    if (
      (binding.authStatus === "active" || binding.authStatus === "unknown") &&
      Number.isFinite(expiry) &&
      expiry <= now
    ) {
      markCredentialBindingElapsedIfCurrent(
        credentialId,
        stored?.cred.encryptedData ?? "",
        binding,
        !!data?.refreshToken,
        now
      );
    }
  }
  return getPersistedCredentialAuthBlock(credentialId);
}

export function assertCredentialAuthUsable(credentialId: string): void {
  const block = getCredentialAuthBlock(credentialId);
  if (block) throw new CredentialReauthenticationRequiredError(block);
}

export function isCredentialAuthUsable(credentialId: string): boolean {
  return getCredentialAuthBlock(credentialId) === null;
}
