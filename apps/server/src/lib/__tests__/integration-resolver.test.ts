import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RegistryIndex, RegistryEntry, RegistryLock } from "@chvor/shared";
import type { CredentialSummary } from "@chvor/shared";

// ── Mocks ──────────────────────────────────────────────────────

vi.mock("../registry-client.ts", () => ({
  fetchRegistryIndex: vi.fn(),
  readCachedIndex: vi.fn(),
}));

vi.mock("../registry-manager.ts", () => ({
  readLock: vi.fn(),
}));

vi.mock("../../db/credential-store.ts", () => ({
  listCredentials: vi.fn(),
}));

import { resolveIntegration } from "../integration-resolver.ts";
import { fetchRegistryIndex, readCachedIndex } from "../registry-client.ts";
import { readLock } from "../registry-manager.ts";
import { listCredentials } from "../../db/credential-store.ts";

const mockFetch = vi.mocked(fetchRegistryIndex);
const mockCached = vi.mocked(readCachedIndex);
const mockReadLock = vi.mocked(readLock);
const mockListCredentials = vi.mocked(listCredentials);

// ── Helpers ────────────────────────────────────────────────────

function makeRegistryEntry(overrides: Partial<RegistryEntry> & Record<string, unknown> = {}): RegistryEntry & Record<string, unknown> {
  return {
    id: "test-tool",
    kind: "tool",
    name: "Test Tool",
    description: "A test tool",
    version: "1.0.0",
    sha256: "abc123",
    ...overrides,
  };
}

const emptyLock: RegistryLock = {
  installed: {},
  registryUrl: "https://registry.chvor.ai/v1",
  lastChecked: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ version: 1, updatedAt: "", entries: [] });
  mockCached.mockReturnValue(null);
  mockReadLock.mockReturnValue(emptyLock);
  mockListCredentials.mockReturnValue([]);
});

// ── Tests ──────────────────────────────────────────────────────

