import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";

// Token-bucket rate limiter, in-memory. Self-host scope: one process, one bucket
// store. If we ever shard, swap this for Redis — the API stays the same.
//
// Defaults match Track A.3 of the elevation plan:
//   - 60 req/min for mutating verbs (POST/PUT/PATCH/DELETE)
//   - 300 req/min for safe verbs (GET/HEAD/OPTIONS)
//
// Bucket key is the most-specific identity available, in this order:
//   1. session id (browser UI)
//   2. api key id (programmatic)
//   3. client IP (last resort — also used for unauthenticated routes)

const READ_LIMIT = Number(process.env.RATE_LIMIT_READ_PER_MIN ?? 300);
const WRITE_LIMIT = Number(process.env.RATE_LIMIT_WRITE_PER_MIN ?? 60);
const WINDOW_MS = 60_000;
const PRUNE_INTERVAL_MS = 5 * 60_000;
const MAX_BUCKETS = 10_000; // hard cap so a hostile attacker can't OOM the process

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

// Periodic prune — drops buckets whose window expired more than 1 window ago.
let pruneTimer: NodeJS.Timeout | null = null;
function startPruneLoop(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS * 2;
    for (const [key, b] of buckets.entries()) {
      if (b.windowStart < cutoff) buckets.delete(key);
    }
  }, PRUNE_INTERVAL_MS);
  // Don't keep the event loop alive just for prune.
  if (pruneTimer.unref) pruneTimer.unref();
}

export function stopRateLimitPrune(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

export function _resetRateLimitForTests(): void {
  buckets.clear();
  stopRateLimitPrune();
}

function clientKey(c: Context): string {
  // Prefer authenticated identity (set by chvorAuth) so multiple users behind
  // a NAT don't share a bucket.
  const sessionId = c.get("sessionId" as never) as string | undefined;
  if (sessionId) return `s:${sessionId}`;
  const apiKeyId = c.get("apiKeyId" as never) as string | undefined;
  if (apiKeyId) return `k:${apiKeyId}`;
  // Cookie value as fallback (auth disabled mode still has a session cookie).
  const cookie = getCookie(c, "chvor_session");
  if (cookie) return `c:${cookie.slice(0, 32)}`;
  // IP as last resort — Hono node-server doesn't expose it directly; pull from
  // x-forwarded-for or cf-connecting-ip when present.
  //
  // NOTE: these headers are trivially spoofable by any client. Chvor is a
  // localhost-only single-user desktop app, so the "IP" bucket is really a
  // coarse fallback for unauthenticated local traffic — it has no security
  // role. If Chvor is ever fronted by a reverse proxy / exposed publicly,
  // the operator must terminate these headers at the proxy and gate this
  // branch behind a TRUST_PROXY env var before trusting them.
  const xff = c.req.header("x-forwarded-for");
  if (xff) return `ip:${xff.split(",")[0]?.trim() ?? "unknown"}`;
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return `ip:${cf}`;
  return "ip:unknown";
}

function isWriteMethod(method: string): boolean {
  switch (method.toUpperCase()) {
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
      return true;
    default:
      return false;
  }
}

function take(key: string, limit: number): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    // Hard cap before adding a new bucket. Eviction is by oldest windowStart.
    if (buckets.size >= MAX_BUCKETS) {
      let oldestKey: string | null = null;
      let oldestStart = Infinity;
      for (const [k, v] of buckets.entries()) {
        if (v.windowStart < oldestStart) {
          oldestStart = v.windowStart;
          oldestKey = k;
        }
      }
      if (oldestKey) buckets.delete(oldestKey);
    }
    b = { count: 0, windowStart: now };
    buckets.set(key, b);
  }
  b.count += 1;
  const remaining = Math.max(0, limit - b.count);
  if (b.count > limit) {
    const retryAfterMs = WINDOW_MS - (now - b.windowStart);
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  return { allowed: true, remaining, retryAfterSec: 0 };
}

// Routes that legitimately get hit at very high frequency (auth probes, health
// checks). Skip rate limiting for these so a normal page load isn't penalized.
function shouldSkip(path: string): boolean {
  return (
    path === "/api/health" ||
    path === "/api/auth/status" ||
    path === "/api/sessions/current" ||
    // Webhook receivers verify HMAC signatures on their own; rate-limiting them
    // here would block legitimate upstream bursts.
    /^\/api\/webhooks\/[^/]+\/receive$/.test(path) ||
    // Media is served from disk + cached by the browser.
    path.startsWith("/api/media/")
  );
}

export const rateLimit = createMiddleware(async (c, next) => {
  startPruneLoop();
  const path = new URL(c.req.url).pathname;
  if (shouldSkip(path)) return next();

  const key = clientKey(c);
  const isWrite = isWriteMethod(c.req.method);
  const limit = isWrite ? WRITE_LIMIT : READ_LIMIT;
  const result = take(`${isWrite ? "w" : "r"}:${key}`, limit);

  c.header("X-RateLimit-Limit", String(limit));
  c.header("X-RateLimit-Remaining", String(result.remaining));

  if (!result.allowed) {
    c.header("Retry-After", String(result.retryAfterSec));
    return c.json(
      {
        error: {
          code: "rate_limit.exceeded",
          message: `Rate limit exceeded — ${limit} ${isWrite ? "writes" : "reads"} per minute`,
          category: "system_error",
          retryAfterSec: result.retryAfterSec,
        },
      },
      429,
    );
  }

  await next();
});
