import { Hono } from "hono";
import type { ApprovalDecision, ApprovalStatus } from "@chvor/shared";
import {
  countApprovals,
  countPendingApprovals,
  expireStaleApprovals,
  getApproval,
  listApprovals,
  pruneApprovalsOlderThan,
} from "../db/approval-store.ts";
import { resolveHITLApproval } from "../lib/approval-gate-hitl.ts";

const approvalsRoute = new Hono();

const VALID_DECISIONS: ApprovalDecision[] = ["allow-once", "allow-session", "deny"];
const VALID_STATUSES: ApprovalStatus[] = ["pending", "allowed", "denied", "expired"];

/**
 * GET /api/approvals
 * Query params: session, status, limit, offset.
 *
 * Returns a list of approval records most-recent first. The brain canvas
 * uses `?session=X&status=pending` to render in-flight prompts after a
 * page reload (the WS event is also sent live, but this lets a fresh tab
 * pick up an existing prompt).
 */
approvalsRoute.get("/", (c) => {
  const sessionId = c.req.query("session");
  const status = c.req.query("status");
  const limit = c.req.query("limit");
  const offset = c.req.query("offset");

  if (status && !VALID_STATUSES.includes(status as ApprovalStatus)) {
    return c.json({ error: `invalid status (must be one of: ${VALID_STATUSES.join(", ")})` }, 400);
  }

  const records = listApprovals({
    sessionId: sessionId ?? undefined,
    status: status as ApprovalStatus | undefined,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  return c.json({
    data: {
      records,
      totals: { stored: countApprovals(), pending: countPendingApprovals() },
    },
  });
});

/** GET /api/approvals/:id — full record for a single approval. */
approvalsRoute.get("/:id", (c) => {
  const id = c.req.param("id");
  const record = getApproval(id);
  if (!record) return c.json({ error: "not found" }, 404);
  return c.json({ data: { record } });
});

/**
 * POST /api/approvals/:id/decide
 * Body: { decision: "allow-once" | "allow-session" | "deny" }
 *
 * Mirrors the WS `approval.respond` path — REST is the canonical retry
 * channel after a page reload, since the WS handle for the original prompt
 * is by then gone.
 */
approvalsRoute.post("/:id/decide", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as
    | { decision?: string }
    | null;
  if (!body || typeof body.decision !== "string" || !VALID_DECISIONS.includes(body.decision as ApprovalDecision)) {
    return c.json(
      { error: `body must include decision: one of ${VALID_DECISIONS.join(", ")}` },
      400,
    );
  }

  const result = resolveHITLApproval({
    id,
    decision: body.decision as ApprovalDecision,
    decidedBy: "user",
  });
  if (!result.ok) {
    if (result.reason === "not-found") return c.json({ error: "approval not pending or not found" }, 404);
    return c.json({ error: result.reason }, 409);
  }
  return c.json({ data: { record: result.record } });
});

/**
 * POST /api/approvals/expire
 * Manual expire pass — useful for ops scripts and integration tests.
 * Body: { pruneDecidedDays?: number } also drops fully decided rows older
 * than the supplied window in the same call.
 */
approvalsRoute.post("/expire", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { pruneDecidedDays?: number };
  const expired = expireStaleApprovals();
  const pruned =
    typeof body.pruneDecidedDays === "number" && body.pruneDecidedDays > 0
      ? pruneApprovalsOlderThan(body.pruneDecidedDays * 24 * 60 * 60 * 1000)
      : 0;
  return c.json({ data: { expired, pruned } });
});

export default approvalsRoute;
