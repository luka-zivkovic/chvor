# Credential Management Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flaky chat-based credential management with a registry-first, three-tier system (provider registry → Chvor registry → AI research fallback) where credentials are always collected via secure forms, never plain text.

**Architecture:** Three-tier integration resolution: Tier 1 checks hardcoded provider-registry.ts (LLM/channels), Tier 2 searches the Chvor registry for tool entries with embedded credential schemas, Tier 3 falls back to web search + LLM research. A shared credential form component is used by both the chat inline modal and the Settings page. Flaky files (credential-type-resolver, command-handlers, connection-config-resolver, old CredentialRequest) are deleted and replaced with clean implementations.

**Tech Stack:** TypeScript, Hono (server routes), Zustand (client state), React 19, Vitest, Zod (tool schemas), ai SDK (LLM calls)

**Spec:** `docs/superpowers/specs/2026-04-10-credential-management-overhaul-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `apps/server/src/lib/integration-resolver.ts` | Three-tier resolution: provider registry → Chvor registry → AI research |
| `apps/server/src/lib/integration-research.ts` | Tier 3: web search + LLM extraction for unknown services |
| `apps/server/src/routes/integrations.ts` | `GET /api/integrations/research?q=...` endpoint |
| `apps/server/src/lib/__tests__/integration-resolver.test.ts` | Tests for three-tier resolver |
| `apps/server/src/lib/__tests__/integration-research.test.ts` | Tests for Tier 3 research service |
| `apps/client/src/components/credentials/CredentialForm.tsx` | Shared credential form (chat modal + settings) |

### Modified Files
| File | Changes |
|------|---------|
| `packages/shared/src/types/credential.ts` | Add `CredentialSchema`, `IntegrationResolution`, `ProviderProposal` types |
| `packages/shared/src/types/api.ts` | Update `CredentialRequestData` to carry resolution metadata |
| `apps/server/src/lib/native-tools.ts` | Replace `native__request_credential` + add `native__research_integration`, remove `native__add_credential` |
| `apps/server/src/gateway/ws.ts` | Remove timeout handling from credential respond |
| `apps/server/src/index.ts` | Mount `/api/integrations` route |
| `apps/client/src/stores/app-store.ts` | Update credential request state for new data shape |
| `apps/client/src/components/chat/ChatPanel.tsx` | Use new CredentialForm in modal instead of old CredentialRequest |
| `apps/client/src/components/credentials/AddCredentialDialog.tsx` | Refactor to use shared CredentialForm |
| `apps/client/src/components/panels/SettingsPanel.tsx` | Add registry browsing + custom integration sections |

### Deleted Files
| File | Reason |
|------|--------|
| `apps/server/src/lib/credential-type-resolver.ts` | Replaced by integration-resolver.ts |
| `apps/server/src/lib/command-handlers.ts` | No more /addkey in chat |
| `apps/server/src/lib/connection-config-resolver.ts` | Auth discovery in tool defs or research |
| `apps/client/src/components/chat/CredentialRequest.tsx` | Replaced by shared CredentialForm |

---

## Task 1: Delete Flaky Files + Clean Up References

**Files:**
- Delete: `apps/server/src/lib/credential-type-resolver.ts`
- Delete: `apps/server/src/lib/command-handlers.ts`
- Delete: `apps/server/src/lib/connection-config-resolver.ts`
- Delete: `apps/client/src/components/chat/CredentialRequest.tsx`
- Modify: `apps/server/src/lib/native-tools.ts` (remove imports of deleted modules)
- Modify: `apps/client/src/components/chat/ChatPanel.tsx` (remove CredentialRequest import/usage)

- [ ] **Step 1: Delete the four flaky files**

```bash
rm apps/server/src/lib/credential-type-resolver.ts
rm apps/server/src/lib/command-handlers.ts
rm apps/server/src/lib/connection-config-resolver.ts
rm apps/client/src/components/chat/CredentialRequest.tsx
```

- [ ] **Step 2: Remove imports of deleted modules from native-tools.ts**

In `apps/server/src/lib/native-tools.ts`, the `handleRequestCredential` function (line 1571) imports from `credential-type-resolver.ts` and `connection-config-resolver.ts`. Comment out or stub the entire `handleRequestCredential` function body temporarily — it will be rewritten in Task 5. Replace lines 1571-1697 with a stub:

```typescript
async function handleRequestCredential(
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> {
  return { content: [{ type: "text", text: "Credential request is being redesigned. Please add credentials via Settings > Integrations." }] };
}
```

Also check if `command-handlers.ts` is imported anywhere else (grep for `command-handlers`). Remove those imports.

- [ ] **Step 3: Remove CredentialRequest from ChatPanel.tsx**

In `apps/client/src/components/chat/ChatPanel.tsx`, remove the import of `CredentialRequest` and the JSX that renders `<CredentialRequest>` components (around lines 375-382). Leave the `pendingCredentialRequests` state reference — it will be reconnected in Task 7.

- [ ] **Step 4: Verify the app still builds**

```bash
cd apps/server && pnpm tsc --noEmit 2>&1 | head -30
cd apps/client && pnpm tsc --noEmit 2>&1 | head -30
```

Fix any remaining broken imports. The goal is a clean compile with the credential request flow temporarily stubbed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove flaky credential management files (type resolver, command handlers, connection config resolver, old CredentialRequest)

Start fresh for credential management overhaul. The native__request_credential
tool is temporarily stubbed — will be rewritten with three-tier resolution."
```

---

## Task 2: Add Shared Types

**Files:**
- Modify: `packages/shared/src/types/credential.ts`
- Modify: `packages/shared/src/types/api.ts`
- Test: `apps/server/src/lib/__tests__/integration-resolver.test.ts` (type-check only in this task)

- [ ] **Step 1: Add new types to credential.ts**

Add the following to the end of `packages/shared/src/types/credential.ts`:

```typescript
/** Schema for credential fields — embedded in registry tool definitions or from AI research. */
export interface CredentialSchema {
  type: string;              // credential type slug (e.g., "nocodb")
  name: string;              // display name (e.g., "NocoDB")
  fields: import("./provider.js").ProviderField[];
}

/** Result of the three-tier integration resolution. */
export interface IntegrationResolution {
  source: "provider-registry" | "chvor-registry" | "ai-research";
  /** Display name for the integration */
  name: string;
  /** Credential type slug */
  credentialType: string;
  /** Fields to collect from user */
  fields: import("./provider.js").ProviderField[];
  /** Chvor registry entry ID (Tier 2 only) */
  registryEntryId?: string;
  /** Whether the registry tool is already installed (Tier 2 only) */
  registryToolInstalled?: boolean;
  /** AI research proposal (Tier 3 only) */
  proposal?: ProviderProposal;
  /** Existing credential ID if one already exists for this type */
  existingCredentialId?: string;
}

/** AI-researched integration proposal (Tier 3). */
export interface ProviderProposal {
  name: string;
  credentialType: string;
  fields: import("./provider.js").ProviderField[];
  baseUrl?: string;
  authScheme?: string;
  helpText?: string;
  confidence: "researched" | "inferred";
}
```

- [ ] **Step 2: Update CredentialRequestData in api.ts**

Replace the `CredentialRequestData` interface in `packages/shared/src/types/api.ts` (lines 12-20):

```typescript
export interface CredentialRequestData {
  requestId: string;
  providerName: string;
  providerIcon: string;
  credentialType: string;
  fields: ProviderField[];
  /** Source tier of the resolution */
  source: "provider-registry" | "chvor-registry" | "ai-research";
  /** Chvor registry entry ID — client needs this to show "Installing from registry..." */
  registryEntryId?: string;
  /** Confidence level for AI-researched integrations */
  confidence?: "researched" | "inferred";
  /** General help/setup text */
  helpText?: string;
  /** Whether user can add/remove fields */
  allowFieldEditing: boolean;
  /** For updates — existing credential ID */
  existingCredentialId?: string;
  timestamp: string;
}
```

- [ ] **Step 3: Export new types from shared package index**

Check that `packages/shared/src/types/credential.ts` exports are re-exported from the package entry point. Grep for existing credential exports:

```bash
grep -n "credential" packages/shared/src/index.ts
```

The new types (`CredentialSchema`, `IntegrationResolution`, `ProviderProposal`) should be exported. Add if missing.

- [ ] **Step 4: Verify types compile**

```bash
cd packages/shared && pnpm tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/credential.ts packages/shared/src/types/api.ts
git commit -m "feat: add IntegrationResolution, CredentialSchema, ProviderProposal types

Three-tier credential resolution types for the overhaul: provider-registry,
chvor-registry, and ai-research sources."
```

---

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

## Task 4: Build the AI Research Service (Tier 3)

**Files:**
- Create: `apps/server/src/lib/integration-research.ts`
- Create: `apps/server/src/routes/integrations.ts`
- Modify: `apps/server/src/index.ts` (mount route)
- Test: `apps/server/src/lib/__tests__/integration-research.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/__tests__/integration-research.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock web search
vi.mock("../native-tools.ts", async (importOriginal) => {
  const orig = await importOriginal() as any;
  return {
    ...orig,
    // We'll mock the internal search function
  };
});

import { researchIntegration } from "../integration-research.ts";

// Mock the lightweight LLM call
vi.mock("../llm-router.ts", () => ({
  resolveModelConfig: vi.fn(() => ({
    providerId: "openai",
    model: "gpt-4o-mini",
    apiKey: "test-key",
  })),
  createModel: vi.fn(),
}));

describe("researchIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a ProviderProposal with inferred confidence when no web data", async () => {
    // Mock the internal search to return nothing
    const result = await researchIntegration("some-random-api");
    expect(result).not.toBeNull();
    expect(result!.credentialType).toBe("some-random-api");
    expect(result!.confidence).toBe("inferred");
    expect(result!.fields.length).toBeGreaterThan(0);
    // Should always have at least an apiKey field
    expect(result!.fields.some((f) => f.key === "apiKey")).toBe(true);
  });

  it("normalizes service name to credential type slug", async () => {
    const result = await researchIntegration("My Cool API");
    expect(result!.credentialType).toBe("my-cool-api");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @chvor/server test -- src/lib/__tests__/integration-research.test.ts
```

Expected: FAIL — `integration-research.ts` doesn't exist.

- [ ] **Step 3: Write the AI research service**

Create `apps/server/src/lib/integration-research.ts`:

```typescript
import type { ProviderProposal } from "@chvor/shared";
import type { ProviderField } from "@chvor/shared";

/**
 * Tier 3 AI Research: attempt to discover integration details via web search + LLM.
 * Falls back to pure LLM inference if web search fails.
 */
export async function researchIntegration(
  serviceName: string,
): Promise<ProviderProposal> {
  const slug = serviceName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  // Try web search first
  let webContext: string | null = null;
  try {
    webContext = await searchForApiDocs(serviceName);
  } catch (err) {
    console.warn(`[integration-research] web search failed for "${serviceName}":`, err);
  }

  // If we have web context, use LLM to extract structured info
  if (webContext) {
    try {
      const extracted = await extractWithLLM(serviceName, webContext);
      if (extracted) {
        return {
          ...extracted,
          credentialType: extracted.credentialType || slug,
          confidence: "researched",
        };
      }
    } catch (err) {
      console.warn(`[integration-research] LLM extraction failed:`, err);
    }
  }

  // Fallback: pure LLM inference (no web data)
  try {
    const inferred = await inferWithLLM(serviceName);
    if (inferred) {
      return {
        ...inferred,
        credentialType: inferred.credentialType || slug,
        confidence: "inferred",
      };
    }
  } catch (err) {
    console.warn(`[integration-research] LLM inference failed:`, err);
  }

  // Ultimate fallback: generic form
  return {
    name: serviceName,
    credentialType: slug,
    fields: [
      { key: "apiKey", label: "API Key", type: "password" as const, placeholder: "Your API key" },
      { key: "baseUrl", label: "Instance URL", type: "text" as const, placeholder: "https://...", optional: true },
    ],
    confidence: "inferred",
    helpText: `Could not find specific documentation for ${serviceName}. Please provide your API key and optionally the base URL of your instance.`,
  };
}

/** Search DuckDuckGo for API documentation. */
async function searchForApiDocs(serviceName: string): Promise<string | null> {
  // Reuse the DuckDuckGo scraping logic from native__web_search
  const query = `${serviceName} API authentication documentation`;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Chvor/1.0)" },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) return null;

  const html = await resp.text();
  // Extract text snippets from DuckDuckGo results
  const snippets: string[] = [];
  const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\//g;
  let match;
  while ((match = snippetRegex.exec(html)) !== null && snippets.length < 5) {
    const text = match[1].replace(/<[^>]+>/g, "").trim();
    if (text) snippets.push(text);
  }

  return snippets.length > 0 ? snippets.join("\n\n") : null;
}

/** Use a lightweight LLM to extract structured API info from web search results. */
async function extractWithLLM(
  serviceName: string,
  webContext: string,
): Promise<Omit<ProviderProposal, "confidence"> | null> {
  const { resolveModelConfig, createModel } = await import("./llm-router.ts");
  const { generateText } = await import("ai");

  const config = resolveModelConfig("lightweight");
  if (!config) return null;

  const model = createModel(config);
  const { text } = await generateText({
    model,
    maxTokens: 500,
    system: `You extract API credential information from documentation snippets. Respond ONLY with valid JSON, no markdown.`,
    prompt: `Given these documentation snippets about "${serviceName}", extract the API authentication details.

Snippets:
${webContext}

Respond with JSON:
{
  "name": "Display name of the service",
  "credentialType": "slug-for-credential-type",
  "fields": [
    { "key": "fieldName", "label": "Human Label", "type": "password" or "text", "helpText": "Where to find this", "optional": false }
  ],
  "baseUrl": "base URL pattern if applicable",
  "authScheme": "bearer" or "api-key-header" or "query-param",
  "helpText": "Brief setup instructions"
}

Rules:
- Always include at least an apiKey field
- Mark URL fields as type "text", secret fields as type "password"
- Keep helpText concise
- credentialType should be lowercase, hyphenated slug`,
  });

  try {
    const parsed = JSON.parse(text);
    return {
      name: parsed.name || serviceName,
      credentialType: parsed.credentialType,
      fields: (parsed.fields || []).map((f: any) => ({
        key: f.key,
        label: f.label,
        type: f.type === "password" ? "password" : "text",
        helpText: f.helpText,
        optional: !!f.optional,
      })) as ProviderField[],
      baseUrl: parsed.baseUrl,
      authScheme: parsed.authScheme,
      helpText: parsed.helpText,
    };
  } catch {
    return null;
  }
}

/** Use LLM's training knowledge to infer API details (no web data). */
async function inferWithLLM(
  serviceName: string,
): Promise<Omit<ProviderProposal, "confidence"> | null> {
  const { resolveModelConfig, createModel } = await import("./llm-router.ts");
  const { generateText } = await import("ai");

  const config = resolveModelConfig("lightweight");
  if (!config) return null;

  const model = createModel(config);
  const { text } = await generateText({
    model,
    maxTokens: 500,
    system: `You are an API integration expert. Based on your knowledge, describe how to authenticate with the given service. Respond ONLY with valid JSON, no markdown. If you don't know the service, return a generic API key form.`,
    prompt: `What credentials are needed to connect to "${serviceName}"?

Respond with JSON:
{
  "name": "Display name",
  "credentialType": "slug",
  "fields": [{ "key": "fieldName", "label": "Label", "type": "password" or "text", "helpText": "hint", "optional": false }],
  "baseUrl": "base URL if known",
  "authScheme": "bearer" or "api-key-header" or null,
  "helpText": "Brief note (mention this is based on AI knowledge, may not be current)"
}`,
  });

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Create the integrations API route**

