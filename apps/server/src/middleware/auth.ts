import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { isAuthEnabled } from "../db/auth-store.ts";
import { validateSession } from "../db/auth-store.ts";
import { validateApiKey } from "../db/api-key-store.ts";
import { appendAudit } from "../db/audit-log-store.ts";

export type AuthEnv = {
  Variables: {
    authType?: "session" | "apikey";
    sessionId?: string;
    apiKeyId?: string;
    apiKeyScopes?: string[];
  };
};

/**
 * Parse a scopes string like "*" or "tool:execute:*,credential:read" into a
 * sorted, de-duplicated array. `*` alone means full access.
 */
export function parseScopes(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Test whether a required scope matches any of the granted scopes.
 *
 * Supported wildcard forms in `granted`:
 *   - "*" or "**"            → full access
 *   - exact string match
 *   - trailing "*"           → prefix match, e.g. "tool:execute:native__web_*"
 *                              matches "tool:execute:native__web_search"
 *   - colon-segment "*"      → per-segment match, e.g. "tool:*:read" matches
 *                              "tool:foo:read" but not "tool:foo:bar:read"
 */
export function scopeMatches(granted: string[], required: string): boolean {
  if (granted.includes("*") || granted.includes("**")) return true;
  if (granted.includes(required)) return true;

  for (const g of granted) {
    if (!g.includes("*")) continue;

    // Trailing wildcard: anywhere `*` appears last.
    if (g.endsWith("*")) {
      const prefix = g.slice(0, -1);
      if (required.startsWith(prefix)) return true;
    }

    // Segment-level wildcards (at least one `*` not at the end).
    if (g.includes(":")) {
      const pattern = g.split(":");
      const parts = required.split(":");
      if (pattern.length === parts.length) {
        const ok = pattern.every((p, i) => p === "*" || p === parts[i]);
        if (ok) return true;
      }
    }
  }

  return false;
}

/**
 * Classify a request path + method into a required scope.
 * Returns null when the path is outside the scope system (use-all-or-nothing).
 */
export function requiredScopeFor(method: string, path: string): string | null {
  // Strip query + trailing slash for normalization
  const p = path.replace(/\?.*$/, "").replace(/\/$/, "");

  // Auth endpoints already whitelisted upstream — no scope required.
  if (p.startsWith("/api/auth")) return null;

  // /api/debug — destructive POSTs (e.g. /prune) need write scope, not read.
  if (p.startsWith("/api/debug")) {
    return method === "GET" || method === "HEAD" ? "debug:read" : "debug:write";
  }

  // /api/audit — running the security auditor has side effects (it writes an
  // audit-log row and reads credential metadata + key list), so POST gets its
  // own narrow scope distinct from the generic api:write default.
  if (p.startsWith("/api/audit")) {
    return method === "GET" || method === "HEAD" ? "audit:read" : "audit:run";
  }

  // Tool execution (orchestrator ingress)
  if (p.startsWith("/api/sessions") && method === "POST") return "tool:execute:*";
  if (p.startsWith("/api/gateway") && method === "POST") return "tool:execute:*";

  // Credential read/write
  if (p.startsWith("/api/credentials")) {
    if (method === "GET") return "credential:read";
    return "credential:write";
  }

  // Skills / tools listing (safe reads)
  if (p.startsWith("/api/skills") && method === "GET") return "skill:read";
  if (p.startsWith("/api/skills")) return "skill:write";
  if (p.startsWith("/api/tools") && method === "GET") return "tool:read";
  if (p.startsWith("/api/tools")) return "tool:write";

  // Memories
  if (p.startsWith("/api/memories") && method === "GET") return "memory:read";
  if (p.startsWith("/api/memories")) return "memory:write";

  // Knowledge ingestion
  if (p.startsWith("/api/knowledge") && method === "GET") return "knowledge:read";
  if (p.startsWith("/api/knowledge")) return "knowledge:write";

  // Workspaces / schedules / config — administrative
  if (p.startsWith("/api/workspaces")) return "workspace:" + (method === "GET" ? "read" : "write");
  if (p.startsWith("/api/schedules")) return "schedule:" + (method === "GET" ? "read" : "write");
  if (p.startsWith("/api/config")) return "config:" + (method === "GET" ? "read" : "write");

  // Default: treat as a read when GET, write otherwise. Wildcard-friendly.
  if (method === "GET" || method === "HEAD") return "api:read";
  return "api:write";
}

export const chvorAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const path = new URL(c.req.url).pathname;

  // Webhook receiver endpoints have their own signature verification
  if (path.match(/^\/api\/webhooks\/[^/]+\/receive$/)) return next();

  // Auth endpoints that must work without authentication
  if (
    path === "/api/auth/status" ||
    path === "/api/auth/setup" ||
    path === "/api/auth/login" ||
    path === "/api/auth/recover"
  ) {
    return next();
  }

  // OAuth callbacks (browser redirect, no session cookie)
  if (path === "/api/social/callback" || path === "/api/oauth/callback") return next();

  // If auth is not enabled, allow all requests
  if (!isAuthEnabled()) return next();

  // 1. Check session cookie (browser UI) — full access, no scope enforcement
  const cookie = getCookie(c, "chvor_session");
  if (cookie) {
    const result = validateSession(cookie);
    if (result.valid) {
      c.set("authType", "session");
      c.set("sessionId", result.sessionId);
      return next();
    }
  }

  // 2. Check Authorization header
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // API key: starts with "chvor_"
    if (token.startsWith("chvor_")) {
      const result = validateApiKey(token);
      if (result.valid) {
        const granted = parseScopes(result.scopes);
        const required = requiredScopeFor(c.req.method, path);
        if (required && !scopeMatches(granted, required)) {
          appendAudit({
            eventType: "apikey.forbidden",
            actorType: "apikey",
            actorId: result.keyId ?? null,
            resourceType: "scope",
            resourceId: required,
            action: "deny",
            httpMethod: c.req.method,
            httpPath: path,
            httpStatusCode: 403,
            error: `API key missing required scope "${required}"`,
          });
          return c.json(
            { error: "Forbidden", detail: `API key missing required scope "${required}"` },
            403
          );
        }
        c.set("authType", "apikey");
        c.set("apiKeyId", result.keyId);
        c.set("apiKeyScopes", granted);
        return next();
      }
    } else {
      // Session token via header (for non-cookie clients)
      const result = validateSession(token);
      if (result.valid) {
        c.set("authType", "session");
        c.set("sessionId", result.sessionId);
        return next();
      }
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});
