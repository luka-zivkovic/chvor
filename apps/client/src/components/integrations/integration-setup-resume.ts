import type { IntegrationSetupFlowSnapshot, IntegrationSetupMode } from "@chvor/shared";

const TERMINAL_STATUSES = new Set<IntegrationSetupFlowSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export interface IntegrationSetupIdentity {
  manifestId: string;
  manifestVersion: string;
  manifestCredentialId?: string;
  credentialType: string;
  mode: IntegrationSetupMode;
  setupTargetCredentialId?: string;
  oauthCredentialId?: string;
}

export type IntegrationSetupManifestIdentity = Pick<
  IntegrationSetupIdentity,
  "manifestId" | "manifestVersion" | "manifestCredentialId" | "credentialType"
>;

function segment(value: string | undefined, fallback: string): string {
  return encodeURIComponent(value ?? fallback);
}

/** Resume keys contain every non-secret identity dimension that defines a setup flow. */
export function integrationSetupResumeKey(identity: IntegrationSetupIdentity): string {
  return [
    "chvor.integration-setup.v1",
    segment(identity.manifestId, "missing-manifest"),
    segment(identity.manifestVersion, "missing-version"),
    segment(identity.manifestCredentialId, "no-credential-declaration"),
    segment(identity.credentialType, "missing-credential-type"),
    segment(identity.mode, "setup"),
    segment(identity.setupTargetCredentialId, "new-setup-target"),
    segment(identity.oauthCredentialId, "new-oauth-account"),
  ].join(":");
}

export function flowOAuthCredentialId(flow: IntegrationSetupFlowSnapshot): string | undefined {
  const value = flow.oauthCredentialId;
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}

/** Fail closed when a persisted flow belongs to a different manifest/setup identity. */
export function setupFlowMatchesIdentity(
  flow: IntegrationSetupFlowSnapshot,
  identity: IntegrationSetupIdentity
): boolean {
  if (
    flow.integrationId !== identity.manifestId ||
    flow.manifestVersion !== identity.manifestVersion ||
    flow.manifestCredentialId !== identity.manifestCredentialId ||
    flow.credentialType !== identity.credentialType ||
    flow.mode !== identity.mode
  ) {
    return false;
  }
  if (
    identity.setupTargetCredentialId !== undefined &&
    flow.targetCredentialId !== identity.setupTargetCredentialId
  ) {
    return false;
  }
  const snapshotOAuthCredentialId = flowOAuthCredentialId(flow);
  return (
    identity.oauthCredentialId === undefined ||
    snapshotOAuthCredentialId === identity.oauthCredentialId
  );
}

/** Find the newest resumable flow for a resolved manifest credential, before deriving a new mode. */
export function findActiveIntegrationSetupFlow(
  flows: readonly IntegrationSetupFlowSnapshot[],
  identity: IntegrationSetupManifestIdentity
): IntegrationSetupFlowSnapshot | undefined {
  return flows
    .filter(
      (flow) =>
        !TERMINAL_STATUSES.has(flow.status) &&
        flow.integrationId === identity.manifestId &&
        flow.manifestVersion === identity.manifestVersion &&
        flow.manifestCredentialId === identity.manifestCredentialId &&
        flow.credentialType === identity.credentialType
    )
    .sort((left, right) => {
      const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return updated || right.revision - left.revision || right.id.localeCompare(left.id);
    })[0];
}