Create `apps/server/src/routes/integrations.ts`:

```typescript
import { Hono } from "hono";
import { resolveIntegration } from "../lib/integration-resolver.ts";
import { researchIntegration } from "../lib/integration-research.ts";

const integrations = new Hono();

/**
 * GET /api/integrations/research?q=<service_name>
 *
 * Three-tier resolution:
 * 1. Check provider registry
 * 2. Search Chvor registry
 * 3. Fall back to AI research
 */
integrations.get("/research", async (c) => {
  const query = c.req.query("q");
  if (!query || query.trim().length < 2) {
    return c.json({ error: "Query parameter 'q' required (min 2 chars)" }, 400);
  }

  // Try Tier 1 + 2
  const resolution = await resolveIntegration(query);
  if (resolution) {
    return c.json(resolution);
  }

  // Tier 3: AI research
  try {
    const proposal = await researchIntegration(query);
    return c.json({
      source: "ai-research" as const,
      name: proposal.name,
      credentialType: proposal.credentialType,
      fields: proposal.fields,
      proposal,
    });
  } catch (err) {
    return c.json({ error: "Research failed", details: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default integrations;
```

- [ ] **Step 5: Mount the route in index.ts**

In `apps/server/src/index.ts`, add the import and route:

```typescript
// Add import near the top with other route imports
import integrationsRoute from "./routes/integrations.ts";

// Add route near line 303 (after registry route)
app.route("/api/integrations", integrationsRoute);
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @chvor/server test -- src/lib/__tests__/integration-research.test.ts
```

