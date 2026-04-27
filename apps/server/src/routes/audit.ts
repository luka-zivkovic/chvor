import { Hono } from "hono";
import { runSecurityAudit } from "../lib/security-auditor.ts";
import { appendAudit } from "../db/audit-log-store.ts";
import type { AuthEnv } from "../middleware/auth.ts";

const auditRoute = new Hono<AuthEnv>();

/**
 * POST /api/audit — run the static security auditor and return findings.
 * Available to session auth and any API key with the `audit:run` scope.
 */
auditRoute.post("/", (c) => {
  const started = Date.now();
  const report = runSecurityAudit();
  const durationMs = Date.now() - started;

  appendAudit({
    eventType: "audit.ran",
    actorType: c.get("authType") === "apikey" ? "apikey" : "session",
    actorId: c.get("apiKeyId") ?? c.get("sessionId") ?? null,
    resourceType: "audit",
    action: "run",
    httpMethod: "POST",
    httpPath: "/api/audit",
    httpStatusCode: 200,
    durationMs,
  });

  return c.json({ data: report });
});

/**
 * GET /api/audit — same as POST, convenience for quick status checks from
 * the UI. Kept cacheable-free (no-store header) since findings can change
 * between calls.
 */
auditRoute.get("/", (c) => {
  c.header("Cache-Control", "no-store");
  const report = runSecurityAudit();
  return c.json({ data: report });
});

export default auditRoute;
