import { getDb } from "./database.ts";

/**
 * Per-session credential pins (Phase E).
 *
 * When the user has multiple credentials of the same type (two GitHub
 * accounts, three Slack workspaces, etc.) a session can pin one as the
 * default for that type for the rest of the conversation. Survives server
 * restart — sessions remember their identity choices.
 */

export interface SessionCredentialPin {
  sessionId: string;
  credentialType: string;
  credentialId: string;
  pinnedAt: string;
}

interface PinRow {
  session_id: string;
  credential_type: string;
  credential_id: string;
  pinned_at: string;
}

function rowToPin(r: PinRow): SessionCredentialPin {
  return {
    sessionId: r.session_id,
    credentialType: r.credential_type,
    credentialId: r.credential_id,
    pinnedAt: r.pinned_at,
  };
}

export function getSessionPin(
  sessionId: string,
  credentialType: string
): SessionCredentialPin | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT session_id, credential_type, credential_id, pinned_at
         FROM session_credential_pins
         WHERE session_id = ? AND credential_type = ?`
    )
    .get(sessionId, credentialType) as PinRow | undefined;
  return row ? rowToPin(row) : null;
}

export function listSessionPins(sessionId: string): SessionCredentialPin[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT session_id, credential_type, credential_id, pinned_at
         FROM session_credential_pins
         WHERE session_id = ?
         ORDER BY pinned_at DESC`
    )
    .all(sessionId) as PinRow[];
  return rows.map(rowToPin);
}

/**
 * Pin a credential to a session for a given type. Replaces any existing pin
 * of the same (sessionId, credentialType) — one credential per type per session.
 */
export function setSessionPin(
  sessionId: string,
  credentialType: string,
  credentialId: string
): SessionCredentialPin {
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO session_credential_pins (session_id, credential_type, credential_id, pinned_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, credential_type) DO UPDATE SET
       credential_id = excluded.credential_id,
       pinned_at = excluded.pinned_at`
  ).run(sessionId, credentialType, credentialId, now);
  return { sessionId, credentialType, credentialId, pinnedAt: now };
}

export function clearSessionPin(sessionId: string, credentialType: string): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM session_credential_pins
         WHERE session_id = ? AND credential_type = ?`
    )
    .run(sessionId, credentialType);
  return (result.changes as number) > 0;
}

export function clearAllSessionPins(sessionId: string): number {
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM session_credential_pins WHERE session_id = ?`)
    .run(sessionId);
  return result.changes as number;
}

/** Drop pins that point at a credential id that has been deleted. */
export function purgePinsForCredential(credentialId: string): number {
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM session_credential_pins WHERE credential_id = ?`)
    .run(credentialId);
  return result.changes as number;
}
