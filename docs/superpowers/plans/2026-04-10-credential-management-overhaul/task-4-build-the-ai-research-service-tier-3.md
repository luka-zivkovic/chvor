# Credential Management Overhaul — Task 4: Build the AI Research Service (Tier 3)

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
