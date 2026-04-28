import { Hono } from "hono";
import { getCheckpoint, getLatestCheckpointForSession } from "../db/checkpoint-store.ts";
import { listApprovals } from "../db/approval-store.ts";

/**
 * Phase D4 — orchestrator resume preview.
 *
 * This PR ships the *preview* surface: given a checkpoint id (or "latest"
 * for a session), return everything a UI needs to render "where the
 * orchestrator paused" so the user can decide whether to continue, edit
 * a tool's args, or abandon the turn. Pending approvals associated with
 * the same session are included so the canvas can re-attach to the
 * prompt after a reload.
 *
 * Full mid-turn pause/resume — actually re-entering executeConversation
 * with the saved bag/messages and replaying the round — is intentionally
 * out of scope here. That requires extracting the round-loop body into a
 * resumable helper and is a separate refactor (Phase D5).
 */

const resumeRoute = new Hono();

/** GET /api/orchestrator/resume/:checkpointId */
resumeRoute.get("/:checkpointId", (c) => {
  const checkpointId = c.req.param("checkpointId");
  const checkpoint = getCheckpoint(checkpointId);
  if (!checkpoint) return c.json({ error: "checkpoint not found" }, 404);

  const pendingApprovals = listApprovals({
    sessionId: checkpoint.sessionId,
    status: "pending",
    limit: 20,
  });
  return c.json({
    data: {
      checkpoint,
      pendingApprovals,
      // Future: `replayable: true`, `mutableArgs: [...]`, etc.
      replayable: false,
      reason: "preview-only",
    },
  });
});

/**
 * GET /api/orchestrator/resume/session/:sessionId
 * Convenience: latest checkpoint + any pending approvals for the session.
 */
resumeRoute.get("/session/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const checkpoint = getLatestCheckpointForSession(sessionId);
  const pendingApprovals = listApprovals({ sessionId, status: "pending", limit: 20 });
  return c.json({
    data: {
      sessionId,
      checkpoint,
      pendingApprovals,
      replayable: false,
      reason: "preview-only",
    },
  });
});

export default resumeRoute;
