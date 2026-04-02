import { randomUUID } from "node:crypto";
import { getDb } from "./database.ts";
import type { DaemonTask, DaemonTaskStatus, DaemonTaskSource, CreateDaemonTaskRequest } from "@chvor/shared";

interface DaemonTaskRow {
  id: string;
  title: string;
  prompt: string;
  source: string;
  priority: number;
  status: string;
  progress: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToTask(row: DaemonTaskRow): DaemonTask {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    source: row.source as DaemonTaskSource,
    priority: row.priority,
    status: row.status as DaemonTaskStatus,
    progress: row.progress,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function createDaemonTask(opts: CreateDaemonTaskRequest & { source?: DaemonTaskSource }): DaemonTask {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO daemon_tasks (id, title, prompt, source, priority, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?)`
  ).run(id, opts.title, opts.prompt, opts.source ?? "user", opts.priority ?? 1, now);
  return getDaemonTask(id)!;
}

export function getDaemonTask(id: string): DaemonTask | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM daemon_tasks WHERE id = ?").get(id) as DaemonTaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function listDaemonTasks(filter?: { status?: DaemonTaskStatus; limit?: number }): DaemonTask[] {
  const db = getDb();
  let sql = "SELECT * FROM daemon_tasks";
  const params: unknown[] = [];
  if (filter?.status) {
    sql += " WHERE status = ?";
    params.push(filter.status);
  }
  sql += " ORDER BY priority DESC, created_at DESC";
  if (filter?.limit) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }
  const rows = db.prepare(sql).all(...params) as DaemonTaskRow[];
  return rows.map(rowToTask);
}

export function claimNextTask(): DaemonTask | null {
  const db = getDb();
  // Atomic claim via transaction to prevent TOCTOU race
  const claim = db.transaction(() => {
    const now = new Date().toISOString();
    const next = db.prepare(
      "SELECT id FROM daemon_tasks WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 1"
    ).get() as { id: string } | undefined;
    if (!next) return null;

    const result = db.prepare(
      "UPDATE daemon_tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'"
    ).run(now, next.id);

    if (result.changes === 0) return null; // claimed by another process
    return getDaemonTask(next.id);
  });
  return claim();
}

export function updateDaemonTask(id: string, updates: {
  status?: DaemonTaskStatus;
  progress?: string | null;
  result?: string | null;
  error?: string | null;
}): void {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) {
    sets.push("status = ?");
    params.push(updates.status);
  }
  if (updates.progress !== undefined) {
    sets.push("progress = ?");
    params.push(updates.progress);
  }
  if (updates.result !== undefined) {
    sets.push("result = ?");
    params.push(updates.result);
  }
  if (updates.error !== undefined) {
    sets.push("error = ?");
    params.push(updates.error);
  }
  if (updates.status === "completed" || updates.status === "failed") {
    sets.push("completed_at = ?");
    params.push(new Date().toISOString());
  }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE daemon_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function cancelDaemonTask(id: string): boolean {
  const db = getDb();
  const result = db.prepare(
    "UPDATE daemon_tasks SET status = 'cancelled', completed_at = ? WHERE id = ? AND status IN ('queued', 'running')"
  ).run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function pruneDaemonTasks(maxAgeDays: number = 7): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(
    "DELETE FROM daemon_tasks WHERE status IN ('completed', 'failed', 'cancelled') AND completed_at < ?"
  ).run(cutoff);
  return result.changes;
}

export function getQueueDepth(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM daemon_tasks WHERE status = 'queued'").get() as { count: number };
  return row.count;
}
