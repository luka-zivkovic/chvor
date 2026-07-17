import type { IntegrationManifestV2 } from "@chvor/shared";
import { getLoadedToolsSnapshot } from "./capability-loader.ts";
import {
  resolveIntegrationManifests,
  type IntegrationManifestResolverResult,
  type NativeToolBinding,
} from "./integration-manifest-resolver.ts";
import { getNativeToolGroupMap, getNativeToolTarget } from "./native-tools/index.ts";
import { DIRECT_OAUTH_PROVIDERS } from "./oauth-providers.ts";

function nativeToolBindings(): NativeToolBinding[] {
  return Object.keys(getNativeToolGroupMap()).flatMap((operation) => {
    const target = getNativeToolTarget(operation);
    return target?.kind === "tool" ? [{ capabilityId: target.id, operation }] : [];
  });
}

/**
 * Resolve the initialized active integration catalog without request-time I/O.
 * `null` means startup has not populated the capability snapshot yet.
 */
export function getActiveIntegrationManifestCatalog(): IntegrationManifestResolverResult | null {
  const tools = getLoadedToolsSnapshot();
  if (!tools) return null;
  return resolveIntegrationManifests({
    tools,
    nativeToolBindings: nativeToolBindings(),
    directOAuthProviders: DIRECT_OAUTH_PROVIDERS,
  });
}

export function getActiveIntegrationManifest(id: string): IntegrationManifestV2 | null {
  return (
    getActiveIntegrationManifestCatalog()?.manifests.find((manifest) => manifest.id === id) ?? null
  );
}
