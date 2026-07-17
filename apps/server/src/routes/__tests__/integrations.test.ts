import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/integration-resolver.ts", () => ({
  resolveIntegration: vi.fn(),
}));

vi.mock("../../lib/integration-research.ts", () => ({
  researchIntegration: vi.fn(),
}));

vi.mock("../../lib/registry-client.ts", () => ({
  fetchRegistryIndex: vi.fn().mockResolvedValue({ entries: [] }),
  readCachedIndex: vi.fn().mockReturnValue({ entries: [] }),
}));

const manifestMocks = vi.hoisted(() => ({
  getCatalog: vi.fn(),
}));

vi.mock("../../lib/integration-manifest-catalog.ts", () => ({
  getActiveIntegrationManifestCatalog: manifestMocks.getCatalog,
}));

import { resolveIntegration } from "../../lib/integration-resolver.ts";
import { researchIntegration } from "../../lib/integration-research.ts";

const mockResolve = vi.mocked(resolveIntegration);
const mockResearch = vi.mocked(researchIntegration);

// Import the Hono app for testing
import integrations from "../integrations.ts";
import { _resetForTests } from "../integrations.ts";

async function request(path: string): Promise<Response> {
  const req = new Request(`http://localhost${path}`);
  return integrations.fetch(req);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  mockResolve.mockResolvedValue(null);
  mockResearch.mockResolvedValue({
    name: "Test",
    credentialType: "test",
    fields: [{ key: "apiKey", label: "API Key", type: "password" }],
    confidence: "inferred",
  });
  manifestMocks.getCatalog.mockReturnValue({ manifests: [], diagnostics: [] });
});

describe("GET /manifests", () => {
  it("uses the complete read-only manifest catalog", async () => {
    const snapshot = { manifests: [{ id: "tool.active-tool" }], diagnostics: [] };
    manifestMocks.getCatalog.mockReturnValue(snapshot);

    const res = await request("/manifests");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(manifestMocks.getCatalog).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ data: snapshot });
  });

  it("returns an actionable retry response before the snapshot is initialized", async () => {
    manifestMocks.getCatalog.mockReturnValue(null);

    const res = await request("/manifests");

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: {
        code: "CAPABILITY_CATALOG_NOT_READY",
        message: "The active integration catalog is still initializing. Retry shortly.",
      },
    });
  });
});

describe("GET /catalog", () => {
  it("attaches exact active manifest and credential declaration references", async () => {
    manifestMocks.getCatalog.mockReturnValue({
      manifests: [
        {
          id: "provider.integration.github",
          version: "7.0.0",
          credentials: [{ id: "credential.github" }],
          setup: [{ kind: "credential", credentialId: "credential.github" }],
        },
      ],
      diagnostics: [],
    });

    const res = await request("/catalog");
    const body = (await res.json()) as {
      data: { entries: Array<Record<string, unknown>> };
    };
    const github = body.data.entries.find((entry) => entry.id === "integration:github");

    expect(res.status).toBe(200);
    expect(github).toMatchObject({
      manifestId: "provider.integration.github",
      manifestVersion: "7.0.0",
      manifestCredentialId: "credential.github",
    });
  });
});

describe("GET /research", () => {
  it("returns 400 if query is missing", async () => {
    const res = await request("/research");
    expect(res.status).toBe(400);
  });

  it("returns 400 if query is too short", async () => {
    const res = await request("/research?q=a");
    expect(res.status).toBe(400);
  });

  it("returns Tier 1 result when found in provider registry", async () => {
    mockResolve.mockResolvedValue({
      source: "provider-registry",
      name: "Anthropic",
      credentialType: "anthropic",
      fields: [{ key: "apiKey", label: "API Key", type: "password" }],
    });
    const res = await request("/research?q=anthropic");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.source).toBe("provider-registry");
    expect(body).toMatchObject({ source: "provider-registry" });
    expect(mockResearch).not.toHaveBeenCalled();
  });

  it("falls back to AI research when not in registry", async () => {
    const res = await request("/research?q=unknown-service");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.source).toBe("ai-research");
    expect(body).toMatchObject({ source: "ai-research" });
    expect(mockResearch).toHaveBeenCalledWith("unknown-service", { hintedSpecUrl: undefined });
  });

  it("caches AI research results", async () => {
    // Note: must run before rate limit test since they share IP "unknown"
    await request("/research?q=cached-test");
    await request("/research?q=cached-test");
    // researchIntegration should only be called once due to cache
    expect(mockResearch).toHaveBeenCalledTimes(1);
  });

  it("returns 429 when rate limited", async () => {
    // Make 6 requests from same IP (limit is 5/min)
    // Note: this exhausts the rate limit for IP "unknown", so must run last
    for (let i = 0; i < 5; i++) {
      await request("/research?q=test-service");
    }
    const res = await request("/research?q=test-service");
    expect(res.status).toBe(429);
  });
});
