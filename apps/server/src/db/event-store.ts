import { randomUUID } from "node:crypto";
import type {
  ActionEvent,
  ActionKind,
  ActorType,
  ObservationEvent,
  ObservationKind,
} from "@chvor/shared";
import { getDb } from "./database.ts";
import { redactKnownSecrets } from "../lib/credential-injector.ts";

interface ActionRow {
  id: string;
  session_id: string | null;
  kind: string;
  tool: string;
  args: string;
  ts: number;
  actor_type: string;
  actor_id: string | null;
  parent_action_id: string | null;
}

interface ObservationRow {
  id: string;
  session_id: string | null;
  action_id: string;
  kind: string;
  payload: string | null;
  ts: number;
  duration_ms: number;
}

function rowToAction(r: ActionRow): ActionEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind as ActionKind,
    tool: r.tool,
    args: safeParse(r.args, {}),
    ts: r.ts,
    actorType: r.actor_type as ActorType,
    actorId: r.actor_id,
    parentActionId: r.parent_action_id,
  };
}

function rowToObservation(r: ObservationRow): ObservationEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    actionId: r.action_id,
    kind: r.kind as ObservationKind,
    payload: r.payload ? safeParse(r.payload, null) : null,
    ts: r.ts,
    durationMs: r.duration_ms,
  };
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export interface AppendActionInput {
  sessionId: string | null;
  kind: ActionKind;
  tool: string;
  args: Record<string, unknown>;
  actorType?: ActorType;
  actorId?: string | null;
  parentActionId?: string | null;
}

/**
 * Append an ActionEvent to the audit store. Returns the generated id +
 * timestamp so the caller can pair a matching ObservationEvent.
 */
export function appendAction(input: AppendActionInput): { id: string; ts: number } {
  const id = randomUUID();
  const ts = Date.now();
  const db = getDb();
  db.prepare(
    `INSERT INTO action_events
       (id, session_id, kind, tool, args, ts, actor_type, actor_id, parent_action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.sessionId,
    input.kind,
    input.tool,
    JSON.stringify(redactKnownSecrets(input.args ?? {})),
    ts,
    input.actorType ?? "session",
    input.actorId ?? null,
    input.parentActionId ?? null
  );
  return { id, ts };
}

export interface AppendObservationInput {
  sessionId: string | null;
  actionId: string;
  kind: ObservationKind;
  payload: unknown;
  durationMs: number;
}

/** Append an ObservationEvent paired with a prior ActionEvent. */
export function appendObservation(input: AppendObservationInput): { id: string; ts: number } {
  const id = randomUUID();
  const ts = Date.now();
  const db = getDb();
  db.prepare(
    `INSERT INTO observation_events
       (id, session_id, action_id, kind, payload, ts, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.sessionId,
    input.actionId,
    input.kind,
    input.payload === undefined ? null : JSON.stringify(truncateForStorage(redactKnownSecrets(input.payload))),
    ts,
    input.durationMs
  );
  return { id, ts };
}

/**
 * Truncate large tool outputs so audit rows stay reasonable. Cap at 200KB of
 * JSON per observation — matches synthesized-caller's 200KB response cap so
 * we never lose what already made it through the safety gates.
 */
const MAX_OBSERVATION_BYTES = 200 * 1024;
function truncateForStorage(payload: unknown): unknown {
  try {
    const json = JSON.stringify(payload);
    if (json.length <= MAX_OBSERVATION_BYTES) return payload;
    return {
      __truncated: true,
      originalBytes: json.length,
      preview: json.slice(0, MAX_OBSERVATION_BYTES),
    };
  } catch {
    return { __unserializable: true };
  }
}

export interface EventQuery {
  sessionId?: string | null;
  tool?: string;
  kind?: ActionKind;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export interface EventTrace {
  action: ActionEvent;
  observations: ObservationEvent[];
}

/**
 * Return a chronologically descending list of action+observation pairs for a
 * session. Default cap 200 rows, 1000 absolute max.
 */
export function listTraces(query: EventQuery = {}): EventTrace[] {
  const db = getDb();
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
  const offset = Math.max(query.offset ?? 0, 0);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.sessionId !== undefined) {
    clauses.push("session_id IS ?");
    params.push(query.sessionId);
  }
  if (query.tool) {
    clauses.push("tool = ?");
    params.push(query.tool);
  }
  if (query.kind) {
    clauses.push("kind = ?");
    params.push(query.kind);
  }
  if (query.since) {
    clauses.push("ts >= ?");
    params.push(query.since);
  }
  if (query.until) {
    clauses.push("ts <= ?");
    params.push(query.until);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const actions = db
    .prepare(
      `SELECT id, session_id, kind, tool, args, ts, actor_type, actor_id, parent_action_id
         FROM action_events
         ${where}
         ORDER BY ts DESC
         LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as ActionRow[];

  if (actions.length === 0) return [];

  const actionIds = actions.map((a) => a.id);
  const placeholders = actionIds.map(() => "?").join(",");
  const observations = db
    .prepare(
      `SELECT id, session_id, action_id, kind, payload, ts, duration_ms
         FROM observation_events
         WHERE action_id IN (${placeholders})
         ORDER BY ts ASC`
    )
    .all(...actionIds) as ObservationRow[];

  const byAction = new Map<string, ObservationEvent[]>();
  for (const o of observations) {
    const list = byAction.get(o.action_id) ?? [];
    list.push(rowToObservation(o));
    byAction.set(o.action_id, list);
  }

  return actions.map((a) => ({
    action: rowToAction(a),
    observations: byAction.get(a.id) ?? [],
  }));
}

/** Delete events older than `olderThanMs`. Returns the number of rows removed. */
export function pruneEventsOlderThan(olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  const db = getDb();
  const tx = db.transaction(() => {
    const obs = db.prepare("DELETE FROM observation_events WHERE ts < ?").run(cutoff);
    const acts = db.prepare("DELETE FROM action_events WHERE ts < ?").run(cutoff);
    return (obs.changes as number) + (acts.changes as number);
  });
  return tx();
}

/**
 * Last N tool names that produced a successful observation in this session.
 * Used by the Cognitive Tool Graph (Phase G+) to drive co-activation scoring.
 * Ordered most-recent first; deduped so a tool that fired multiple times in
 * a row only counts once in the recency window.
 */
export function getRecentSuccessfulToolsForSession(
  sessionId: string,
  limit = 10
): string[] {
  const db = getDb();
  const cap = Math.min(Math.max(limit, 1), 100);
  const rows = db
    .prepare(
      `SELECT a.tool, MAX(o.ts) AS ts
         FROM observation_events o
         JOIN action_events a ON a.id = o.action_id
         WHERE o.session_id = ? AND o.kind = 'result'
         GROUP BY a.tool
         ORDER BY ts DESC
         LIMIT ?`
    )
    .all(sessionId, cap) as Array<{ tool: string; ts: number }>;
  return rows.map((r) => r.tool);
}

export function countActionEvents(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as n FROM action_events").get() as { n: number };
  return row.n;
}
