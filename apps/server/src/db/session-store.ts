import type { ChatMessage, ChannelType, Session } from "@chvor/shared";
import { getDb } from "./database.ts";

interface SessionRow {
  id: string;
  channel_type: string;
  channel_id: string;
  thread_id: string | null;
  workspace_id: string;
  messages: string; // kept for compat, no longer read
  summary: string | null;
  title: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  channel_type: string;
  timestamp: string;
  execution_id: string | null;
  actions: string | null;
  media: string | null;
  token_count: number;
}

function rowToMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role as "user" | "assistant",
    content: row.content,
    channelType: row.channel_type as ChannelType,
    timestamp: row.timestamp,
    executionId: row.execution_id ?? undefined,
    actions: row.actions ? JSON.parse(row.actions) : undefined,
    media: row.media ? JSON.parse(row.media) : undefined,
  };
}

// ─── Message operations ────────────────────────────────────────

export function addMessage(sessionId: string, message: ChatMessage): void {
  const db = getDb();
  const tokenCount = Math.ceil(message.content.length / 4);
  db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO messages (id, session_id, role, content, channel_type, timestamp, execution_id, actions, media, token_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      message.id,
      sessionId,
      message.role,
      message.content,
      message.channelType,
      message.timestamp,
      message.executionId ?? null,
      message.actions ? JSON.stringify(message.actions) : null,
      message.media ? JSON.stringify(message.media) : null,
      tokenCount
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), sessionId);
  })();
}

export function getRecentMessages(
  sessionId: string,
  limit: number = 500,
  offset: number = 0
): ChatMessage[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ? OFFSET ?`
  ).all(sessionId, limit, offset) as MessageRow[];
  return rows.map(rowToMessage);
}

export function getSessionMessageCount(sessionId: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?"
  ).get(sessionId) as { cnt: number };
  return row.cnt;
}

// ─── Summary operations ──────────────────────────────────────

export function getSessionSummary(sessionId: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT summary FROM sessions WHERE id = ?")
    .get(sessionId) as { summary: string | null } | undefined;
  return row?.summary ?? null;
}

export function updateSessionSummary(
  sessionId: string,
  summary: string
): void {
  const db = getDb();
  db.prepare("UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?").run(
    summary,
    new Date().toISOString(),
    sessionId
  );
}

export function updateSessionTitle(id: string, title: string): boolean {
  const db = getDb();
  const result = db.prepare(
    "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?"
  ).run(title, new Date().toISOString(), id);
  return result.changes > 0;
}

export function updateSessionArchive(id: string, archive: boolean): boolean {
  const db = getDb();
  const archivedAt = archive ? new Date().toISOString() : null;
  const result = db.prepare(
    "UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?"
  ).run(archivedAt, new Date().toISOString(), id);
  return result.changes > 0;
}

export function getSessionTitle(id: string): string | null {
  const db = getDb();
  const row = db.prepare("SELECT title FROM sessions WHERE id = ?").get(id) as { title: string | null } | undefined;
  return row?.title ?? null;
}

// ─── Session operations ────────────────────────────────────────

export function getSessionById(id: string): Session | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?")
    .get(id) as SessionRow | undefined;
  if (!row) return null;
  const messages = getRecentMessages(id);
  return {
    id: row.id,
    channelType: row.channel_type as ChannelType,
    channelId: row.channel_id,
    threadId: row.thread_id ?? undefined,
    workspaceId: row.workspace_id,
    messages,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertSession(
  id: string,
  channelType: ChannelType,
  channelId: string,
  threadId: string | undefined,
  workspaceId: string
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, channel_type, channel_id, thread_id, workspace_id, messages, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(id, channelType, channelId, threadId ?? null, workspaceId, now, now);
}

export interface SessionSummary {
  id: string;
  title: string | null;
  channelType: string;
  channelId: string;
  threadId?: string;
  messageCount: number;
  preview: string | null;
  updatedAt: string;
  archivedAt: string | null;
}

export function listSessions(options?: {
  archived?: boolean;
  search?: string;
}): SessionSummary[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  // Filter by channel type — only web sessions for now
  conditions.push("s.channel_type = 'web'");

  // Archive filter
  if (options?.archived === true) {
    conditions.push("s.archived_at IS NOT NULL");
  } else if (options?.archived === false) {
    conditions.push("s.archived_at IS NULL");
  }

  // Search filter
  if (options?.search) {
    const term = `%${options.search}%`;
    conditions.push(
      "(s.title LIKE ? OR s.id IN (SELECT session_id FROM messages WHERE content LIKE ?))"
    );
    params.push(term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db.prepare(
    `SELECT s.id, s.title, s.channel_type, s.channel_id, s.thread_id,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count,
            (SELECT SUBSTR(content, 1, 100) FROM messages
             WHERE session_id = s.id AND role = 'assistant'
             ORDER BY timestamp DESC LIMIT 1) as preview,
            s.updated_at, s.archived_at
     FROM sessions s ${where} ORDER BY s.updated_at DESC`
  ).all(...params) as any[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? null,
    channelType: row.channel_type,
    channelId: row.channel_id,
    threadId: row.thread_id ?? undefined,
    messageCount: row.message_count,
    preview: row.preview ?? null,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  }));
}

/** Clear all messages and summary for a session (reset), keeping the session record */
export function clearSessionMessages(id: string): boolean {
  const db = getDb();
  const result = db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    return db.prepare(
      "UPDATE sessions SET summary = NULL, updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), id);
  })();
  return result.changes > 0;
}

export function deleteSession(id: string): boolean {
  const db = getDb();
  const del = db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    return db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  });
  const result = del();
  return result.changes > 0;
}

export function deleteAllSessions(): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM sessions").run();
  })();
}

export interface ChannelTarget {
  channelType: string;
  channelId: string;
  lastActive: string;
}

export function listChannelTargets(): ChannelTarget[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT channel_type, channel_id, MAX(updated_at) as last_active
     FROM sessions
     WHERE channel_type IN ('telegram', 'discord', 'slack')
     GROUP BY channel_type, channel_id
     ORDER BY last_active DESC`
  ).all() as { channel_type: string; channel_id: string; last_active: string }[];
  return rows.map((r) => ({
    channelType: r.channel_type,
    channelId: r.channel_id,
    lastActive: r.last_active,
  }));
}

