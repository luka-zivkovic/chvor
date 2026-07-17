import type {
  IntegrationCatalogResponse,
  IntegrationManifest,
  IntegrationManifestDiagnostic,
  IntegrationResolution,
} from "@chvor/shared";

type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function createIntegrationsApi(request: JsonRequest) {
  return {
    manifests: () =>
      request<{
        manifests: IntegrationManifest[];
        diagnostics: IntegrationManifestDiagnostic[];
      }>("/integrations/manifests"),
    catalog: () => request<IntegrationCatalogResponse>("/integrations/catalog"),
    research: (q: string, opts?: { specUrl?: string }) => {
      const params = new URLSearchParams({ q });
      if (opts?.specUrl) params.set("specUrl", opts.specUrl);
      return request<IntegrationResolution>(`/integrations/research?${params.toString()}`);
    },
  };
}
