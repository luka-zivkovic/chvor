import { getCredentialData } from "../db/credential-store.ts";
import {
  getIntegrationCredentialBinding,
  getIntegrationSetupFlow,
  updateIntegrationCredentialAuthState,
  upsertIntegrationCredentialBinding,
} from "../db/integration-setup-store.ts";
import type { PendingOAuthFlow } from "./oauth-engine.ts";

export function markOAuthAppCredentialRepairRequired(pending: PendingOAuthFlow): void {
  if (!pending.appCredentialId) return;
  try {
    const flow = getIntegrationSetupFlow(pending.flowId);
    if (!flow?.manifestCredentialId || flow.targetCredentialId !== pending.appCredentialId) return;
    const key = {
      credentialId: pending.appCredentialId,
      integrationId: flow.integrationId,
      manifestCredentialId: flow.manifestCredentialId,
    };
    const binding = getIntegrationCredentialBinding(key);
    if (binding) {
      updateIntegrationCredentialAuthState(binding, {
        authStatus: "reauthentication-required",
        failureCode: "oauth_app_configuration_error",
      });
      return;
    }
    if (!getCredentialData(pending.appCredentialId)) return;
    upsertIntegrationCredentialBinding({
      ...key,
      manifestVersion: flow.manifestVersion,
      authMethod: "credential",
      authStatus: "reauthentication-required",
      failureCode: "oauth_app_configuration_error",
    });
  } catch {
    // The callback still fails closed even if a concurrent repair changed state.
  }
}
