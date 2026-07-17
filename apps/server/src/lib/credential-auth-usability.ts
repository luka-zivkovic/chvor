import type { IntegrationAuthStatus } from "@chvor/shared";
import { listIntegrationCredentialBindingsForCredential } from "../db/integration-setup-store.ts";

const BLOCKING_AUTH_STATUSES = new Set<IntegrationAuthStatus>([
  "expired",
  "revoked",
  "reauthentication-required",
  "failed",
]);

const AUTH_STATUS_PRIORITY: Record<IntegrationAuthStatus, number> = {
  unknown: 0,
  active: 0,
  expired: 1,
  failed: 2,
  revoked: 3,
  "reauthentication-required": 4,
};

export interface CredentialAuthBlock {
  credentialId: string;
  authStatus: IntegrationAuthStatus;
  failureCode?: string;
}

export class CredentialReauthenticationRequiredError extends Error {
  readonly code = "integration_reauthentication_required";

  constructor(readonly block: CredentialAuthBlock) {
    super(
      `credential ${block.credentialId} is not currently usable (${block.authStatus}) — reconnect it in Settings > Integrations`
    );
    this.name = "CredentialReauthenticationRequiredError";
  }
}

/** Read only persisted auth state; this never decrypts the credential it protects. */
export function getPersistedCredentialAuthBlock(
  credentialId: string
): CredentialAuthBlock | null {
  const blocked = listIntegrationCredentialBindingsForCredential(credentialId)
    .filter((binding) => BLOCKING_AUTH_STATUSES.has(binding.authStatus))
    .sort(
      (left, right) =>
        AUTH_STATUS_PRIORITY[right.authStatus] - AUTH_STATUS_PRIORITY[left.authStatus]
    )[0];
  if (!blocked) return null;
  return {
    credentialId,
    authStatus: blocked.authStatus,
    ...(blocked.failureCode ? { failureCode: blocked.failureCode } : {}),
  };
}

/** Cycle-safe low-level gate for callers that must check before decrypting. */
export function assertCredentialAuthUsable(credentialId: string): void {
  const block = getPersistedCredentialAuthBlock(credentialId);
  if (block) throw new CredentialReauthenticationRequiredError(block);
}