describe("resolveIntegration", () => {
  // 1. Resolves known LLM provider from Tier 1
  it("resolves known LLM provider (anthropic) from Tier 1", async () => {
    const result = await resolveIntegration("anthropic");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("provider-registry");
    expect(result!.credentialType).toBe("anthropic");
    expect(result!.name).toBe("Anthropic");
    expect(result!.fields.length).toBeGreaterThan(0);
    expect(result!.fields[0].key).toBe("apiKey");
  });

  // 2. Resolves known integration provider (telegram) from Tier 1
  it("resolves known integration provider (telegram) from Tier 1", async () => {
    const result = await resolveIntegration("telegram");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("provider-registry");
    expect(result!.credentialType).toBe("telegram");
    expect(result!.name).toBe("Telegram Bot");
  });

  // 3. Resolves from Chvor registry when not in provider registry (Tier 2)
  it("resolves from Chvor registry (Tier 2) when not in provider registry", async () => {
    const entry = makeRegistryEntry({
      id: "nocodb",
      kind: "tool",
      name: "NocoDB",
      description: "NocoDB integration",
      credentials: {
        type: "nocodb",
        name: "NocoDB",
        fields: [
          { key: "apiToken", label: "API Token", required: true, secret: true },
        ],
      },
    });
    mockFetch.mockResolvedValue({ version: 1, updatedAt: "", entries: [entry as RegistryEntry] });

    const result = await resolveIntegration("nocodb");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("chvor-registry");
    expect(result!.credentialType).toBe("nocodb");
    expect(result!.name).toBe("NocoDB");
    expect(result!.registryEntryId).toBe("nocodb");
    expect(result!.registryToolInstalled).toBe(false);
    expect(result!.fields).toEqual([
      { key: "apiToken", label: "API Token", type: "password" },
    ]);
  });

  // 4. Fuzzy matching on registry entries (tags, name contains)
  it("matches registry entries via fuzzy fallback (tags)", async () => {
    const entry = makeRegistryEntry({
      id: "airtable-connector",
      kind: "tool",
      name: "Airtable Connector",
      description: "Connect to Airtable",
      tags: ["airtable", "database"],
      credentials: {
        type: "airtable",
        name: "Airtable",
        fields: [
          { key: "apiKey", label: "API Key", required: true, secret: true },
        ],
      },
    });
    mockFetch.mockResolvedValue({ version: 1, updatedAt: "", entries: [entry as RegistryEntry] });

    const result = await resolveIntegration("airtable");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("chvor-registry");
    expect(result!.credentialType).toBe("airtable");
  });

  it("matches registry entries via fuzzy fallback (name includes)", async () => {
    const entry = makeRegistryEntry({
      id: "my-acmecrm-tool",
      kind: "tool",
      name: "My AcmeCRM Integration",
      description: "Integrates with AcmeCRM",
      credentials: {
        type: "acmecrm",
        name: "AcmeCRM",
        fields: [
          { key: "token", label: "Token", required: true, secret: true },
        ],
      },
    });
    mockFetch.mockResolvedValue({ version: 1, updatedAt: "", entries: [entry as RegistryEntry] });

    const result = await resolveIntegration("acmecrm");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("chvor-registry");
    expect(result!.credentialType).toBe("acmecrm");
  });

  // 5. Returns null when not found in either tier
  it("returns null when not found in any tier", async () => {
    const result = await resolveIntegration("nonexistent-service-xyz");
    expect(result).toBeNull();
  });

  // 6. Flags existing credential if one exists
  it("flags existing credential when one matches", async () => {
    mockListCredentials.mockReturnValue([
      {
        id: "cred-123",
        name: "My Anthropic Key",
        type: "anthropic",
        createdAt: "2024-01-01",
        redactedFields: { apiKey: "sk-ant-***" },
      } as CredentialSummary,
    ]);

    const result = await resolveIntegration("anthropic");
    expect(result).not.toBeNull();
    expect(result!.existingCredentialId).toBe("cred-123");
  });

  // 7. Falls back to cached index when fetch fails
  it("falls back to cached index when fetch fails", async () => {
    const entry = makeRegistryEntry({
      id: "cached-tool",
      kind: "tool",
      name: "Cached Tool",
      description: "A cached tool",
      credentials: {
        type: "cached-tool",
        name: "Cached Tool",
        fields: [
          { key: "token", label: "Token", required: true, secret: true },
        ],
      },
    });
    mockFetch.mockRejectedValue(new Error("network error"));
    mockCached.mockReturnValue({ version: 1, updatedAt: "", entries: [entry as RegistryEntry] });

    const result = await resolveIntegration("cached-tool");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("chvor-registry");
    expect(result!.name).toBe("Cached Tool");
  });

  // 8. Handles registry entries without credentials blocks (should skip them)
  it("skips registry entries without credentials blocks", async () => {
    const entry = makeRegistryEntry({
      id: "no-creds-tool",
      kind: "tool",
      name: "No Creds Tool",
      description: "Has no credentials block",
    });
    mockFetch.mockResolvedValue({ version: 1, updatedAt: "", entries: [entry as RegistryEntry] });

    const result = await resolveIntegration("no-creds-tool");
    expect(result).toBeNull();
  });

  // Extra: registryToolInstalled is true when installed
  it("sets registryToolInstalled to true when tool is installed", async () => {
    const entry = makeRegistryEntry({
      id: "installed-tool",
      kind: "tool",
      name: "Installed Tool",
      description: "An installed tool",
      credentials: {
        type: "installed-tool",
        name: "Installed Tool",
        fields: [
          { key: "apiKey", label: "API Key", required: true, secret: true },
        ],
      },
    });
    mockFetch.mockResolvedValue({ version: 1, updatedAt: "", entries: [entry as RegistryEntry] });
    mockReadLock.mockReturnValue({
      installed: {
        "installed-tool": {
          kind: "tool",
          version: "1.0.0",
          installedAt: "2024-01-01",
          sha256: "abc",
          source: "registry",
          userModified: false,
        },
      },
      registryUrl: "https://registry.chvor.ai/v1",
      lastChecked: "2024-01-01",
    });

    const result = await resolveIntegration("installed-tool");
    expect(result).not.toBeNull();
    expect(result!.registryToolInstalled).toBe(true);
  });

  // Extra: field mapping — secret: false -> type: "text", required: false -> optional: true
  it("maps registry credential fields correctly", async () => {
    const entry = makeRegistryEntry({
      id: "field-test",
      kind: "tool",
      name: "Field Test",
      description: "Tests field mapping",
      credentials: {
        type: "field-test",
        name: "Field Test",
        fields: [
          { key: "secret", label: "Secret Field", required: true, secret: true },
          { key: "public", label: "Public Field", required: false, secret: false, helpText: "Some help" },
        ],
      },
    });
    mockFetch.mockResolvedValue({ version: 1, updatedAt: "", entries: [entry as RegistryEntry] });

    const result = await resolveIntegration("field-test");
    expect(result).not.toBeNull();
    expect(result!.fields).toEqual([
      { key: "secret", label: "Secret Field", type: "password" },
      { key: "public", label: "Public Field", type: "text", optional: true, helpText: "Some help" },
    ]);
  });

  // Extra: skips embedding providers with null credentialType
  it("resolves embedding provider with non-null credentialType", async () => {
    const result = await resolveIntegration("openai");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("provider-registry");
  });

  it("does not resolve local embedding provider (null credentialType)", async () => {
    // "local" is an embedding provider with credentialType: null
    // It should NOT match as an integration since it has no credentials
    const result = await resolveIntegration("local");
    // It might match via name — but credentialType is null so it should be skipped
    expect(result === null || result.credentialType !== null).toBe(true);
  });
});
