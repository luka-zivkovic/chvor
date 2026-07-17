import { getCredentialData, listCredentialMetadata } from "../db/credential-store.ts";
import {
  listIntegrationCredentialBindingsForCredential,
  updateIntegrationCredentialAuthState,
  type IntegrationCredentialBinding,
} from "../db/integration-setup-store.ts";
import {
  reusableIntegrationOAuthAccountBinding,
  type IntegrationOAuthAccountScope,
} from "./integration-setup-validation.ts";

export function integrationOAuthAccountBinding(
  targetCredentialId: string | undefined,
  scope: IntegrationOAuthAccountScope,
  credentialId: string
): IntegrationCredentialBinding | null {
  const credential = listCredentialMetadata().find(
    (item) => item.id === credentialId && item.type === scope.credentialType
  );
  if (!credential || credential.id === targetCredentialId) return null;
  return (
    listIntegrationCredentialBindingsForCredential(credentialId).find(
      (binding) =>
        binding.integrationId === scope.manifestId &&
        binding.manifestCredentialId === scope.manifestOAuthId &&
        (binding.authMethod === "oauth" || binding.authMethod === "oauth2")
    ) ?? null
  );
}

export function integrationOAuthAccountUsesTargetApp(
  oauthCredentialId: string,
  targetCredentialId: string | undefined
): boolean {
  if (!targetCredentialId) return false;
  const account = getCredentialData(oauthCredentialId)?.data as Record<string, string> | undefined;
  if (account?.oauthAppCredentialId) return account.oauthAppCredentialId === targetCredentialId;
  const app = getCredentialData(targetCredentialId)?.data as Record<string, string> | undefined;
  return !!account?.clientId && account.clientId === app?.clientId;
}

export function reconcileIntegrationOAuthAccountBinding(
  scope: IntegrationOAuthAccountScope,
  binding: IntegrationCredentialBinding
): void {
  if (reusableIntegrationOAuthAccountBinding(scope, binding) || binding.authStatus !== "active")
    return;
  updateIntegrationCredentialAuthState(binding, {
    authStatus: "reauthentication-required",
    failureCode: "reauthentication_required",
  });
}
