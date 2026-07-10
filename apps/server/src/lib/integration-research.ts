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

// ── Auth-scheme normalization ───────────────────────────────────
//
// The LLM is prompted with a loose vocabulary ("bearer | basic | header |
// query-param | oauth2"). Clamp whatever it returns to the canonical set so a
// hallucinated scheme (e.g. "oauth1", "api_key") can't flow through to
// ConnectionConfig where unknown values silently default to bearer.

const KNOWN_AUTH_SCHEMES = new Set([
  "bearer",
  "basic",
  "api-key-header",
  "query-param",
  "custom",
  "oauth2",
]);

function normalizeAuthScheme(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.toLowerCase().trim();
  if (KNOWN_AUTH_SCHEMES.has(s)) return s;
  // Common synonyms the LLM tends to emit.
  if (s === "header" || s === "api-key" || s === "apikey" || s === "api_key") {
    return "api-key-header";
  }
  if (s === "token") return "bearer";
  if (s === "oauth" || s === "oauth2.0" || s === "oauth 2.0") return "oauth2";
  if (s === "query" || s === "query_param" || s === "queryparam") return "query-param";
  // Unknown — leave undefined so the form falls back to its own default
  // rather than trusting a guessed scheme. Log a breadcrumb (mirrors the
  // dropped-specUrl warning) so a legitimately-unusual scheme isn't silently
  // degraded to bearer with no trace.
  console.warn(
    `[integration-research] dropping unrecognized authScheme "${raw}" — downstream will default to bearer`
  );
  return undefined;
}

// ── Pure LLM inference (training knowledge) ─────────────────────

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
      authScheme: normalizeAuthScheme(parsed.authScheme),
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
 * 1. Pure LLM inference (training knowledge) → confidence "inferred"
 * 2. Generic apiKey + baseUrl fallback → confidence "fallback" (manual entry)
 *
 * Tiers 1+2 (provider registry, chvor registry) are handled upstream in
 * `integration-resolver.ts`; this is the last resort. A user-supplied spec
 * hint, or any specUrl the LLM produced, is verified through the safe-fetch
 * gates before it can be trusted downstream. The credential modal's pre-save
 * probe is the real safety net when the inferred auth scheme is wrong.
 *
 * Note: the previous DuckDuckGo HTML-scraping tier and unauthenticated GitHub
 * OpenAPI auto-discovery were removed — both were high-maintenance (selector
 * rot / rate limits) and rarely added value over LLM inference for a
 * single-user deployment.
 */
export async function researchIntegration(
  serviceName: string,
  opts: { hintedSpecUrl?: string } = {},
): Promise<ProviderProposal> {
  const slug = toSlug(serviceName);

  // Step 1: LLM inference from training knowledge.
  let proposal: ProviderProposal | null = await inferWithLLM(serviceName);
  if (proposal) {
    proposal.credentialType = slug;
  } else {
    // Step 2: Generic fallback (manual entry).
    proposal = genericFallback(serviceName);
  }

  // A user-supplied spec hint always wins — it is an explicit override of
  // whatever the AI guessed (or didn't).
  if (opts.hintedSpecUrl && opts.hintedSpecUrl.startsWith("https://")) {
    proposal.specUrl = opts.hintedSpecUrl;
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
