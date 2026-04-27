import { Hono } from "hono";
import {
  clearAllSessionPins,
  clearSessionPin,
  getSessionPin,
  listSessionPins,
  setSessionPin,
} from "../db/session-pin-store.ts";
import { listCredentials } from "../db/credential-store.ts";
import { appendAudit } from "../db/audit-log-store.ts";
import type { AuthEnv } from "../middleware/auth.ts";

const sessionPinsRoute = new Hono<AuthEnv>();

/**
 * GET /api/sessions/:sessionId/credential-pins
 * Returns the active per-type pins for a session.
 */
sessionPinsRoute.get("/:sessionId/credential-pins", (c) => {
  const sessionId = c.req.param("sessionId");
  const pins = listSessionPins(sessionId);
  // Enrich with credential names + types so the UI doesn't need a second roundtrip.
  const summary = listCredentials();
  const byId = new Map(summary.map((s) => [s.id, s]));
  return c.json({
    data: pins.map((p) => ({
      ...p,
      credentialName: byId.get(p.credentialId)?.name ?? null,
    })),
  });
});

/**
 * GET /api/sessions/:sessionId/credential-pins/:type
 * Returns a single pin for a specific credential type, or null.
 */
sessionPinsRoute.get("/:sessionId/credential-pins/:type", (c) => {
  const pin = getSessionPin(c.req.param("sessionId"), c.req.param("type"));
  if (!pin) return c.json({ data: null });
  const summary = listCredentials().find((s) => s.id === pin.credentialId);
  return c.json({
    data: {
      ...pin,
      credentialName: summary?.name ?? null,
    },
  });
});

/**
 * POST /api/sessions/:sessionId/credential-pins
 * Body: { credentialType, credentialId }
 * Creates or updates a pin. Verifies the credential exists and matches the type.
 */
sessionPinsRoute.post("/:sessionId/credential-pins", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = (await c.req.json().catch(() => ({}))) as {
    credentialType?: string;
    credentialId?: string;
  };
  const credentialType = typeof body.credentialType === "string" ? body.credentialType.trim() : "";
  const credentialId = typeof body.credentialId === "string" ? body.credentialId.trim() : "";
  if (!credentialType || !credentialId) {
    return c.json({ error: "credentialType and credentialId required" }, 400);
  }

  const cred = listCredentials().find((s) => s.id === credentialId);
  if (!cred) {
    return c.json({ error: `credential ${credentialId} not found` }, 404);
  }
  if (cred.type !== credentialType) {
    return c.json(
      {
        error: `credential ${credentialId} is type "${cred.type}", not "${credentialType}"`,
      },
      400
    );
  }

  const pin = setSessionPin(sessionId, credentialType, credentialId);

  appendAudit({
    eventType: "credential.session.pin",
    actorType: c.get("authType") === "apikey" ? "apikey" : "session",
    actorId: c.get("apiKeyId") ?? c.get("sessionId") ?? sessionId,
    resourceType: "credential",
    resourceId: credentialId,
    action: "pin",
    httpMethod: "POST",
    httpPath: c.req.path,
    httpStatusCode: 200,
  });

  return c.json({ data: { ...pin, credentialName: cred.name } });
});

/**
 * DELETE /api/sessions/:sessionId/credential-pins/:type
 * Removes a single pin.
 */
sessionPinsRoute.delete("/:sessionId/credential-pins/:type", (c) => {
  const sessionId = c.req.param("sessionId");
  const credentialType = c.req.param("type");
  const existing = getSessionPin(sessionId, credentialType);
  const removed = clearSessionPin(sessionId, credentialType);

  if (removed) {
    appendAudit({
      eventType: "credential.session.unpin",
      actorType: c.get("authType") === "apikey" ? "apikey" : "session",
      actorId: c.get("apiKeyId") ?? c.get("sessionId") ?? sessionId,
      resourceType: "credential",
      resourceId: existing?.credentialId ?? credentialType,
      action: "unpin",
      httpMethod: "DELETE",
      httpPath: c.req.path,
      httpStatusCode: 200,
    });
  }

  return c.json({ data: { removed } });
});

/**
 * DELETE /api/sessions/:sessionId/credential-pins
 * Removes every pin for the session (used on logout / session-reset).
 */
sessionPinsRoute.delete("/:sessionId/credential-pins", (c) => {
  const sessionId = c.req.param("sessionId");
  const removed = clearAllSessionPins(sessionId);

  if (removed > 0) {
    appendAudit({
      eventType: "credential.session.unpin",
      actorType: c.get("authType") === "apikey" ? "apikey" : "session",
      actorId: c.get("apiKeyId") ?? c.get("sessionId") ?? sessionId,
      resourceType: "session",
      resourceId: sessionId,
      action: "unpin-all",
      httpMethod: "DELETE",
      httpPath: c.req.path,
      httpStatusCode: 200,
    });
  }

  return c.json({ data: { removed } });
});

export default sessionPinsRoute;
