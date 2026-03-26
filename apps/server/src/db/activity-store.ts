import { getDb } from "./database.ts";
import { randomUUID } from "node:crypto";
import type { ActivityEntry, ActivitySource } from "@chvor/shared";

const MAX_ENTRIES = 200;

export function initActivityTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      schedule_id TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_read ON activity_log(read)`);
}

export function insertActivity(entry: {
  source: ActivitySource;
  title: string;
  content?: string | null;
  scheduleId?: string | null;
}): ActivityEntry {
  const db = getDb();
  const id = randomUUID();
  const timestamp = new Date().toISOString();

  db.prepare(
    `INSERT INTO activity_log (id, timestamp, source, title, content, schedule_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, timestamp, entry.source, entry.title, entry.content ?? null, entry.scheduleId ?? null);

  // Auto-prune
  const count = (db.prepare("SELECT COUNT(*) as c FROM activity_log").get() as { c: number }).c;
  if (count > MAX_ENTRIES) {
    db.prepare(
      `DELETE FROM activity_log WHERE id IN (
        SELECT id FROM activity_log ORDER BY timestamp ASC LIMIT ?
      )`
    ).run(count - MAX_ENTRIES);
  }

  return { id, timestamp, source: entry.source, title: entry.title, content: entry.content ?? null, read: false, scheduleId: entry.scheduleId ?? null };
}

export function listActivities(limit = 50, offset = 0): ActivityEntry[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ? OFFSET ?"
  ).all(limit, offset) as Array<{
    id: string; timestamp: string; source: string; title: string;
    content: string | null; read: number; schedule_id: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    source: r.source as ActivitySource,
    title: r.title,
    content: r.content,
    read: r.read === 1,
    scheduleId: r.schedule_id,
  }));
}

export function countUnread(): number {
  const db = getDb();
  return (db.prepare("SELECT COUNT(*) as c FROM activity_log WHERE read = 0").get() as { c: number }).c;
}

export function markRead(id: string): void {
  getDb().prepare("UPDATE activity_log SET read = 1 WHERE id = ?").run(id);
}

export function markAllRead(): void {
  getDb().prepare("UPDATE activity_log SET read = 1 WHERE read = 0").run();
}
