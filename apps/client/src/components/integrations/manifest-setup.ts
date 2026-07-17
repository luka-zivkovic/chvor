import type {
  IntegrationCatalogEntry,
  IntegrationCredential,
  IntegrationManifest,
} from "@chvor/shared";

export interface ManifestSetupTarget {
  manifest: IntegrationManifest;
  credential: IntegrationCredential;
  credentialType: string;
}

function credentialTypeFromDeclaration(
  credential: IntegrationCredential | undefined,
  fallback: string
): string {
  if (!credential) return fallback;
  return credential.id.startsWith("credential.")
    ? credential.id.slice("credential.".length)
    : fallback;
}

/** Resolve a catalog row to the exact active manifest and credential declaration it represents. */
export function resolveManifestSetupTarget(
  entry: IntegrationCatalogEntry,
  manifests: readonly IntegrationManifest[]
): ManifestSetupTarget | undefined {
  if (
    !entry.credentialType ||
    !entry.manifestId ||
    !entry.manifestVersion ||
    !entry.manifestCredentialId
  ) {
    return undefined;
  }
  const manifest = manifests.find(
    (candidate) => candidate.id === entry.manifestId && candidate.version === entry.manifestVersion
  );
  const credential = manifest?.credentials.find(
    (candidate) => candidate.id === entry.manifestCredentialId
  );
  if (
    !manifest ||
    !credential ||
    !manifest.setup.some(
      (step) => step.kind === "credential" && step.credentialId === credential.id
    )
  ) {
    return undefined;
  }
  return {
    manifest,
    credential,
    credentialType: credentialTypeFromDeclaration(credential, entry.credentialType),
  };
}
