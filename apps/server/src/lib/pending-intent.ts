/**
 * Deferred-intent continuation.
 *
 * When the AI calls native__request_credential mid-task, we capture the
 * original user prompt that triggered the run. After the credential is saved,
 * the orchestrator can surface a "want me to continue?" message — and after a
 * server restart, we can rehydrate the queue so context isn't silently lost.
 *
 * Schema lives in database.ts migration v22 (`pending_intents` table).
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../db/database.ts";

export type PendingIntentStatus = "pending" | "resumed" | "cancelled";

export interface PendingIntent {
  id: string;
  sessionId: string;
  channelId?: string;
  originalText: string;
  waitingForCredentialType?: string;
  waitingForCredentialRequestId?: string;
  status: PendingIntentStatus;
  createdAt: string;
  resolvedAt?: string;
}

interface IntentRow {
  id: string;
  session_id: string;
  channel_id: string | null;
  original_text: string;
  waiting_for_credential_type: string | null;
  waiting_for_credential_request_id: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

function rowToIntent(row: IntentRow): PendingIntent {
  return {
    id: row.id,
    sessionId: row.session_id,
    channelId: row.channel_id ?? undefined,
    originalText: row.original_text,
    waitingForCredentialType: row.waiting_for_credential_type ?? undefined,
    waitingForCredentialRequestId: row.waiting_for_credential_request_id ?? undefined,
    status: (row.status as PendingIntentStatus) ?? "pending",
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

/**
 * Record an intent that is now waiting on a credential. The same user
 * prompt may already have an open intent (the AI re-prompted for creds);
 * dedupe by (session, originalText, credentialType).
 */
export function recordPendingIntent(args: {
  sessionId: string;
  channelId?: string;
  originalText: string;
  waitingForCredentialType?: string;
  waitingForCredentialRequestId?: string;
}): PendingIntent {
  const db = getDb();
  const existing = db
    .prepare(
      "SELECT * FROM pending_intents WHERE session_id = ? AND original_text = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    )
    .get(args.sessionId, args.originalText) as IntentRow | undefined;

  if (existing) {
    db.prepare(
      "UPDATE pending_intents SET waiting_for_credential_type = ?, waiting_for_credential_request_id = ? WHERE id = ?",
    ).run(
      args.waitingForCredentialType ?? null,
      args.waitingForCredentialRequestId ?? null,
      existing.id,
    );
    const refreshed = db
      .prepare("SELECT * FROM pending_intents WHERE id = ?")
      .get(existing.id) as IntentRow;
    return rowToIntent(refreshed);
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO pending_intents (id, session_id, channel_id, original_text, waiting_for_credential_type, waiting_for_credential_request_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
  ).run(
    id,
    args.sessionId,
    args.channelId ?? null,
    args.originalText,
    args.waitingForCredentialType ?? null,
    args.waitingForCredentialRequestId ?? null,
    createdAt,
  );
  return {
    id,
    sessionId: args.sessionId,
    channelId: args.channelId,
    originalText: args.originalText,
    waitingForCredentialType: args.waitingForCredentialType,
    waitingForCredentialRequestId: args.waitingForCredentialRequestId,
    status: "pending",
    createdAt,
  };
}

/** Mark an intent resumed (the AI is going to re-attempt it). */
export function markIntentResumed(id: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE pending_intents SET status = 'resumed', resolved_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), id);
}

/** Mark an intent cancelled (user said no, or aged out). */
export function markIntentCancelled(id: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE pending_intents SET status = 'cancelled', resolved_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), id);
}

/**
 * After a credential of `credentialType` is saved, find the most recent pending
 * intent in this session that was waiting on it.
 */
export function findResumableForCredential(args: {
  sessionId: string;
  credentialType: string;
}): PendingIntent | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM pending_intents WHERE session_id = ? AND waiting_for_credential_type = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    )
    .get(args.sessionId, args.credentialType) as IntentRow | undefined;
  return row ? rowToIntent(row) : null;
}

export function listPendingIntents(sessionId: string): PendingIntent[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM pending_intents WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC",
    )
    .all(sessionId) as IntentRow[];
  return rows.map(rowToIntent);
}

/** Drop intents older than `olderThanHours` hours. */
export function purgeStaleIntents(olderThanHours = 24): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();
  const res = db
    .prepare("DELETE FROM pending_intents WHERE status = 'pending' AND created_at < ?")
    .run(cutoff);
  return Number(res.changes ?? 0);
}