export function cleanupStaleSessions(maxAgeDays: number): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.transaction(() => {
    db.prepare(
      "DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE updated_at < ? AND archived_at IS NULL)"
    ).run(cutoff);
    return db.prepare("DELETE FROM sessions WHERE updated_at < ? AND archived_at IS NULL").run(cutoff);
  })();
  return result.changes;
}

/** Get sessions older than maxAgeDays without deleting them */
export function getStaleSessions(maxAgeDays: number): { id: string; channelType: string; messageCount: number }[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(
    `SELECT s.id, s.channel_type as channelType,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as messageCount
     FROM sessions s WHERE s.updated_at < ? AND s.archived_at IS NULL`
  ).all(cutoff) as { id: string; channelType: string; messageCount: number }[];
}

/** Remove orphaned web sessions that used the old ephemeral ws-N format */
export function cleanupOrphanedWebSessions(): number {
  const db = getDb();
  const result = db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE id LIKE 'web:ws-%')").run();
    return db.prepare("DELETE FROM sessions WHERE id LIKE 'web:ws-%'").run();
  })();
  return result.changes;
}

/** Get IDs of active (non-archived) sessions that have messages */
export function getActiveSessionIds(): string[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT s.id FROM sessions s
     WHERE s.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)`
  ).all() as { id: string }[];
  return rows.map((r) => r.id);
}

/** Get messages for a session by ID (for REST endpoint) */
export function getSessionMessages(
  id: string,
  limit?: number,
  offset?: number
): ChatMessage[] {
  return getRecentMessages(id, limit ?? 500, offset ?? 0);
}
