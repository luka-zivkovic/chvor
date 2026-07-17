import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLoadedToolsSnapshot: vi.fn(),
  resolveIntegrationManifests: vi.fn(),
  getNativeToolGroupMap: vi.fn(),
  getNativeToolTarget: vi.fn(),
}));

vi.mock("../capability-loader.ts", () => ({
  getLoadedToolsSnapshot: mocks.getLoadedToolsSnapshot,
}));
vi.mock("../integration-manifest-resolver.ts", () => ({
  resolveIntegrationManifests: mocks.resolveIntegrationManifests,
}));
vi.mock("../native-tools/index.ts", () => ({
  getNativeToolGroupMap: mocks.getNativeToolGroupMap,
  getNativeToolTarget: mocks.getNativeToolTarget,
}));
vi.mock("../oauth-providers.ts", () => ({
  DIRECT_OAUTH_PROVIDERS: [{ id: "example-oauth" }],
}));

import {
  getActiveIntegrationManifest,
  getActiveIntegrationManifestCatalog,
} from "../integration-manifest-catalog.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getNativeToolGroupMap.mockReturnValue({ search: "search", internal: "internal" });
  mocks.getNativeToolTarget.mockImplementation((operation: string) =>
    operation === "search"
      ? { kind: "tool", id: "tool.search" }
      : { kind: "internal", id: "internal.only" }
  );
});

describe("active integration manifest catalog", () => {
  it("returns null without resolving before startup publishes the tool snapshot", () => {
    mocks.getLoadedToolsSnapshot.mockReturnValue(null);

    expect(getActiveIntegrationManifestCatalog()).toBeNull();
    expect(mocks.resolveIntegrationManifests).not.toHaveBeenCalled();
  });

  it("resolves only the initialized snapshot and native tool bindings", () => {
    const tools = [{ id: "tool.active" }];
    const result = { manifests: [], diagnostics: [] };
    mocks.getLoadedToolsSnapshot.mockReturnValue(tools);
    mocks.resolveIntegrationManifests.mockReturnValue(result);

    expect(getActiveIntegrationManifestCatalog()).toBe(result);
    expect(mocks.resolveIntegrationManifests).toHaveBeenCalledWith({
      tools,
      nativeToolBindings: [{ capabilityId: "tool.search", operation: "search" }],
      directOAuthProviders: [{ id: "example-oauth" }],
    });
  });

  it("finds an exact manifest without falling back to inactive definitions", () => {
    const match = { id: "tool.active" };
    mocks.getLoadedToolsSnapshot.mockReturnValue([{ id: "tool.active" }]);
    mocks.resolveIntegrationManifests.mockReturnValue({
      manifests: [match],
      diagnostics: [],
    });

    expect(getActiveIntegrationManifest("tool.active")).toBe(match);
    expect(getActiveIntegrationManifest("tool.missing")).toBeNull();
  });

  it("publishes a freshly resolved manifest version instead of caching stale catalog content", () => {
    mocks.getLoadedToolsSnapshot.mockReturnValue([{ id: "tool.active" }]);
    mocks.resolveIntegrationManifests
      .mockReturnValueOnce({
        manifests: [{ id: "tool.active", version: "0.0.0+sha256.first" }],
        diagnostics: [],
      })
      .mockReturnValueOnce({
        manifests: [{ id: "tool.active", version: "0.0.0+sha256.second" }],
        diagnostics: [],
      });

    expect(getActiveIntegrationManifest("tool.active")?.version).toBe("0.0.0+sha256.first");
    expect(getActiveIntegrationManifest("tool.active")?.version).toBe("0.0.0+sha256.second");
    expect(mocks.resolveIntegrationManifests).toHaveBeenCalledTimes(2);
  });
});
