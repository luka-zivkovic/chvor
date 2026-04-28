import { randomUUID } from "node:crypto";
import type {
  OrchestratorCheckpoint,
  OrchestratorCheckpointSnapshot,
  OrchestratorCheckpointSummary,
} from "@chvor/shared";
import { getDb } from "./database.ts";

/**
 * Orchestrator round checkpoint storage (Phase D3, snapshot-only).
 *
 * Each row is one LLM round. State is JSON-serialized
 * `OrchestratorCheckpointSnapshot`. Snapshots stay small (~1–4 KB)
 * intentionally — full message history + tool payloads live in the
 * `messages`, `action_events`, and `observation_events` tables.
 */

interface CheckpointRow {
  id: string;
  session_id: string;
  round: number;
  state: string;
  created_at: number;
}

function rowToSummary(r: CheckpointRow): OrchestratorCheckpointSummary {
  return {
    id: r.id,
    sessionId: r.session_id,
    round: r.round,
    createdAt: r.created_at,
  };
}

function rowToCheckpoint(r: CheckpointRow): OrchestratorCheckpoint {
  let state: OrchestratorCheckpointSnapshot;
  try {
    state = JSON.parse(r.state) as OrchestratorCheckpointSnapshot;
  } catch (err) {
    // Corrupt row — return an empty-shaped snapshot so callers don't crash.
    // Logged so silent corruption (truncated writes, manual edits) is visible.
    console.warn(
      `[checkpoint-store] corrupt row id=${r.id} session=${r.session_id}:`,
      err instanceof Error ? err.message : String(err)
    );
    state = {
      round: r.round,
      bag: {
        groups: [],
        contributingSkills: [],
        isPermissive: true,
        deniedTools: [],
        requiredTools: [],
        toolCount: 0,
      },
      emotion: null,
      model: { providerId: "unknown", model: "unknown", wasFallback: false },
      ranking: [],
      toolOutcomes: [],
      recentTools: [],
      messages: { total: 0, fitted: 0 },
      memoryIds: [],
    };
  }
  return { ...rowToSummary(r), state };
}

/**
 * Append a new snapshot. Returns the generated id. Errors are absorbed —
 * checkpointing is best-effort and must never break the orchestrator.
 */
export function appendCheckpoint(
  sessionId: string,
  state: OrchestratorCheckpointSnapshot
): string | null {
  try {
    const id = randomUUID();
    const now = Date.now();
    const db = getDb();
    db.prepare(
      `INSERT INTO orchestrator_checkpoints (id, session_id, round, state, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, sessionId, state.round, JSON.stringify(state), now);
    return id;
  } catch (err) {
    console.warn(
      "[checkpoint-store] append failed:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

export interface ListCheckpointsQuery {
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export function listCheckpointSummaries(
  query: ListCheckpointsQuery = {}
): OrchestratorCheckpointSummary[] {
  const db = getDb();
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.sessionId) {
    clauses.push("session_id = ?");
    params.push(query.sessionId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT id, session_id, round, state, created_at
         FROM orchestrator_checkpoints
         ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as CheckpointRow[];
  return rows.map(rowToSummary);
}

export function getCheckpoint(id: string): OrchestratorCheckpoint | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, session_id, round, state, created_at FROM orchestrator_checkpoints WHERE id = ?"
    )
    .get(id) as CheckpointRow | undefined;
  return row ? rowToCheckpoint(row) : null;
}

/** Latest checkpoint for a session, or null. Useful for the resume route's preview. */
export function getLatestCheckpointForSession(
  sessionId: string
): OrchestratorCheckpoint | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, session_id, round, state, created_at
         FROM orchestrator_checkpoints
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
    )
    .get(sessionId) as CheckpointRow | undefined;
  return row ? rowToCheckpoint(row) : null;
}

/** Drop checkpoints older than `olderThanMs`. Returns rows removed. */
export function pruneCheckpointsOlderThan(olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  const db = getDb();
  const result = db
    .prepare("DELETE FROM orchestrator_checkpoints WHERE created_at < ?")
    .run(cutoff);
  return result.changes as number;
}

export function countCheckpoints(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as n FROM orchestrator_checkpoints")
    .get() as { n: number };
  return row.n;
}
