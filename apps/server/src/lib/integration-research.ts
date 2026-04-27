import { generateText } from "ai";
import type { ProviderProposal, ProviderField } from "@chvor/shared";
import { resolveRoleConfig, createModel } from "./llm-router.ts";
import { discoverOpenApi } from "./spec-fetcher.ts";

// ── Slug normalization ──────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Web search (DuckDuckGo HTML scraping with resilient selectors) ─

/**
 * DDG keeps changing markup; we try multiple selectors before giving up.
 * Returns up to 5 snippet strings or null on hard failure.
 */
async function webSearch(query: string): Promise<string[] | null> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Chvor/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const snippets: string[] = [];

    // Selector chain — DDG renames classes periodically. Each regex is tried
    // until we find something. Stopping after 5 hits keeps the LLM prompt small.
    const selectorChain: RegExp[] = [
      /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi,
      /<div class="result__snippet"[^>]*>([\s\S]*?)<\/div>/gi,
      /<span class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
      /<a [^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
    ];

    for (const re of selectorChain) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(html)) !== null && snippets.length < 5) {
        const text = match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (text.length > 20) snippets.push(text);
      }
      if (snippets.length >= 3) break;
    }

    return snippets.length > 0 ? snippets : null;
  } catch (err) {
    console.warn("[integration-research] webSearch failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── GitHub repo search for OpenAPI specs ────────────────────────
//
// Public, unauthenticated GitHub search is rate-limited (10 req/min) and may
// fail entirely; we treat it as best-effort. Returns the URL of a likely
// OpenAPI spec inside a matched repo (raw.githubusercontent.com), which the
// caller can feed to discoverOpenApi.
async function searchGitHubForOpenApiUrl(serviceName: string): Promise<string | null> {
  try {
    const q = encodeURIComponent(`${serviceName} openapi`);
    const url = `https://api.github.com/search/repositories?q=${q}+in:name,description&sort=stars&per_page=5`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Chvor-IntegrationResearch/1.0",
        "Accept": "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { items?: Array<{ full_name?: string; default_branch?: string }> };
    const items = json.items ?? [];
    for (const item of items) {
      if (!item.full_name) continue;
      const branch = item.default_branch || "main";
      // Probe a small set of canonical spec paths in the repo. Each probe
      // goes through assertSafeSynthesizedUrl in discoverOpenApi.
      for (const path of ["openapi.json", "openapi.yaml", "spec/openapi.json", "spec/openapi.yaml", "docs/openapi.json"]) {
        const rawUrl = `https://raw.githubusercontent.com/${item.full_name}/${branch}/${path}`;
        // Cheap HEAD probe to avoid downloading 404 bodies.
        try {
          const head = await fetch(rawUrl, {
            method: "HEAD",
            signal: AbortSignal.timeout(3000),
          });
          if (head.ok) return rawUrl;
        } catch { /* try next */ }
      }
    }
    return null;
  } catch (err) {
    console.warn("[integration-research] github search failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Run multiple search-query variants in sequence until one yields snippets.
 * Each variant emphasizes a different angle (auth docs, dev portal, API key).
 */
async function multiQuerySearch(serviceName: string): Promise<string[] | null> {
  const variants = [
    `${serviceName} API authentication documentation`,
    `${serviceName} developer API key getting started`,
    `${serviceName} REST API OAuth setup`,
  ];
  for (const q of variants) {
    const snippets = await webSearch(q);
    if (snippets && snippets.length > 0) return snippets;
  }
  return null;
}

// ── LLM extraction from snippets ────────────────────────────────

async function extractWithLLM(
  serviceName: string,
  snippets: string[]
): Promise<ProviderProposal | null> {
  try {
    const config = resolveRoleConfig("lightweight");
    const model = createModel(config);

    const { text } = await generateText({
      model,
      maxTokens: 500,
      abortSignal: AbortSignal.timeout(30_000),
      system:
        "You extract API credential information. Respond ONLY with valid JSON, no markdown.",
      prompt: `Given these web search snippets about "${serviceName}" API authentication:\n\n${snippets.join("\n\n")}\n\nExtract the following as JSON:\n{\n  "name": "human-readable service name",\n  "credentialType": "slug-style-type",\n  "fields": [{ "key": "fieldName", "label": "Field Label", "type": "password" | "text", "placeholder": "optional" }],\n  "baseUrl": "API base URL if known",\n  "authScheme": "bearer | basic | header | query-param | oauth2",\n  "helpText": "Brief setup instructions (include developer-portal URL when authScheme=oauth2)",\n  "specUrl": "URL to an OpenAPI/Swagger spec if the service publishes one (e.g. https://api.example.com/openapi.json), otherwise omit",\n  "probePath": "Optional GET path on baseUrl that returns 2xx with valid auth (e.g. /v1/me, /account). Omit if unknown.",\n  "authUrl": "OAuth2 authorization endpoint (only when authScheme=oauth2)",\n  "tokenUrl": "OAuth2 token-exchange endpoint (only when authScheme=oauth2)",\n  "scopes": ["array", "of", "default", "OAuth2", "scopes"]\n}`,
    });

    const parsed = JSON.parse(text);
    return {
      name: parsed.name || serviceName,
      credentialType: parsed.credentialType || toSlug(serviceName),
      fields: Array.isArray(parsed.fields) ? parsed.fields : [],
      baseUrl: parsed.baseUrl || undefined,
      authScheme: parsed.authScheme || undefined,
      helpText: parsed.helpText || undefined,
      specUrl: typeof parsed.specUrl === "string" && parsed.specUrl.startsWith("http") ? parsed.specUrl : undefined,
      probePath: typeof parsed.probePath === "string" && parsed.probePath.startsWith("/") ? parsed.probePath : undefined,
      authUrl: typeof parsed.authUrl === "string" && parsed.authUrl.startsWith("https://") ? parsed.authUrl : undefined,
      tokenUrl: typeof parsed.tokenUrl === "string" && parsed.tokenUrl.startsWith("https://") ? parsed.tokenUrl : undefined,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.map((s: unknown) => String(s)).filter(Boolean) : undefined,
      confidence: "researched",
    };
  } catch (err) {
    console.warn(`[integration-research] extractWithLLM failed for "${serviceName}":`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Pure LLM inference (no search snippets) ─────────────────────

async function inferWithLLM(
  serviceName: string
): Promise<ProviderProposal | null> {
  try {
    const config = resolveRoleConfig("lightweight");
    const model = createModel(config);

    const { text } = await generateText({
      model,
      maxTokens: 500,
      abortSignal: AbortSignal.timeout(30_000),
      system:
        "You extract API credential information. Respond ONLY with valid JSON, no markdown.",
      prompt: `What credentials are needed to authenticate with the "${serviceName}" API?\n\nRespond as JSON:\n{\n  "name": "human-readable service name",\n  "credentialType": "slug-style-type",\n  "fields": [{ "key": "fieldName", "label": "Field Label", "type": "password" | "text", "placeholder": "optional" }],\n  "baseUrl": "API base URL if known",\n  "authScheme": "bearer | basic | header | query-param | oauth2",\n  "helpText": "Brief setup instructions (include developer-portal URL when authScheme=oauth2)",\n  "specUrl": "URL to an OpenAPI/Swagger spec if the service publishes one, otherwise omit",\n  "probePath": "Optional GET path on baseUrl that returns 2xx with valid auth (e.g. /v1/me, /account). Omit if unknown.",\n  "authUrl": "OAuth2 authorization endpoint (only when authScheme=oauth2)",\n  "tokenUrl": "OAuth2 token-exchange endpoint (only when authScheme=oauth2)",\n  "scopes": ["array", "of", "default", "OAuth2", "scopes"]\n}`,
    });

    const parsed = JSON.parse(text);
    return {
      name: parsed.name || serviceName,
      credentialType: parsed.credentialType || toSlug(serviceName),
      fields: Array.isArray(parsed.fields) ? parsed.fields : [],
      baseUrl: parsed.baseUrl || undefined,
      authScheme: parsed.authScheme || undefined,
      helpText: parsed.helpText || undefined,
      specUrl: typeof parsed.specUrl === "string" && parsed.specUrl.startsWith("http") ? parsed.specUrl : undefined,
      probePath: typeof parsed.probePath === "string" && parsed.probePath.startsWith("/") ? parsed.probePath : undefined,
      authUrl: typeof parsed.authUrl === "string" && parsed.authUrl.startsWith("https://") ? parsed.authUrl : undefined,
      tokenUrl: typeof parsed.tokenUrl === "string" && parsed.tokenUrl.startsWith("https://") ? parsed.tokenUrl : undefined,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.map((s: unknown) => String(s)).filter(Boolean) : undefined,
      confidence: "inferred",
    };
  } catch (err) {
    console.warn(`[integration-research] inferWithLLM failed for "${serviceName}":`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Generic fallback ────────────────────────────────────────────

function genericFallback(serviceName: string): ProviderProposal {
  const slug = toSlug(serviceName);
  const displayName =
    serviceName.charAt(0).toUpperCase() + serviceName.slice(1);

  const fields: ProviderField[] = [
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      placeholder: `Your ${displayName} API key`,
    },
    {
      key: "baseUrl",
      label: "Base URL",
      type: "text",
      placeholder: `https://api.${slug}.com`,
    },
  ];

  return {
    name: displayName,
    credentialType: slug,
    fields,
    confidence: "fallback",
  };
}

/**
 * Probe an LLM-suggested spec URL. Returns true if the URL resolves to a
 * parseable OpenAPI document, otherwise false. We never trust an unverified
 * specUrl downstream — verification is a precondition for tool synthesis.
 */
async function verifySpecUrl(serviceName: string, specUrl: string): Promise<boolean> {
  try {
    const discovered = await discoverOpenApi({ serviceName, hintedSpecUrl: specUrl });
    return !!discovered && discovered.specUrl === specUrl && discovered.operations.length > 0;
  } catch {
    return false;
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Tier 3: AI-powered research for unknown integrations.
 *
 * Pipeline (each step is independently best-effort — failures fall through):
 * 1. Web search (multi-query DDG) → LLM extraction from snippets
 * 2. Pure LLM inference (training knowledge)
 * 3. Generic apiKey + baseUrl fallback
 *
 * After whichever step produces a proposal, we run two enrichment passes:
 *   - GitHub repo search for an OpenAPI spec URL (fills missing specUrl).
 *   - assert/verify the discovered spec URL through the safe-fetch gates.
 */
export async function researchIntegration(
  serviceName: string,
  opts: { hintedSpecUrl?: string } = {},
): Promise<ProviderProposal> {
  const slug = toSlug(serviceName);

  let proposal: ProviderProposal | null = null;

  // Step 1: Web search + LLM extraction (try multiple query variants)
  const snippets = await multiQuerySearch(serviceName);
  if (snippets) {
    const extracted = await extractWithLLM(serviceName, snippets);
    if (extracted) {
      extracted.credentialType = slug;
      proposal = extracted;
    }
  }

  // Step 2: Pure LLM inference if we still don't have a proposal
  if (!proposal) {
    const inferred = await inferWithLLM(serviceName);
    if (inferred) {
      inferred.credentialType = slug;
      proposal = inferred;
    }
  }

  // Step 3: Generic fallback
  if (!proposal) {
    proposal = genericFallback(serviceName);
  }

  // Spec URL precedence: user-supplied hint > LLM-discovered > GitHub fallback.
  // The hint always wins because it represents an explicit user override of
  // whatever the AI guessed (or didn't).
  if (opts.hintedSpecUrl && opts.hintedSpecUrl.startsWith("https://")) {
    proposal.specUrl = opts.hintedSpecUrl;
  } else if (!proposal.specUrl) {
    const githubSpecUrl = await searchGitHubForOpenApiUrl(serviceName);
    if (githubSpecUrl) {
      proposal.specUrl = githubSpecUrl;
    }
  }

  await annotateSpecVerification(proposal);
  return proposal;
}

/**
 * Mutates the proposal: probes any LLM-suggested specUrl through the safe-fetch
 * gates and sets `specVerified`. Drops the specUrl entirely if probing fails so
 * downstream code never trusts a hallucinated URL.
 */
async function annotateSpecVerification(proposal: ProviderProposal): Promise<void> {
  if (!proposal.specUrl) return;
  const ok = await verifySpecUrl(proposal.name, proposal.specUrl);
  if (ok) {
    proposal.specVerified = true;
  } else {
    console.warn(`[integration-research] specUrl ${proposal.specUrl} for ${proposal.name} failed verification — dropping`);
    delete proposal.specUrl;
    proposal.specVerified = false;
  }
}
