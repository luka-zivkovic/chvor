import { Hono } from "hono";
import { listTraces, countActionEvents, pruneEventsOlderThan } from "../db/event-store.ts";
import { listAudit, countAudit, pruneAuditOlderThan } from "../db/audit-log-store.ts";
import type { ActionKind } from "@chvor/shared";

const debugRoute = new Hono();

/**
 * GET /api/debug/events — paired action + observation trace for a session.
 * Query params: session, tool, kind, since (unix ms), until (unix ms), limit, offset
 */
debugRoute.get("/events", (c) => {
  const sessionId = c.req.query("session");
  const tool = c.req.query("tool");
  const kind = c.req.query("kind") as ActionKind | undefined;
  const sinceRaw = c.req.query("since");
  const untilRaw = c.req.query("until");
  const limitRaw = c.req.query("limit");
  const offsetRaw = c.req.query("offset");

  const traces = listTraces({
    sessionId: sessionId ?? undefined,
    tool,
    kind,
    since: sinceRaw ? Number(sinceRaw) : undefined,
    until: untilRaw ? Number(untilRaw) : undefined,
    limit: limitRaw ? Number(limitRaw) : undefined,
    offset: offsetRaw ? Number(offsetRaw) : undefined,
  });

  return c.json({ data: { traces, totalStored: countActionEvents() } });
});

/**
 * GET /api/debug/audit — normalized audit log rows.
 * Query params: actor, event, resourceType, resourceId, since (ISO), limit, offset
 */
debugRoute.get("/audit", (c) => {
  const actor = c.req.query("actor");
  const eventType = c.req.query("event");
  const resourceType = c.req.query("resourceType");
  const resourceId = c.req.query("resourceId");
  const since = c.req.query("since");
  const limit = c.req.query("limit");
  const offset = c.req.query("offset");

  const rows = listAudit({
    actorId: actor ?? undefined,
    eventType: eventType ?? undefined,
    resourceType: resourceType ?? undefined,
    resourceId: resourceId ?? undefined,
    since: since ?? undefined,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });

  return c.json({ data: { rows, totalStored: countAudit() } });
});

/**
 * POST /api/debug/prune — delete rows older than N days. Meant for ops;
 * requires the caller already pass the auth middleware (gated at app level).
 * Body: { daysEvents?: number, daysAudit?: number }
 */
debugRoute.post("/prune", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    daysEvents?: number;
    daysAudit?: number;
  };
  const daysEvents = typeof body.daysEvents === "number" && body.daysEvents > 0 ? body.daysEvents : null;
  const daysAudit = typeof body.daysAudit === "number" && body.daysAudit > 0 ? body.daysAudit : null;

  const prunedEvents = daysEvents ? pruneEventsOlderThan(daysEvents * 24 * 60 * 60 * 1000) : 0;
  const prunedAudit = daysAudit ? pruneAuditOlderThan(daysAudit) : 0;

  return c.json({ data: { prunedEvents, prunedAudit } });
});

export default debugRoute;
