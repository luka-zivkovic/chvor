# Credential Management Overhaul — Task 3: Build the Integration Resolver (Tier 1 + 2)

## Task 3: Build the Integration Resolver (Tier 1 + 2)

**Files:**
- Create: `apps/server/src/lib/integration-resolver.ts`
- Test: `apps/server/src/lib/__tests__/integration-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/__tests__/integration-resolver.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the registry client
vi.mock("../registry-client.ts", () => ({
  fetchRegistryIndex: vi.fn(),
  readCachedIndex: vi.fn(),
}));

// Mock the credential store
vi.mock("../../db/credential-store.ts", () => ({
  listCredentials: vi.fn(() => []),
}));

import { resolveIntegration } from "../integration-resolver.ts";
import { fetchRegistryIndex, readCachedIndex } from "../registry-client.ts";
import { listCredentials } from "../../db/credential-store.ts";

describe("resolveIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a known LLM provider from provider registry (Tier 1)", async () => {
    const result = await resolveIntegration("anthropic");
    expect(result.source).toBe("provider-registry");
    expect(result.credentialType).toBe("anthropic");
    expect(result.name).toBe("Anthropic");
    expect(result.fields.length).toBeGreaterThan(0);
    expect(result.fields[0].key).toBe("apiKey");
  });

  it("resolves a known integration provider from provider registry (Tier 1)", async () => {
    const result = await resolveIntegration("telegram");
    expect(result.source).toBe("provider-registry");
    expect(result.credentialType).toBe("telegram");
    expect(result.name).toBe("Telegram Bot");
  });

  it("resolves from Chvor registry when not in provider registry (Tier 2)", async () => {
    const mockIndex = {
      version: 2,
      updatedAt: "2026-01-01T00:00:00Z",
      entries: [
        {
          id: "nocodb",
          kind: "tool",
          name: "NocoDB",
          description: "Manage NocoDB databases",
          version: "1.0.0",
          author: "chvor",
          category: "data",
          tags: ["database"],
          sha256: "abc123",
          credentials: {
            type: "nocodb",
            name: "NocoDB",
            fields: [
              { key: "apiToken", label: "API Token", type: "password", required: true, secret: true },
              { key: "instanceUrl", label: "Instance URL", type: "text", required: true, secret: false },
            ],
          },
        },
      ],
    };
    vi.mocked(fetchRegistryIndex).mockResolvedValue(mockIndex as any);

    const result = await resolveIntegration("nocodb");
    expect(result.source).toBe("chvor-registry");
    expect(result.credentialType).toBe("nocodb");
    expect(result.name).toBe("NocoDB");
    expect(result.registryEntryId).toBe("nocodb");
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0].key).toBe("apiToken");
  });

  it("does fuzzy matching against registry entries", async () => {
    const mockIndex = {
      version: 2,
      updatedAt: "2026-01-01T00:00:00Z",
      entries: [
        {
          id: "github-tools",
          kind: "tool",
          name: "GitHub",
          description: "GitHub API integration",
          version: "1.0.0",
          author: "chvor",
          category: "developer",
          tags: ["github", "git"],
          sha256: "abc123",
          credentials: {
            type: "github",
            name: "GitHub",
            fields: [{ key: "apiKey", label: "Personal Access Token", type: "password" }],
          },
        },
      ],
    };
    vi.mocked(fetchRegistryIndex).mockResolvedValue(mockIndex as any);

    const result = await resolveIntegration("github");
    expect(result.source).toBe("chvor-registry");
    expect(result.name).toBe("GitHub");
  });

  it("returns null when not found in any tier (Tier 3 boundary)", async () => {
    vi.mocked(fetchRegistryIndex).mockResolvedValue({
      version: 2,
      updatedAt: "2026-01-01T00:00:00Z",
      entries: [],
    } as any);
    vi.mocked(readCachedIndex).mockReturnValue(null);

    const result = await resolveIntegration("some-obscure-api");
    expect(result).toBeNull();
  });

  it("flags existing credential if one already exists", async () => {
    vi.mocked(listCredentials).mockReturnValue([
      { id: "cred-123", name: "My Anthropic", type: "anthropic", encryptedData: "", createdAt: "", updatedAt: "", testStatus: "success" },
    ] as any);

    const result = await resolveIntegration("anthropic");
    expect(result!.existingCredentialId).toBe("cred-123");
  });

  it("falls back to cached index when fetch fails", async () => {
    vi.mocked(fetchRegistryIndex).mockRejectedValue(new Error("Network error"));
    vi.mocked(readCachedIndex).mockReturnValue({
      version: 2,
      updatedAt: "2026-01-01T00:00:00Z",
      entries: [
        {
          id: "jira",
          kind: "tool",
          name: "Jira",
          description: "Jira integration",
          version: "1.0.0",
          author: "chvor",
          category: "productivity",
          tags: ["jira"],
          sha256: "abc",
          credentials: {
            type: "jira",
            name: "Jira",
            fields: [{ key: "apiToken", label: "API Token", type: "password" }],
          },
        },
      ],
    } as any);

    const result = await resolveIntegration("jira");
    expect(result!.source).toBe("chvor-registry");
    expect(result!.name).toBe("Jira");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @chvor/server test -- src/lib/__tests__/integration-resolver.test.ts
```

Expected: FAIL — `integration-resolver.ts` doesn't exist yet.

