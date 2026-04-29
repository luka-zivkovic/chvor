import type {
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequestedEvent,
  GatewayServerEvent,
  SecurityActionKind,
  SecurityRisk,
} from "@chvor/shared";
import {
  appendPendingApproval,
  decideApproval,
  expireApprovalById,
  expireStaleApprovals,
  getApproval,
} from "../db/approval-store.ts";
import { startPeriodicJob, stopPeriodicJob } from "./job-runner.ts";

/**
 * Phase D4 — durable HITL gate for HIGH-risk native/MCP/PC/shell actions.
 *
 * Flow:
 *  1. Caller (`runSecurityGate`) decides a HIGH-risk verdict needs approval.
 *  2. We insert a pending row, emit `approval.requested` over WS, and wait.
 *  3. The user decides via WS (`approval.respond`) or REST
 *     (`POST /api/approvals/:id/decide`).
 *  4. Either path resolves the same in-memory promise. The DB transition
 *     is the source of truth — the WS hop is "fast-path" only.
 *  5. If the server crashes mid-wait, the row stays `pending`. The 5-min
 *     auto-expire job (or a fresh user decision after restart) closes it.
 *
 * The synthesized-tool approval flow already lives in `approval-gate.ts`.
 * We deliberately keep that one untouched — it's already durable via
 * `synthesized_session_state` and gates a different surface.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

interface PendingHandle {
  resolve: (decision: ApprovalDecision | "expired") => void;
  /** WS clientId that originated the gated tool call. Only this client may
   *  respond via WS — REST POST is allowed from anyone (REST is auth-gated
   *  upstream). */
  targetClientId?: string;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingHandle>();

/** True when HITL is on. Default ON; opt out with CHVOR_HITL_DISABLE=1. */
export function isHITLEnabled(): boolean {
  const raw = (process.env.CHVOR_HITL_DISABLE ?? "0").toLowerCase();
  return !["1", "true", "on", "yes"].includes(raw);
}

/** Approval window in ms. Default 5 min; override via CHVOR_HITL_TIMEOUT_MS. */
function getTimeoutMs(): number {
  const raw = process.env.CHVOR_HITL_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 1000) return DEFAULT_TIMEOUT_MS;
  return ms;
}

export interface RequestNativeApprovalArgs {
  sessionId: string | null;
  actionId: string | null;
  toolName: string;
  kind: SecurityActionKind;
  args: Record<string, unknown>;
  risk: SecurityRisk;
  reasons: string[];
  checkpointId: string | null;
  /** WS clientId of the originating UI session (when known). */
  originClientId?: string;
}

export type ApprovalOutcome =
  | { allowed: true; decision: "allow-once" | "allow-session"; record: ApprovalRecord }
  | { allowed: false; reason: "denied" | "expired" | "no-ws"; record: ApprovalRecord | null };

/**
 * Persist a pending approval row, emit `approval.requested`, and wait for
 * the user's decision (or auto-expire). The returned promise always settles
 * — it never rejects — so callers can branch cleanly on the outcome.
 */
