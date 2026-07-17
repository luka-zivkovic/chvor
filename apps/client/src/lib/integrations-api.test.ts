import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("integrations API", () => {
  it("unwraps the manifest catalog response", async () => {
    const catalog = { manifests: [], diagnostics: [] };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ data: catalog }),
    } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.integrations.manifests()).resolves.toEqual(catalog);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/manifests",
      expect.objectContaining({ credentials: "same-origin" })
    );
  });

  it("preserves an actionable manifest initialization error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 503,
      ok: false,
      json: vi.fn().mockResolvedValue({
        error: {
          code: "CAPABILITY_CATALOG_NOT_READY",
          message: "The active integration catalog is still initializing. Retry shortly.",
        },
      }),
    } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.integrations.manifests()).rejects.toMatchObject({
      status: 503,
      code: "CAPABILITY_CATALOG_NOT_READY",
      message: "The active integration catalog is still initializing. Retry shortly.",
    });
  });

  it("encodes research terms and optional HTTPS specification URLs", async () => {
    const result = {
      source: "ai-research",
      name: "Example",
      credentialType: "example",
      fields: [],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ data: result }),
    } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.integrations.research("example cloud", {
        specUrl: "https://example.com/openapi.json?version=1",
      })
    ).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/research?q=example+cloud&specUrl=https%3A%2F%2Fexample.com%2Fopenapi.json%3Fversion%3D1",
      expect.objectContaining({ credentials: "same-origin" })
    );
  });
});
