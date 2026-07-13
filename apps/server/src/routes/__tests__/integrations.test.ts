import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/integration-resolver.ts", () => ({
  resolveIntegration: vi.fn(),
}));

vi.mock("../../lib/integration-research.ts", () => ({
  researchIntegration: vi.fn(),
}));

const manifestMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  getLoadedToolsSnapshot: vi.fn(),
  getNativeToolGroupMap: vi.fn(),
  getNativeToolTarget: vi.fn(),
  loadTools: vi.fn(),
}));

vi.mock("../../lib/integration-manifest-resolver.ts", () => ({
  resolveIntegrationManifests: manifestMocks.resolve,
}));

vi.mock("../../lib/capability-loader.ts", () => ({
  getLoadedToolsSnapshot: manifestMocks.getLoadedToolsSnapshot,
  loadTools: manifestMocks.loadTools,
}));

vi.mock("../../lib/native-tools/index.ts", () => ({
  getNativeToolGroupMap: manifestMocks.getNativeToolGroupMap,
  getNativeToolTarget: manifestMocks.getNativeToolTarget,
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
  manifestMocks.getLoadedToolsSnapshot.mockReturnValue([]);
  manifestMocks.getNativeToolGroupMap.mockReturnValue({});
  manifestMocks.getNativeToolTarget.mockReturnValue(null);
  manifestMocks.resolve.mockReturnValue({ manifests: [], diagnostics: [] });
});

describe("GET /manifests", () => {
  it("uses the complete read-only catalog snapshot and native bindings", async () => {
    const tool = { id: "active-tool", kind: "tool" };
    const snapshot = { manifests: [{ id: "tool.active-tool" }], diagnostics: [] };
    manifestMocks.getLoadedToolsSnapshot.mockReturnValue([tool]);
    manifestMocks.getNativeToolGroupMap.mockReturnValue({ native__active: {} });
    manifestMocks.getNativeToolTarget.mockReturnValue({ kind: "tool", id: "active-tool" });
    manifestMocks.resolve.mockReturnValue(snapshot);

    const res = await request("/manifests");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(manifestMocks.getLoadedToolsSnapshot).toHaveBeenCalledOnce();
    expect(manifestMocks.loadTools).not.toHaveBeenCalled();
    expect(manifestMocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [tool],
        nativeToolBindings: [
          { capabilityId: "active-tool", operation: "native__active" },
        ],
      })
    );
    expect(await res.json()).toEqual({ data: snapshot });
  });

  it("returns an actionable retry response before the snapshot is initialized", async () => {
    manifestMocks.getLoadedToolsSnapshot.mockReturnValue(null);

    const res = await request("/manifests");

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(manifestMocks.resolve).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      error: {
        code: "CAPABILITY_CATALOG_NOT_READY",
        message: "The active integration catalog is still initializing. Retry shortly.",
      },
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.source).toBe("provider-registry");
    expect(mockResearch).not.toHaveBeenCalled();
  });

  it("falls back to AI research when not in registry", async () => {
    const res = await request("/research?q=unknown-service");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.source).toBe("ai-research");
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
