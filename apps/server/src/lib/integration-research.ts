import { generateText } from "ai";
import type { ProviderProposal, ProviderField } from "@chvor/shared";
import { resolveRoleConfig, createModel } from "./llm-router.ts";

// ── Slug normalization ──────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Web search (DuckDuckGo HTML scraping) ───────────────────────

async function webSearch(query: string): Promise<string[] | null> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Chvor/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Extract result snippets from DuckDuckGo HTML results
    const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippets: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = snippetRegex.exec(html)) !== null && snippets.length < 5) {
      // Strip HTML tags from snippet
      const text = match[1].replace(/<[^>]+>/g, "").trim();
      if (text.length > 20) snippets.push(text);
    }

    return snippets.length > 0 ? snippets : null;
  } catch (err) {
    console.warn("[integration-research] webSearch failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
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
      prompt: `Given these web search snippets about "${serviceName}" API authentication:\n\n${snippets.join("\n\n")}\n\nExtract the following as JSON:\n{\n  "name": "human-readable service name",\n  "credentialType": "slug-style-type",\n  "fields": [{ "key": "fieldName", "label": "Field Label", "type": "password" | "text", "placeholder": "optional" }],\n  "baseUrl": "API base URL if known",\n  "authScheme": "bearer | basic | header | query-param",\n  "helpText": "Brief setup instructions"\n}`,
    });

    const parsed = JSON.parse(text);
    return {
      name: parsed.name || serviceName,
      credentialType: parsed.credentialType || toSlug(serviceName),
      fields: Array.isArray(parsed.fields) ? parsed.fields : [],
      baseUrl: parsed.baseUrl || undefined,
      authScheme: parsed.authScheme || undefined,
      helpText: parsed.helpText || undefined,
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
      prompt: `What credentials are needed to authenticate with the "${serviceName}" API?\n\nRespond as JSON:\n{\n  "name": "human-readable service name",\n  "credentialType": "slug-style-type",\n  "fields": [{ "key": "fieldName", "label": "Field Label", "type": "password" | "text", "placeholder": "optional" }],\n  "baseUrl": "API base URL if known",\n  "authScheme": "bearer | basic | header | query-param",\n  "helpText": "Brief setup instructions"\n}`,
    });

    const parsed = JSON.parse(text);
    return {
      name: parsed.name || serviceName,
      credentialType: parsed.credentialType || toSlug(serviceName),
      fields: Array.isArray(parsed.fields) ? parsed.fields : [],
      baseUrl: parsed.baseUrl || undefined,
      authScheme: parsed.authScheme || undefined,
      helpText: parsed.helpText || undefined,
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
    confidence: "inferred",
  };
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Tier 3: AI-powered research for unknown integrations.
 *
 * Pipeline:
 * 1. Web search → LLM extraction from snippets
 * 2. Pure LLM inference (training knowledge)
 * 3. Generic apiKey + baseUrl fallback
 */
export async function researchIntegration(
  serviceName: string
): Promise<ProviderProposal> {
  const slug = toSlug(serviceName);

  // Step 1: Web search + LLM extraction
  const snippets = await webSearch(
    `${serviceName} API authentication documentation`
  );
  if (snippets) {
    const extracted = await extractWithLLM(serviceName, snippets);
    if (extracted) {
      extracted.credentialType = slug;
      return extracted;
    }
  }

  // Step 2: Pure LLM inference
  const inferred = await inferWithLLM(serviceName);
  if (inferred) {
    inferred.credentialType = slug;
    return inferred;
  }

  // Step 3: Generic fallback
  return genericFallback(serviceName);
}