export async function requestNativeApproval(
  args: RequestNativeApprovalArgs
): Promise<ApprovalOutcome> {
  const ttlMs = getTimeoutMs();
  const id = appendPendingApproval({
    sessionId: args.sessionId,
    actionId: args.actionId,
    toolName: args.toolName,
    kind: args.kind,
    args: args.args,
    risk: args.risk,
    reasons: args.reasons,
    checkpointId: args.checkpointId,
    ttlMs,
  });

  // Register the in-memory waiter before notifying clients. A very fast UI /
  // REST response can arrive immediately after the row is visible in the DB;
  // if the pending handle is not installed yet, the DB decision succeeds but
  // this promise would otherwise sit until timeout.
  const decisionPromise = new Promise<ApprovalDecision | "expired">((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve("expired");
    }, ttlMs);
    pending.set(id, {
      resolve: (d) => {
        clearTimeout(timer);
        resolve(d);
      },
      targetClientId: args.originClientId,
      timer,
    });
  });

  // Emit the WS event so the canvas can render the prompt. We don't return
  // early on `no-ws` — REST decide is still a valid path, and if there's
  // truly no decider the auto-expire job will close the row.
  const wsEvent: ApprovalRequestedEvent = {
    approvalId: id,
    sessionId: args.sessionId,
    actionId: args.actionId,
    toolName: args.toolName,
    kind: args.kind,
    argsPreview: previewArgs(args.args),
    risk: args.risk,
    reasons: args.reasons,
    checkpointId: args.checkpointId,
    expiresAt: Date.now() + ttlMs,
    options: ["allow-once", "allow-session", "deny"],
  };

  let wsAvailable = true;
  try {
    const { getWSInstance } = await import("../gateway/ws-instance.ts");
    const ws = getWSInstance();
    if (!ws) {
      wsAvailable = false;
    } else {
      const event: GatewayServerEvent = { type: "approval.requested", data: wsEvent };
      if (args.originClientId) ws.sendTo(args.originClientId, event);
      else ws.broadcast(event);
    }
  } catch (err) {
    console.warn(
      "[approval-gate-hitl] failed to emit approval.requested:",
      err instanceof Error ? err.message : String(err)
    );
    wsAvailable = false;
  }

  const decision = await decisionPromise;

  if (decision === "expired") {
    // Conditional pending → expired. If the periodic sweep got there first
    // the row is already in the right terminal state; otherwise this writes
    // it. Either way the row never lands as `denied` from a timeout, which
    // matters for the audit trail.
    expireApprovalById(id);
    const record = getApproval(id);
    return {
      allowed: false,
      reason: wsAvailable ? "expired" : "no-ws",
      record,
    };
  }

  // The resolver paths (WS / REST) already wrote to the DB. We just need
  // to read it back to surface the canonical record.
  const record = getApproval(id);
  if (!record) {
    return { allowed: false, reason: "expired", record: null };
  }
  if (record.status === "allowed" && (decision === "allow-once" || decision === "allow-session")) {
    return { allowed: true, decision, record };
  }
  return { allowed: false, reason: "denied", record };
}

/**
 * Called by the WS or REST handler when a decision arrives. Returns the
 * canonical record so the caller can serialize it back to the user.
 *
 * `responderClientId` is checked when the request originated from a known
 * client — prevents another logged-in tab from answering your prompt.
 */
export function resolveHITLApproval(args: {
  id: string;
  decision: ApprovalDecision;
  decidedBy: string;
  responderClientId?: string;
}):
  | { ok: true; record: ApprovalRecord }
  | { ok: false; reason: "not-found" | "already-decided" | "responder-mismatch" } {
  const handle = pending.get(args.id);
  if (
    handle?.targetClientId &&
    args.responderClientId &&
    handle.targetClientId !== args.responderClientId
  ) {
    return { ok: false, reason: "responder-mismatch" };
  }

  const record = decideApproval({
    id: args.id,
    decision: args.decision,
    decidedBy: args.decidedBy,
  });
  if (!record) {
    // Either the row never existed or it was already decided / expired by
    // someone else. Drop the in-memory handle so a stale waiter eventually
    // resolves through the timeout (or via a follow-up REST decide).
    if (handle) {
      pending.delete(args.id);
      handle.resolve("expired");
    }
    return { ok: false, reason: "not-found" };
  }

  if (handle) {
    pending.delete(args.id);
    handle.resolve(args.decision);
  }
  return { ok: true, record };
}

function previewArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args);
    return json.length > 240 ? `${json.slice(0, 240)}…` : json;
  } catch {
    return "[unserializable args]";
  }
}

// ── Periodic expire job ──────────────────────────────────────

const FIVE_MIN_MS = 5 * 60 * 1000;

function runExpire(): void {
  try {
    const expired = expireStaleApprovals();
    if (expired > 0) {
      console.log(`[approval-expire] auto-expired ${expired} stale pending approval(s)`);
    }
  } catch (err) {
    console.warn(
      "[approval-expire] pass failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

export function startApprovalExpire(): void {
  startPeriodicJob({ id: "approval-expire", intervalMs: FIVE_MIN_MS, run: runExpire });
}

export function stopApprovalExpire(): void {
  stopPeriodicJob("approval-expire");
}
