import { randomUUID } from "node:crypto";
import type { ActorType, AuditLogEntry } from "@chvor/shared";
import { getDb } from "./database.ts";

interface AuditRow {
  id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  action: string | null;
  http_method: string | null;
  http_path: string | null;
  http_status_code: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

function rowToEntry(r: AuditRow): AuditLogEntry {
  return {
    id: r.id,
    eventType: r.event_type,
    actorType: r.actor_type as ActorType,
    actorId: r.actor_id,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    action: r.action,
    httpMethod: r.http_method,
    httpPath: r.http_path,
    httpStatusCode: r.http_status_code,
    error: r.error,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  };
}

export interface AppendAuditInput {
  eventType: string;
  actorType: ActorType;
  actorId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  action?: string | null;
  httpMethod?: string | null;
  httpPath?: string | null;
  httpStatusCode?: number | null;
  error?: string | null;
  durationMs?: number | null;
}

/**
 * Append a single audit row. Caller-provided fields; timestamp + id are
 * generated here. Swallows DB errors (never let audit logging break the
 * primary request path) but logs them to console.
 */
export function appendAudit(input: AppendAuditInput): string | null {
  try {
    const id = randomUUID();
    const now = new Date().toISOString();
    const db = getDb();
    db.prepare(
      `INSERT INTO audit_log (
         id, event_type, actor_type, actor_id, resource_type, resource_id,
         action, http_method, http_path, http_status_code, error,
         duration_ms, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.eventType,
      input.actorType,
      input.actorId ?? null,
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.action ?? null,
      input.httpMethod ?? null,
      input.httpPath ?? null,
      input.httpStatusCode ?? null,
      input.error ?? null,
      input.durationMs ?? null,
      now
    );
    return id;
  } catch (err) {
    console.warn("[audit-log] failed to append:", (err as Error).message);
    return null;
  }
}

export interface AuditQuery {
  actorId?: string;
  eventType?: string;
  resourceType?: string;
  resourceId?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export function listAudit(query: AuditQuery = {}): AuditLogEntry[] {
  const db = getDb();
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
  const offset = Math.max(query.offset ?? 0, 0);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.actorId) {
    clauses.push("actor_id = ?");
    params.push(query.actorId);
  }
  if (query.eventType) {
    clauses.push("event_type = ?");
    params.push(query.eventType);
  }
  if (query.resourceType) {
    clauses.push("resource_type = ?");
    params.push(query.resourceType);
  }
  if (query.resourceId) {
    clauses.push("resource_id = ?");
    params.push(query.resourceId);
  }
  if (query.since) {
    clauses.push("created_at >= ?");
    params.push(query.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT id, event_type, actor_type, actor_id, resource_type, resource_id,
              action, http_method, http_path, http_status_code, error,
              duration_ms, created_at
         FROM audit_log
         ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as AuditRow[];

  return rows.map(rowToEntry);
}

/** Delete rows older than `olderThanDays`. Returns number removed. */
export function pruneAuditOlderThan(olderThanDays: number): number {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();
  const result = db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoff);
  return result.changes as number;
}

export function countAudit(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as n FROM audit_log").get() as { n: number };
  return row.n;
}
