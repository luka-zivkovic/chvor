import { Hono } from "hono";
import { resolveIntegration } from "../lib/integration-resolver.ts";
import { researchIntegration } from "../lib/integration-research.ts";
import type {
  IntegrationCatalogEntry,
  IntegrationCatalogResponse,
  IntegrationResolution,
} from "@chvor/shared";
import {
  LLM_PROVIDERS,
  EMBEDDING_PROVIDERS,
  INTEGRATION_PROVIDERS,
  IMAGE_GEN_PROVIDERS,
  OAUTH_PROVIDERS,
} from "../lib/provider-registry.ts";
import { listCredentials } from "../db/credential-store.ts";
import { fetchRegistryIndex, readCachedIndex } from "../lib/registry-client.ts";
import { readLock } from "../lib/registry-manager.ts";

const integrations = new Hono();

// ── Simple rate limiter (5 req/min per IP) ──────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

// ── Research result cache (TTL 5 min) ───────────────────────────
const researchCache = new Map<string, { result: IntegrationResolution; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60_000;

// GET /research?q=<service_name>&specUrl=<optional override>
integrations.get("/research", async (c) => {
  try {
    const query = c.req.query("q")?.trim();
    if (!query || query.length < 2) {
      return c.json({ error: "Query parameter 'q' is required (min 2 chars)" }, 400);
    }

    // Optional user-supplied OpenAPI spec URL — bypasses scraping/inference for
    // the spec-discovery step. Must be HTTPS; further safety checks happen
    // inside discoverOpenApi via assertSafeSynthesizedUrl.
    const rawHint = c.req.query("specUrl")?.trim();
    const hintedSpecUrl =
      rawHint && rawHint.startsWith("https://") ? rawHint : undefined;

    // Rate limit check
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    if (isRateLimited(ip)) {
      return c.json({ error: "Too many requests. Try again in a minute." }, 429);
    }

    // Tier 1+2: check provider registry and chvor registry
    // Skip these when the user supplied a spec URL — that's a strong signal
    // they want fresh tier-3 research with their override, not a cached match.
    if (!hintedSpecUrl) {
      const resolution = await resolveIntegration(query);
      if (resolution) {
        return c.json(resolution);
      }
    }

    // Check cache for AI research results — keyed by query+hint so the same
    // service can have separate cache entries for hinted vs. auto-discovered.
    const cacheKey = `${query.toLowerCase()}::${hintedSpecUrl ?? ""}`;
    const cached = researchCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return c.json(cached.result);
    }

    // Tier 3: AI research
    const proposal = await researchIntegration(query, { hintedSpecUrl });
    const result: IntegrationResolution = {
      source: "ai-research",
      name: proposal.name,
      credentialType: proposal.credentialType,
      fields: proposal.fields,
      proposal,
    };

    // Cache the result
    researchCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });

    return c.json(result);
  } catch (err) {
    console.error("[integrations] research failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Research failed" },
      500
    );
  }
});

// ── Catalog endpoint ───────────────────────────────────────────
//
// Returns a flat, browseable list of every service Chvor knows how to talk
// to: built-in providers (LLM/embedding/integration/image-gen), OAuth-direct
// providers, and Chvor-registry entries that ship a credential schema.
// The client uses this to render the "What can I integrate?" panel; the
// `installed` flag drives a green check next to services the user already has
// a credential for.

interface CatalogRegistryEntry {
  id: string;
  kind: string;
  name: string;
  description: string;
  tags?: string[];
  credentials?: { type: string };
  requires?: { credentials?: string[] };
}

async function loadRegistryEntries(): Promise<CatalogRegistryEntry[]> {
  try {
    const idx = await fetchRegistryIndex();
    return idx.entries as CatalogRegistryEntry[];
  } catch {
    const cached = readCachedIndex();
    return (cached?.entries ?? []) as CatalogRegistryEntry[];
  }
}

integrations.get("/catalog", async (c) => {
  try {
    const installedTypes = new Set(
      listCredentials().map((cr) => cr.type),
    );

    const entries: IntegrationCatalogEntry[] = [];

    for (const p of LLM_PROVIDERS) {
      entries.push({
        id: `llm:${p.id}`,
        source: "provider-registry",
        name: p.name,
        description: `${p.name} language models`,
        icon: p.icon,
        category: "llm",
        credentialType: p.credentialType,
        installed: installedTypes.has(p.credentialType),
      });
    }
    for (const p of EMBEDDING_PROVIDERS) {
      if (!p.credentialType) continue;
      entries.push({
        id: `embed:${p.id}`,
        source: "provider-registry",
        name: p.name,
        description: `${p.name} embeddings`,
        icon: p.icon,
        category: "embedding",
        credentialType: p.credentialType,
        installed: installedTypes.has(p.credentialType),
      });
    }
    for (const p of INTEGRATION_PROVIDERS) {
      entries.push({
        id: `integration:${p.id}`,
        source: "provider-registry",
        name: p.name,
        description: p.description,
        icon: p.icon,
        category: "integration",
        credentialType: p.credentialType,
        installed: installedTypes.has(p.credentialType),
      });
    }
    for (const p of IMAGE_GEN_PROVIDERS) {
      entries.push({
        id: `image:${p.id}`,
        source: "provider-registry",
        name: p.name,
        description: `${p.name} image generation`,
        category: "image-gen",
        credentialType: p.credentialType,
        installed: installedTypes.has(p.credentialType),
      });
    }
    for (const p of OAUTH_PROVIDERS) {
      entries.push({
        id: `oauth:${p.id}`,
        source: "provider-registry",
        name: p.name,
        description: p.description ?? `${p.name} (OAuth)`,
        icon: p.icon,
        category: "oauth",
        credentialType: `oauth-token-${p.id}`,
        installed: installedTypes.has(`oauth-token-${p.id}`),
        oauth: true,
      });
    }

    const lock = readLock();
    const installedRegistry = new Set(Object.keys(lock.installed));
    const seenIds = new Set(entries.map((e) => e.id));

    const registry = await loadRegistryEntries();
    for (const r of registry) {
      const credType =
        r.credentials?.type ?? r.requires?.credentials?.[0];
      if (!credType) continue;
      const id = `registry:${r.id}`;
      if (seenIds.has(id)) continue;
      entries.push({
        id,
        source: "chvor-registry",
        name: r.name,
        description: r.description,
        category: "registry",
        credentialType: credType,
        installed: installedRegistry.has(r.id) || installedTypes.has(credType),
        tags: r.tags,
      });
    }

    const response: IntegrationCatalogResponse = {
      entries,
      total: entries.length,
    };
    return c.json(response);
  } catch (err) {
    console.error("[integrations] catalog failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Catalog failed" },
      500,
    );
  }
});

/** Reset rate limiter and cache — for testing only. */
export function _resetForTests(): void {
  rateLimitMap.clear();
  researchCache.clear();
}

export default integrations;