Expected: PASS (the tests only check the fallback path which doesn't need real web/LLM calls).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/lib/integration-research.ts apps/server/src/routes/integrations.ts apps/server/src/lib/__tests__/integration-research.test.ts apps/server/src/index.ts
git commit -m "feat: add AI research service (Tier 3) and /api/integrations/research endpoint

Web search + LLM extraction for unknown services, with pure LLM inference fallback.
Generic apiKey+baseUrl form as ultimate fallback."
```

---

## Task 5: Rewrite Native Tools (research + request)

**Files:**
- Modify: `apps/server/src/lib/native-tools.ts`

- [ ] **Step 1: Replace native__request_credential and add native__research_integration**

In `apps/server/src/lib/native-tools.ts`, replace the credential request section (around lines 1549-1713). Remove the old `handleRequestCredential` stub from Task 1, the timeout constant, and the `pendingCredentialRequests` map. Also remove the `native__add_credential` tool (lines ~1450-1543) since it's replaced.

Add the new `native__research_integration` tool and rewrite `native__request_credential`:

```typescript
// ---------------------------------------------------------------------------
// Research integration tool (NEW)
// ---------------------------------------------------------------------------

const RESEARCH_INTEGRATION_NAME = "native__research_integration";
const researchIntegrationToolDef = tool({
  description:
    "[Research Integration] Look up an integration/service to determine what credentials are needed. " +
    "Checks the built-in provider registry, then the Chvor tool registry, then falls back to AI-powered web research. " +
    "Call this BEFORE native__request_credential to determine what fields to collect. " +
    "Returns the integration details including required credential fields and source tier.",
  parameters: z.object({
    service: z.string().describe(
      "The service/integration name (e.g., 'NocoDB', 'Anthropic', 'GitHub', 'My CRM'). Any string accepted.",
    ),
  }),
});

async function handleResearchIntegration(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  const service = String(args.service).trim();
  if (!service) {
    return { content: [{ type: "text", text: "Please provide a service name to research." }] };
  }

  try {
    const { resolveIntegration } = await import("./integration-resolver.ts");

    // Tier 1 + 2
    const resolution = await resolveIntegration(service);
    if (resolution) {
      const fieldList = resolution.fields.map((f) => `- ${f.label}${f.optional ? " (optional)" : " (required)"}`).join("\n");
      const existingNote = resolution.existingCredentialId
        ? `\n\nNote: A "${resolution.credentialType}" credential already exists (id: ${resolution.existingCredentialId}). You can use native__use_credential to access it, or proceed to add another.`
        : "";

      let sourceNote = "";
      if (resolution.source === "provider-registry") {
        sourceNote = `Found "${resolution.name}" in the built-in provider registry.`;
      } else if (resolution.source === "chvor-registry") {
        const installNote = resolution.registryToolInstalled
          ? "Tool is already installed."
          : "Tool will be installed from the Chvor registry when credentials are added.";
        sourceNote = `Found "${resolution.name}" in the Chvor registry. ${installNote}`;
      }

      return {
        content: [{
          type: "text",
          text: `${sourceNote}\n\nRequired credentials for ${resolution.name}:\n${fieldList}${existingNote}\n\nSource: ${resolution.source}\nCredential type: ${resolution.credentialType}\n\nTo collect these credentials, confirm with the user and then call native__request_credential with the resolution data.`,
        }],
        // Attach resolution as structured data for the next tool call
        _resolution: resolution,
      } as any;
    }

    // Tier 3: AI research
    const { researchIntegration } = await import("./integration-research.ts");
    const proposal = await researchIntegration(service);

    const fieldList = proposal.fields.map((f) => `- ${f.label}${f.optional ? " (optional)" : " (required)"}`).join("\n");
    const confidenceNote = proposal.confidence === "inferred"
      ? "⚠️ Based on AI knowledge (no web docs found). Fields may not be accurate."
      : "Based on web research of the service's API documentation.";

    return {
      content: [{
        type: "text",
        text: `Researched "${proposal.name}".\n\n${confidenceNote}\n\nSuggested credentials:\n${fieldList}${proposal.helpText ? `\n\n${proposal.helpText}` : ""}\n\nSource: ai-research (${proposal.confidence})\nCredential type: ${proposal.credentialType}\n\nConfirm with the user, then call native__request_credential to collect credentials.`,
      }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Research failed: ${err instanceof Error ? err.message : String(err)}. Suggest the user add credentials manually in Settings > Integrations.` }],
    };
  }
}

handlers.set(RESEARCH_INTEGRATION_NAME, handleResearchIntegration);
nativeToolMapping.set(RESEARCH_INTEGRATION_NAME, { kind: "tool", id: "credentials" });

// ---------------------------------------------------------------------------
// Request credential tool (REWRITTEN — no timeout, supports all 3 tiers)
// ---------------------------------------------------------------------------

const REQUEST_CREDENTIAL_NAME = "native__request_credential";

const pendingCredentialRequests = new Map<
  string,
  { resolve: (response: import("@chvor/shared").CredentialResponseData) => void }
>();

const requestCredentialToolDef = tool({
  description:
    "[Request Credential] Show a credential form to the user via an inline modal. " +
    "Use AFTER native__research_integration has identified what credentials are needed and the user has confirmed. " +
    "For Chvor registry tools, this will also install the tool if not already installed. " +
    "On non-web channels, directs user to the web dashboard.",
  parameters: z.object({
    credentialType: z.string().describe("The credential type slug (e.g., 'nocodb', 'anthropic')"),
    providerName: z.string().describe("Display name of the service (e.g., 'NocoDB', 'Anthropic')"),
    fields: z.array(z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(["password", "text"]).default("password"),
      placeholder: z.string().optional(),
      helpText: z.string().optional(),
      optional: z.boolean().optional(),
    })).describe("Credential fields to collect from user"),
    source: z.enum(["provider-registry", "chvor-registry", "ai-research"]).describe("Which tier resolved this integration"),
    registryEntryId: z.string().optional().describe("Chvor registry entry ID (for Tier 2 — will install tool)"),
    confidence: z.enum(["researched", "inferred"]).optional().describe("Confidence level (Tier 3 only)"),
    helpText: z.string().optional().describe("Setup guidance text"),
    existingCredentialId: z.string().optional().describe("If updating an existing credential"),
  }),
});

async function handleRequestCredential(
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> {
  const credentialType = String(args.credentialType);
  const providerName = String(args.providerName);
  const fields = args.fields as import("@chvor/shared").ProviderField[];
  const source = String(args.source) as "provider-registry" | "chvor-registry" | "ai-research";
  const registryEntryId = args.registryEntryId as string | undefined;
  const confidence = args.confidence as "researched" | "inferred" | undefined;
  const helpText = args.helpText as string | undefined;
  const existingCredentialId = args.existingCredentialId as string | undefined;

  // Non-web channels — direct to web dashboard
  if (context?.channelType && context.channelType !== "web") {
    return {
      content: [{ type: "text", text: `To add ${providerName} credentials, please use the web dashboard: Settings > Integrations.` }],
    };
  }

  // Install registry tool if needed (Tier 2)
  if (source === "chvor-registry" && registryEntryId) {
    try {
      const { readLock } = await import("./registry-manager.ts");
      const lock = readLock();
      if (!lock.installed[registryEntryId]) {
        const { installEntry } = await import("./registry-manager.ts");
        await installEntry(registryEntryId, "tool");
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to install registry tool "${registryEntryId}": ${err instanceof Error ? err.message : String(err)}. You can still add credentials manually in Settings.` }],
      };
    }
  }

  // Send credential.request to client
  const { getWSInstance } = await import("../gateway/ws-instance.ts");
  const ws = getWSInstance();
  if (!ws) {
    return { content: [{ type: "text", text: "WebSocket not available. Please add credentials in Settings > Integrations." }] };
  }

  const requestId = randomUUID();
  const requestEvent: GatewayServerEvent = {
    type: "credential.request",
    data: {
      requestId,
      providerName,
      providerIcon: "key",
      credentialType,
      fields: fields.length > 0 ? fields : [{ key: "apiKey", label: "API Key", type: "password" as const, placeholder: "sk-..." }],
      source,
      registryEntryId,
      confidence,
      helpText,
      allowFieldEditing: source === "ai-research",
      existingCredentialId,
      timestamp: new Date().toISOString(),
    },
  };

  if (context?.originClientId) {
    ws.sendTo(context.originClientId, requestEvent);
  } else {
    ws.broadcast(requestEvent);
  }

  // Wait for response — NO TIMEOUT (cleaned up on disconnect)
  const response = await new Promise<import("@chvor/shared").CredentialResponseData>((resolve) => {
    pendingCredentialRequests.set(requestId, { resolve });
  });

  if (response.cancelled || !response.data) {
    return { content: [{ type: "text", text: "Credential entry was cancelled by the user." }] };
  }

  // Save credential
  try {
    const { createCredential: createCred, updateCredential: updateCred } = await import("../db/credential-store.ts");
    const { invalidateToolCache } = await import("./tool-builder.ts");

    const name = response.name || `${providerName} API Key`;

    let savedId: string;
    if (existingCredentialId) {
      updateCred(existingCredentialId, { name, data: response.data });
      savedId = existingCredentialId;
    } else {
      const saved = createCred(name, credentialType, response.data);
      savedId = saved.id;
    }

    // Post-save actions
    try {
      const { tryRestartChannel } = await import("../routes/credentials.ts");
      tryRestartChannel(credentialType);
    } catch { /* ignore */ }
    try {
      const { mcpManager } = await import("./mcp-manager.ts");
      await mcpManager.closeConnectionsForCredential(credentialType);
    } catch { /* ignore */ }
    invalidateToolCache();
    clearModelCache();

    // Auto-test
    let testMsg = "";
    try {
      const { testProvider } = await import("../routes/provider-tester.ts");
      const result = await testProvider(credentialType, response.data);
      testMsg = result.success ? " Connection tested successfully." : ` Test: ${result.error}`;
      const { updateTestStatus } = await import("../db/credential-store.ts");
      updateTestStatus(savedId, result.success ? "success" : "failed");
    } catch { /* ignore */ }

    return {
      content: [{
        type: "text",
        text: `Credential "${name}" (${credentialType}) ${existingCredentialId ? "updated" : "saved"} successfully.${testMsg} Tools that require this credential are now available.`,
      }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to save credential: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}

/** Called when the client responds to a credential.request event. */
export function resolveCredentialRequest(
  requestId: string,
  response: import("@chvor/shared").CredentialResponseData,
): boolean {
  const pending = pendingCredentialRequests.get(requestId);
  if (!pending) return false;
  pendingCredentialRequests.delete(requestId);
  pending.resolve(response);
  return true;
}

handlers.set(REQUEST_CREDENTIAL_NAME, handleRequestCredential);
nativeToolMapping.set(REQUEST_CREDENTIAL_NAME, { kind: "tool", id: "credentials" });
```

- [ ] **Step 2: Update getNativeToolDefinitions to include new tool and remove old**

In the `getNativeToolDefinitions()` function (around line 4877), replace:
```typescript
[ADD_CREDENTIAL_NAME]: addCredentialToolDef,
[REQUEST_CREDENTIAL_NAME]: requestCredentialToolDef,
```

With:
```typescript
[RESEARCH_INTEGRATION_NAME]: researchIntegrationToolDef,
[REQUEST_CREDENTIAL_NAME]: requestCredentialToolDef,
```

- [ ] **Step 3: Remove the old native__add_credential tool**

Remove the `ADD_CREDENTIAL_NAME` constant, `addCredentialToolDef`, `handleAddCredential` function, and its `handlers.set()` / `nativeToolMapping.set()` calls (around lines 1450-1543).

- [ ] **Step 4: Add clearModelCache import**

Ensure `clearModelCache` is imported at the top of native-tools.ts (it's used in the new handleRequestCredential):

```typescript
import { clearModelCache } from "./model-fetcher.ts";
```

Check if this import already exists; add if not.

- [ ] **Step 5: Verify server compiles**

```bash
cd apps/server && pnpm tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/native-tools.ts
git commit -m "feat: rewrite credential native tools — add research_integration, rewrite request_credential

native__research_integration: three-tier lookup (provider registry → Chvor registry → AI research).
native__request_credential: rewritten with no timeout, supports all 3 tiers, auto-installs registry tools.
native__add_credential: removed (replaced by the new flow)."
```

---

## Task 6: Update WebSocket Handler (Remove Timeout)

**Files:**
- Modify: `apps/server/src/gateway/ws.ts`

- [ ] **Step 1: Update credential.respond handler**

In `apps/server/src/gateway/ws.ts` (around lines 183-192), the handler is already correct — it calls `resolveCredentialRequest()`. No changes needed to the handler itself.

However, verify the import of `resolveCredentialRequest` still works since we moved it in Task 5. Check:

```bash
grep -n "resolveCredentialRequest" apps/server/src/gateway/ws.ts
```

The import should point to `../lib/native-tools.ts`. If it's correct, no changes needed here.

- [ ] **Step 2: Verify no timeout references remain**

```bash
grep -rn "CREDENTIAL_REQUEST_TIMEOUT" apps/server/src/
```

Should return nothing. If any remain, remove them.

- [ ] **Step 3: Commit (only if changes were needed)**

```bash
git add apps/server/src/gateway/ws.ts
git commit -m "fix: clean up credential timeout references in WS handler"
```

---

## Task 7: Build Shared CredentialForm Component

**Files:**
- Create: `apps/client/src/components/credentials/CredentialForm.tsx`

- [ ] **Step 1: Create the shared CredentialForm component**

Create `apps/client/src/components/credentials/CredentialForm.tsx`:

```tsx
import { useState, useCallback } from "react";
import type { ProviderField } from "@chvor/shared";

export interface CredentialFormData {
  name: string;
  fields: Record<string, string>;
}

interface CredentialFormProps {
  providerName: string;
  credentialType: string;
  fields: ProviderField[];
  suggestedName?: string;
  source: "provider-registry" | "chvor-registry" | "ai-research";
  confidence?: "researched" | "inferred";
  helpText?: string;
  allowFieldEditing: boolean;
  existingCredentialId?: string;
  redactedValues?: Record<string, string>;
  onSubmit: (data: CredentialFormData) => void;
  onCancel: () => void;
}

export function CredentialForm({
  providerName,
  credentialType,
  fields: initialFields,
  suggestedName,
  source,
  confidence,
  helpText,
  allowFieldEditing,
  existingCredentialId,
  redactedValues,
  onSubmit,
  onCancel,
}: CredentialFormProps) {
  const [name, setName] = useState(suggestedName || `${providerName} API Key`);
  const [fields, setFields] = useState<ProviderField[]>(initialFields);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of initialFields) {
      init[f.key] = "";
    }
    return init;
  });
  const [showOptional, setShowOptional] = useState(false);
  const [newFieldKey, setNewFieldKey] = useState("");
  const [newFieldLabel, setNewFieldLabel] = useState("");
  const [newFieldSecret, setNewFieldSecret] = useState(true);

  const requiredFields = fields.filter((f) => !f.optional);
  const optionalFields = fields.filter((f) => f.optional);

  const isValid = requiredFields.every((f) => values[f.key]?.trim());

  const handleSubmit = useCallback(() => {
    if (!isValid && !existingCredentialId) return;
    // For updates, filter out empty values (keep current)
    const data = existingCredentialId
      ? Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()))
      : values;
    onSubmit({ name, fields: data });
  }, [name, values, isValid, existingCredentialId, onSubmit]);

  const addCustomField = useCallback(() => {
    if (!newFieldKey.trim() || !newFieldLabel.trim()) return;
    const key = newFieldKey.trim().replace(/[^a-zA-Z0-9_]/g, "");
    setFields((prev) => [...prev, {
      key,
      label: newFieldLabel.trim(),
      type: newFieldSecret ? "password" : "text",
      optional: true,
    }]);
    setValues((prev) => ({ ...prev, [key]: "" }));
    setNewFieldKey("");
    setNewFieldLabel("");
    setNewFieldSecret(true);
  }, [newFieldKey, newFieldLabel, newFieldSecret]);

  const removeField = useCallback((key: string) => {
    setFields((prev) => prev.filter((f) => f.key !== key));
    setValues((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const sourceBadge = {
    "provider-registry": { label: "Built-in", color: "bg-emerald-500/20 text-emerald-400" },
    "chvor-registry": { label: "From Registry", color: "bg-blue-500/20 text-blue-400" },
    "ai-research": confidence === "inferred"
      ? { label: "AI Inferred", color: "bg-amber-500/20 text-amber-400" }
      : { label: "Researched", color: "bg-sky-500/20 text-sky-400" },
  }[source];

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg font-medium text-white">{providerName}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full ${sourceBadge.color}`}>
            {sourceBadge.label}
          </span>
        </div>
        <button onClick={onCancel} className="text-white/40 hover:text-white/70 text-sm">
          Cancel
        </button>
      </div>

      {/* Help text */}
      {helpText && (
        <p className="text-sm text-white/50">{helpText}</p>
      )}

      {/* Credential name */}
      <div>
        <label className="block text-xs text-white/50 mb-1">Credential Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none"
          placeholder="My API Key"
        />
      </div>

      {/* Required fields */}
      {requiredFields.map((field) => (
        <div key={field.key}>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-white/50">{field.label}</label>
            {allowFieldEditing && (
              <button
                onClick={() => removeField(field.key)}
                className="text-xs text-red-400/60 hover:text-red-400"
              >
                Remove
              </button>
            )}
          </div>
          {field.helpText && <p className="text-xs text-white/30 mb-1">{field.helpText}</p>}
          {redactedValues?.[field.key] && (
            <p className="text-xs text-white/30 mb-1">Current: {redactedValues[field.key]}</p>
          )}
          <input
            type={field.type === "password" ? "password" : "text"}
            value={values[field.key] || ""}
            onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none"
            placeholder={field.placeholder || (existingCredentialId ? "Leave empty to keep current" : "")}
          />
          {field.helpUrl && (
            <a href={field.helpUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline mt-1 inline-block">
              How to get this →
            </a>
          )}
        </div>
      ))}

      {/* Optional fields */}
      {optionalFields.length > 0 && (
        <div>
          <button
            onClick={() => setShowOptional(!showOptional)}
            className="text-xs text-white/40 hover:text-white/60"
          >
            {showOptional ? "Hide" : "Show"} {optionalFields.length} optional field{optionalFields.length > 1 ? "s" : ""}
          </button>
          {showOptional && optionalFields.map((field) => (
            <div key={field.key} className="mt-2">
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-white/50">{field.label} (optional)</label>
                {allowFieldEditing && (
                  <button onClick={() => removeField(field.key)} className="text-xs text-red-400/60 hover:text-red-400">
                    Remove
                  </button>
                )}
              </div>
              {field.helpText && <p className="text-xs text-white/30 mb-1">{field.helpText}</p>}
              <input
                type={field.type === "password" ? "password" : "text"}
                value={values[field.key] || ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none"
                placeholder={field.placeholder || ""}
              />
            </div>
          ))}
        </div>
      )}

      {/* Add custom field (only for AI research / editable forms) */}
      {allowFieldEditing && (
        <div className="border-t border-white/10 pt-3">
          <p className="text-xs text-white/40 mb-2">Add custom field</p>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <input
                type="text"
                value={newFieldKey}
                onChange={(e) => setNewFieldKey(e.target.value)}
                placeholder="key"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white placeholder-white/30 focus:border-white/30 focus:outline-none"
              />
            </div>
            <div className="flex-1">
              <input
                type="text"
                value={newFieldLabel}
                onChange={(e) => setNewFieldLabel(e.target.value)}
                placeholder="Label"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white placeholder-white/30 focus:border-white/30 focus:outline-none"
              />
            </div>
            <label className="flex items-center gap-1 text-xs text-white/40">
              <input
                type="checkbox"
                checked={newFieldSecret}
                onChange={(e) => setNewFieldSecret(e.target.checked)}
                className="rounded"
              />
              Secret
            </label>
            <button
              onClick={addCustomField}
              disabled={!newFieldKey.trim() || !newFieldLabel.trim()}
              className="px-2 py-1.5 text-xs rounded-lg bg-white/10 text-white/70 hover:bg-white/20 disabled:opacity-30"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* Submit */}
      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg border border-white/10 text-white/60 hover:text-white/80 hover:border-white/20"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!isValid && !existingCredentialId}
          className="px-4 py-2 text-sm rounded-lg bg-white/15 text-white hover:bg-white/25 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {existingCredentialId ? "Update credential" : "Save credential"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps/client && pnpm tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add apps/client/src/components/credentials/CredentialForm.tsx
git commit -m "feat: add shared CredentialForm component

Used by both chat inline modal and Settings page. Supports all three tiers
with source badges, editable fields for AI-researched integrations,
optional field collapsing, and credential updates."
```

---

## Task 8: Wire CredentialForm into ChatPanel

**Files:**
- Modify: `apps/client/src/components/chat/ChatPanel.tsx`
- Modify: `apps/client/src/stores/app-store.ts`

- [ ] **Step 1: Update app-store to handle new CredentialRequestData shape**

In `apps/client/src/stores/app-store.ts`, the `credential.request` handler (around line 516) should already work since `CredentialRequestData` was updated in-place. Verify the `respondToCredentialRequest` function:

```bash
grep -A5 "respondToCredentialRequest" apps/client/src/stores/app-store.ts
```

It should remove the request from `pendingCredentialRequests`. If it references any old fields (like `suggestion`), update accordingly.

- [ ] **Step 2: Add CredentialForm to ChatPanel**

In `apps/client/src/components/chat/ChatPanel.tsx`, add the import and render `CredentialForm` for each pending request. Replace the section where `<CredentialRequest>` was previously rendered (removed in Task 1):

```tsx
import { CredentialForm } from "../credentials/CredentialForm.tsx";
```

In the JSX, where pending credential requests are rendered, add:

```tsx
{pendingCredentialRequests.map((request) => (
  <CredentialForm
    key={request.requestId}
    providerName={request.providerName}
    credentialType={request.credentialType}
    fields={request.fields}
    suggestedName={`${request.providerName} API Key`}
    source={request.source}
    confidence={request.confidence}
    helpText={request.helpText}
    allowFieldEditing={request.allowFieldEditing}
    existingCredentialId={request.existingCredentialId}
    onSubmit={(data) => {
      send({
        type: "credential.respond",
        data: {
          requestId: request.requestId,
          cancelled: false,
          data: data.fields,
          name: data.name,
        },
      });
      respondToCredentialRequest(request.requestId);
    }}
    onCancel={() => {
      send({
        type: "credential.respond",
        data: { requestId: request.requestId, cancelled: true },
      });
      respondToCredentialRequest(request.requestId);
    }}
  />
))}
```

- [ ] **Step 3: Verify client compiles**

```bash
cd apps/client && pnpm tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add apps/client/src/components/chat/ChatPanel.tsx apps/client/src/stores/app-store.ts
git commit -m "feat: wire CredentialForm into ChatPanel for inline credential collection

Replaces the old CredentialRequest component with the shared CredentialForm.
Supports all three resolution tiers with appropriate UI."
```

---

## Task 9: Update Settings Page — Registry Integration Browsing

**Files:**
- Modify: `apps/client/src/components/panels/SettingsPanel.tsx`
- Modify: `apps/client/src/components/credentials/AddCredentialDialog.tsx`

- [ ] **Step 1: Update AddCredentialDialog to use CredentialForm for custom integrations**

Read the current `AddCredentialDialog.tsx` to understand its structure:

```bash
head -50 apps/client/src/components/credentials/AddCredentialDialog.tsx
```

Add a "Custom Integration" option to the provider selection grid. When selected, it shows a blank CredentialForm with `allowFieldEditing: true` where the user defines their own fields.

The exact code depends on the current dialog structure — adapt to match existing patterns. Key change: add a "Custom" card at the end of the provider grid that opens CredentialForm with:

```tsx
<CredentialForm
  providerName="Custom Integration"
  credentialType=""
  fields={[{ key: "apiKey", label: "API Key", type: "password" }]}
  suggestedName=""
  source="ai-research"
  allowFieldEditing={true}
  onSubmit={handleCustomSave}
  onCancel={onClose}
/>
```

- [ ] **Step 2: Add "Available from Registry" section to SettingsPanel**

In the Connections/Credentials section of `SettingsPanel.tsx` (`CredentialsContent` component), add a section below the existing credential list that shows registry tools with credential requirements.

This should reuse the existing `useRegistryStore` to search for tools:

```tsx
import { useRegistryStore } from "../../stores/registry-store.ts";

// Inside CredentialsContent component:
const { entries, search, loading: registryLoading } = useRegistryStore();
const toolsWithCreds = entries.filter((e) => e.kind === "tool" && e.credentials);
```

Add a search bar and grid of available integrations from the registry. When a user clicks one, it triggers installation + credential collection using the same flow.

The exact implementation depends on the current SettingsPanel structure. Key principle: reuse existing `RegistryBrowserPanel` patterns filtered to tools with `credentials` blocks.

- [ ] **Step 3: Add "Research" button for unknown integrations**

Below the registry search results, add a fallback:

```tsx
{searchQuery && toolsWithCreds.length === 0 && (
  <div className="text-center py-4">
    <p className="text-sm text-white/40 mb-2">Not found in registry</p>
    <button
      onClick={() => handleResearch(searchQuery)}
      className="px-4 py-2 text-sm rounded-lg bg-white/10 text-white/70 hover:bg-white/20"
    >
      Research "{searchQuery}" with AI
    </button>
  </div>
)}
```

The `handleResearch` function calls `GET /api/integrations/research?q=...` and opens a CredentialForm with the results.

- [ ] **Step 4: Verify client compiles and Settings page works**

```bash
cd apps/client && pnpm tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/components/panels/SettingsPanel.tsx apps/client/src/components/credentials/AddCredentialDialog.tsx
git commit -m "feat: add registry browsing and custom integration to Settings

Settings > Integrations now shows: installed credentials, available registry tools,
and a custom integration option. AI research fallback for unknown services."
```

---

## Task 10: End-to-End Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all server tests**

```bash
pnpm --filter @chvor/server test
```

Expected: All tests pass, including new integration-resolver and integration-research tests.

- [ ] **Step 2: Run all client tests**

```bash
pnpm --filter @chvor/client test
```

Expected: All tests pass.

- [ ] **Step 3: Run full TypeScript type check**

```bash
cd packages/shared && pnpm tsc --noEmit && cd ../../apps/server && pnpm tsc --noEmit && cd ../client && pnpm tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 4: Manual test — Chat flow (Tier 1)**

1. Start the app
2. In chat, say "I want to add my Anthropic API key"
3. AI should call `native__research_integration` → find in provider registry
4. AI confirms with user → calls `native__request_credential`
5. Inline CredentialForm appears with "Built-in" badge
6. Fill in API key → save → verify credential appears in Settings

- [ ] **Step 5: Manual test — Settings flow**

1. Open Settings → Integrations
2. Click "+ Add" → verify provider grid shows known providers
3. Select a provider → verify CredentialForm renders correctly
4. Browse "Available from Registry" section → verify registry tools listed
5. Click "Custom Integration" → verify editable form appears

- [ ] **Step 6: Verify old flaky code is gone**

```bash
# These should all return "not found" / no results
ls apps/server/src/lib/credential-type-resolver.ts 2>&1
ls apps/server/src/lib/command-handlers.ts 2>&1
ls apps/server/src/lib/connection-config-resolver.ts 2>&1
ls apps/client/src/components/chat/CredentialRequest.tsx 2>&1
grep -rn "addkey" apps/server/src/lib/ 2>&1
grep -rn "native__add_credential" apps/server/src/lib/native-tools.ts 2>&1
```

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: credential management overhaul complete

Three-tier credential resolution (provider registry → Chvor registry → AI research).
Shared CredentialForm component for chat and settings.
Removed: credential-type-resolver, command-handlers, connection-config-resolver, old CredentialRequest."
```
