import { Hono } from "hono";
import { resolveIntegration } from "../lib/integration-resolver.ts";
import { researchIntegration } from "../lib/integration-research.ts";
import type { IntegrationResolution } from "@chvor/shared";

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

// GET /research?q=<service_name>
integrations.get("/research", async (c) => {
  try {
    const query = c.req.query("q")?.trim();
    if (!query || query.length < 2) {
      return c.json({ error: "Query parameter 'q' is required (min 2 chars)" }, 400);
    }

    // Rate limit check
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    if (isRateLimited(ip)) {
      return c.json({ error: "Too many requests. Try again in a minute." }, 429);
    }

    // Tier 1+2: check provider registry and chvor registry
    const resolution = await resolveIntegration(query);
    if (resolution) {
      return c.json(resolution);
    }

    // Check cache for AI research results
    const cacheKey = query.toLowerCase();
    const cached = researchCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return c.json(cached.result);
    }

    // Tier 3: AI research
    const proposal = await researchIntegration(query);
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

/** Reset rate limiter and cache — for testing only. */
export function _resetForTests(): void {
  rateLimitMap.clear();
  researchCache.clear();
}

export default integrations;
