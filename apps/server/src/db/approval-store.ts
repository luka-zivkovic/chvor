import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalRecord, ApprovalStatus, SecurityActionKind, SecurityRisk } from "@chvor/shared";
import { getDb } from "./database.ts";

/**
 * Durable HITL approval store (Phase D4).
 *
 * Each row is one HIGH-risk action that needed user approval. A row is
 * inserted `pending` before the orchestrator pauses, then transitioned
 * to `allowed` / `denied` / `expired`. Pending rows survive a restart so
 * a half-decided prompt isn't lost when the server crashes.
 */

interface ApprovalRow {
  id: string;
  session_id: string | null;
  action_id: string | null;
  tool_name: string;
  kind: string;
  args: string;
  risk: string;
  reasons: string;
  checkpoint_id: string | null;
  status: string;
  decision: string | null;
  decided_at: number | null;
  decided_by: string | null;
  created_at: number;
  expires_at: number;
}

function rowToRecord(r: ApprovalRow): ApprovalRecord {
  let args: Record<string, unknown> = {};
  let reasons: string[] = [];
  try {
    args = JSON.parse(r.args) as Record<string, unknown>;
  } catch {
    args = {};
  }
  try {
    reasons = JSON.parse(r.reasons) as string[];
  } catch {
    reasons = [];
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    actionId: r.action_id,
    toolName: r.tool_name,
    kind: r.kind as SecurityActionKind,
    args,
    risk: r.risk as SecurityRisk,
    reasons,
    checkpointId: r.checkpoint_id,
    status: r.status as ApprovalStatus,
    decision: r.decision as ApprovalDecision | null,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

export interface AppendApprovalInput {
  sessionId: string | null;
  actionId: string | null;
  toolName: string;
  kind: SecurityActionKind;
  args: Record<string, unknown>;
  risk: SecurityRisk;
  reasons: string[];
  checkpointId: string | null;
  /**
   * Approval window in ms — after this the periodic job auto-expires it.
   * Negative or zero values are accepted (used by tests) and produce a row
   * whose `expires_at <= created_at`, ready to be swept by the next pass.
   */
  ttlMs: number;
}

/** Insert a fresh pending approval. Returns the new row's id. */
export function appendPendingApproval(input: AppendApprovalInput): string {
  const id = randomUUID();
  const now = Date.now();
  const db = getDb();
  db.prepare(
    `INSERT INTO approvals
       (id, session_id, action_id, tool_name, kind, args, risk, reasons,
        checkpoint_id, status, decision, decided_at, decided_by,
        created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`
  ).run(
    id,
    input.sessionId,
    input.actionId,
    input.toolName,
    input.kind,
    JSON.stringify(truncateForStorage(input.args)),
    input.risk,
    JSON.stringify(input.reasons.slice(0, 8)),
    input.checkpointId,
    now,
    now + input.ttlMs,
  );
  return id;
}

const MAX_ARGS_BYTES = 32 * 1024;
function truncateForStorage(args: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = JSON.stringify(args);
    if (json.length <= MAX_ARGS_BYTES) return args;
    return { __truncated: true, originalBytes: json.length, preview: json.slice(0, MAX_ARGS_BYTES) };
  } catch {
    return { __unserializable: true };
  }
}

export function getApproval(id: string): ApprovalRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM approvals WHERE id = ?")
    .get(id) as ApprovalRow | undefined;
  return row ? rowToRecord(row) : null;
}

export interface ListApprovalsQuery {
  sessionId?: string;
  status?: ApprovalStatus;
  limit?: number;
  offset?: number;
}

export function listApprovals(query: ListApprovalsQuery = {}): ApprovalRecord[] {
  const db = getDb();
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.sessionId) {
    clauses.push("session_id = ?");
    params.push(query.sessionId);
  }
  if (query.status) {
    clauses.push("status = ?");
    params.push(query.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as ApprovalRow[];
  return rows.map(rowToRecord);
}

export interface DecideApprovalInput {
  id: string;
  decision: ApprovalDecision;
  decidedBy: string;
}

/**
 * Conditional update: only flips a row from `pending` → final state. Returns
 * the new record on success, or null if the row was already decided / expired
 * / missing. The caller (gate) treats null as "lost the race" — typically
 * because the auto-expire job got there first.
 */
export function decideApproval(input: DecideApprovalInput): ApprovalRecord | null {
  const db = getDb();
  const status: ApprovalStatus = input.decision === "deny" ? "denied" : "allowed";
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE approvals
         SET status = ?, decision = ?, decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'pending'`
    )
    .run(status, input.decision, now, input.decidedBy, input.id);
  if ((result.changes as number) === 0) return null;
  return getApproval(input.id);
}

/**
 * Periodic job: transition every pending row whose expiresAt has passed to
 * status='expired'. Returns the number of rows touched. Run every 5 min via
 * the persistent job-runner.
 */
export function expireStaleApprovals(): number {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE approvals
         SET status = 'expired', decided_at = ?, decided_by = 'auto-expire'
         WHERE status = 'pending' AND expires_at < ?`
    )
    .run(now, now);
  return result.changes as number;
}

/**
 * Conditional update of a single row to status='expired'. Used by the
 * in-memory timeout path so a timed-out prompt always lands in the same
 * terminal state the periodic sweep would write — `decideApproval` can't
 * be reused here because its `decision` parameter only models user-visible
 * choices (allow-once / allow-session / deny), not auto-expiry.
 */
export function expireApprovalById(id: string): ApprovalRecord | null {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE approvals
         SET status = 'expired', decided_at = ?, decided_by = 'auto-expire'
         WHERE id = ? AND status = 'pending'`
    )
    .run(now, id);
  if ((result.changes as number) === 0) return null;
  return getApproval(id);
}

/**
 * Drop fully decided rows older than `olderThanMs`. Pending rows are never
 * touched — the expire pass handles them. Used by the same retention window
 * as checkpoints / events so audit history stays correlated.
 */
export function pruneApprovalsOlderThan(olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM approvals WHERE status != 'pending' AND created_at < ?`
    )
    .run(cutoff);
  return result.changes as number;
}

export function countApprovals(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as n FROM approvals")
    .get() as { n: number };
  return row.n;
}

export function countPendingApprovals(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as n FROM approvals WHERE status = 'pending'")
    .get() as { n: number };
  return row.n;
}
