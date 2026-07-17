import type { OAuthConnection, OAuthMethod, OAuthReauthenticationTarget } from "@chvor/shared";
import { getCredentialData, listCredentials } from "../db/credential-store.ts";
import { listConnectedAccounts as composioListConnected } from "./composio-client.ts";
import { getActiveIntegrationManifest } from "./integration-manifest-catalog.ts";
import { ensureOAuthCredentialBinding, isOAuthCredentialData } from "./oauth-token-refresh.ts";
import { hasComposioKey } from "./oauth-route-helpers.ts";
import { OAUTH_PROVIDERS } from "./provider-registry.ts";
import type { OAuthConnectionWithAuth, OAuthCredentialData } from "./oauth-route-types.ts";

function directReauthenticationTarget(
  credentialId: string,
  credentialType: string,
  providerId: string,
  data: OAuthCredentialData,
  binding: ReturnType<typeof ensureOAuthCredentialBinding>
): OAuthReauthenticationTarget | undefined {
  if (
    data.oauthKind === "synthesized" ||
    !data.oauthIntegrationId ||
    !data.oauthManifestVersion ||
    !data.oauthManifestCredentialId ||
    binding.integrationId !== binding.manifestId ||
    !data.oauthAppCredentialId
  ) {
    return undefined;
  }
  const provider = OAUTH_PROVIDERS.find(
    (candidate) => candidate.id === providerId && candidate.method === "direct"
  );
  const manifest = getActiveIntegrationManifest(binding.integrationId);
  const declaration = manifest?.oauth.find(
    (candidate) => candidate.id === binding.manifestCredentialId
  );
  if (
    !provider?.setupCredentialType ||
    credentialType !== `oauth-token-${provider.id}` ||
    !manifest ||
    manifest.id !== binding.manifestId ||
    manifest.version !== binding.manifestVersion ||
    !declaration ||
    declaration.mode !== "direct"
  ) {
    return undefined;
  }
  const manifestCredentialId = declaration.clientId.credentialId;
  if (declaration.clientSecret && declaration.clientSecret.credentialId !== manifestCredentialId) {
    return undefined;
  }
  const manifestCredential = manifest.credentials.find(
    (candidate) => candidate.id === manifestCredentialId
  );
  const clientIdField = manifestCredential?.fields.find(
    (candidate) => candidate.id === declaration.clientId.fieldId
  );
  const clientSecretField = declaration.clientSecret
    ? manifestCredential?.fields.find(
        (candidate) => candidate.id === declaration.clientSecret?.fieldId
      )
    : undefined;
  const appCredential = getCredentialData(data.oauthAppCredentialId);
  const persistedClientId = clientIdField
    ? appCredential?.data[clientIdField.storageKey ?? clientIdField.id]
    : undefined;
  const persistedClientSecret = clientSecretField
    ? appCredential?.data[clientSecretField.storageKey ?? clientSecretField.id]
    : undefined;
  if (
    !manifestCredential ||
    !clientIdField ||
    !appCredential ||
    appCredential.cred.type !== provider.setupCredentialType ||
    persistedClientId !== data.clientId ||
    (clientSecretField && !persistedClientSecret)
  ) {
    return undefined;
  }
  return {
    integrationId: manifest.id,
    manifestVersion: manifest.version,
    manifestCredentialId,
    oauthManifestCredentialId: declaration.id,
    credentialType: appCredential.cred.type,
    targetCredentialId: appCredential.cred.id,
    oauthCredentialId: credentialId,
  };
}

export function getLocalOAuthConnections(now = Date.now()): OAuthConnectionWithAuth[] {
  const connections: OAuthConnectionWithAuth[] = [];
  for (const credential of listCredentials()) {
    const stored = getCredentialData(credential.id);
    const data = stored?.data as OAuthCredentialData | undefined;
    if (!stored || !data || !isOAuthCredentialData(credential.type, data)) continue;
    try {
      const binding = ensureOAuthCredentialBinding(credential.id, credential.type, data, now);
      const needsReauthentication =
        binding.authStatus === "reauthentication-required" ||
        binding.authStatus === "revoked" ||
        binding.authStatus === "expired";
      const status: OAuthConnection["status"] =
        binding.authStatus === "active"
          ? "active"
          : binding.authStatus === "expired"
            ? "expired"
            : binding.authStatus === "unknown"
              ? "pending"
              : "failed";
      const providerId = data.provider || credential.type.replace(/^oauth-token-/, "");
      const reauthenticationTarget = needsReauthentication
        ? directReauthenticationTarget(credential.id, credential.type, providerId, data, binding)
        : undefined;
      connections.push({
        id: credential.id,
        platform: providerId,
        method: "direct" as OAuthMethod,
        status,
        connectedAt: credential.createdAt,
        credentialId: credential.id,
        authStatus: binding.authStatus,
        needsReauthentication,
        ...(binding.failureCode ? { failureCode: binding.failureCode } : {}),
        oauthKind: data.oauthKind === "synthesized" ? "synthesized" : "direct",
        ...(reauthenticationTarget ? { reauthenticationTarget } : {}),
      });
    } catch {
      connections.push({
        id: credential.id,
        platform: data.provider || credential.type.replace(/^oauth-token-/, ""),
        method: "direct" as OAuthMethod,
        status: "failed",
        connectedAt: credential.createdAt,
        credentialId: credential.id,
        authStatus: "failed",
        needsReauthentication: true,
        failureCode: "oauth_binding_invalid",
        oauthKind: data.oauthKind === "synthesized" ? "synthesized" : "direct",
      });
    }
  }
  return connections;
}

export async function getComposioConnections(): Promise<OAuthConnection[]> {
  if (!hasComposioKey()) return [];
  try {
    const accounts = await composioListConnected();
    return accounts.map((account) => ({
      id: account.id,
      platform: account.platform,
      method: "composio" as OAuthMethod,
      status: account.status === "active" ? "active" : "pending",
      connectedAt: account.connectedAt,
    }));
  } catch {
    console.warn("[oauth] Composio connection listing failed");
    return [];
  }
}