- [ ] **Step 3: Write the integration resolver**

Create `apps/server/src/lib/integration-resolver.ts`:

```typescript
import type { IntegrationResolution } from "@chvor/shared";
import type { ProviderField } from "@chvor/shared";
import { LLM_PROVIDERS, EMBEDDING_PROVIDERS, INTEGRATION_PROVIDERS, IMAGE_GEN_PROVIDERS } from "./provider-registry.ts";
import { fetchRegistryIndex, readCachedIndex } from "./registry-client.ts";
import { listCredentials } from "../db/credential-store.ts";
import { readLock } from "./registry-manager.ts";

/**
 * Resolve an integration by name through three tiers:
 *   Tier 1: Hardcoded provider registry (LLM, embedding, integration, image-gen)
 *   Tier 2: Chvor registry (tools with embedded credential schemas)
 *
 * Returns null if not found in either tier — caller should fall back to Tier 3 (AI research).
 */
export async function resolveIntegration(
  query: string,
): Promise<IntegrationResolution | null> {
  const q = query.trim().toLowerCase();
  const existing = listCredentials();

  // --- Tier 1: Provider Registry ---
  const providerMatch = findInProviderRegistry(q);
  if (providerMatch) {
    const existingCred = existing.find((c) => c.type === providerMatch.credentialType);
    return {
      source: "provider-registry",
      name: providerMatch.name,
      credentialType: providerMatch.credentialType,
      fields: providerMatch.fields,
      existingCredentialId: existingCred?.id,
    };
  }

  // --- Tier 2: Chvor Registry ---
  const registryMatch = await findInChvorRegistry(q);
  if (registryMatch) {
    const existingCred = existing.find((c) => c.type === registryMatch.credentialType);
    const lock = readLock();
    const installed = !!lock.installed[registryMatch.entryId];
    return {
      source: "chvor-registry",
      name: registryMatch.name,
      credentialType: registryMatch.credentialType,
      fields: registryMatch.fields,
      registryEntryId: registryMatch.entryId,
      registryToolInstalled: installed,
      existingCredentialId: existingCred?.id,
    };
  }

  return null;
}

// ── Tier 1 helpers ──────────────────────────────────────────────

interface ProviderMatch {
  name: string;
  credentialType: string;
  fields: ProviderField[];
}

function findInProviderRegistry(query: string): ProviderMatch | null {
  // Search all provider categories
  for (const p of LLM_PROVIDERS) {
    if (p.credentialType === query || p.id === query || p.name.toLowerCase() === query) {
      return { name: p.name, credentialType: p.credentialType, fields: p.requiredFields };
    }
  }
  for (const p of EMBEDDING_PROVIDERS) {
    if (p.credentialType === query || p.id === query || p.name.toLowerCase() === query) {
      return { name: p.name, credentialType: p.credentialType ?? p.id, fields: [] };
    }
  }
  for (const p of INTEGRATION_PROVIDERS) {
    if (p.credentialType === query || p.id === query || p.name.toLowerCase() === query) {
      return { name: p.name, credentialType: p.credentialType, fields: p.requiredFields };
    }
  }
  for (const p of IMAGE_GEN_PROVIDERS) {
    if (p.credentialType === query || p.id === query || p.name.toLowerCase() === query) {
      return { name: p.name, credentialType: p.credentialType, fields: [] };
    }
  }
  return null;
}

// ── Tier 2 helpers ──────────────────────────────────────────────

interface RegistryMatch {
  entryId: string;
  name: string;
  credentialType: string;
  fields: ProviderField[];
}

async function findInChvorRegistry(query: string): Promise<RegistryMatch | null> {
  let index;
  try {
    index = await fetchRegistryIndex();
  } catch {
    index = readCachedIndex();
  }
  if (!index) return null;

  // Only search tool entries that have credentials blocks
  const toolsWithCreds = index.entries.filter(
    (e: any) => e.kind === "tool" && e.credentials?.type && e.credentials?.fields?.length,
  );

  // Exact match on id, credential type, or name
  let match = toolsWithCreds.find(
    (e: any) =>
      e.id === query ||
      e.credentials.type === query ||
      e.name.toLowerCase() === query,
  );

  // Fuzzy: check tags and description
  if (!match) {
    match = toolsWithCreds.find(
      (e: any) =>
        e.tags?.some((t: string) => t.toLowerCase() === query) ||
        e.name.toLowerCase().includes(query) ||
        e.description.toLowerCase().includes(query),
    );
  }

  if (!match) return null;

  const creds = (match as any).credentials;
  return {
    entryId: match.id,
    name: creds.name || match.name,
    credentialType: creds.type,
    fields: creds.fields.map((f: any) => ({
      key: f.key,
      label: f.label,
      type: f.secret ? ("password" as const) : ("text" as const),
      placeholder: f.placeholder,
      helpText: f.helpText,
      helpUrl: f.helpUrl,
      optional: !f.required,
    })),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @chvor/server test -- src/lib/__tests__/integration-resolver.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/integration-resolver.ts apps/server/src/lib/__tests__/integration-resolver.test.ts
git commit -m "feat: add three-tier integration resolver (Tier 1 + 2)

Tier 1: checks hardcoded provider registry (LLM, embedding, integration, image-gen).
Tier 2: searches Chvor registry for tools with embedded credential schemas.
Returns null for unknown services — caller falls back to Tier 3 (AI research)."
```

---
