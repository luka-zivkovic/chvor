import { randomUUID } from "node:crypto";
import type {
  CognitiveLoopEvent,
  CognitiveLoopRun,
  CognitiveLoopSeverity,
  CognitiveLoopStage,
  CognitiveLoopStatus,
} from "@chvor/shared";
import { getDb } from "./database.ts";

interface CognitiveLoopRunRow {
  id: string;
  title: string;
  status: string;
  severity: string;
  trigger: string;
  summary: string;
  current_stage: string | null;
  surface_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface CognitiveLoopEventRow {
  id: string;
  loop_id: string;
  stage: string;
  title: string;
  body: string | null;
  metadata: string | null;
  ts: string;
}

function rowToRun(row: CognitiveLoopRunRow): CognitiveLoopRun {
  return {
    id: row.id,
    title: row.title,
    status: row.status as CognitiveLoopStatus,
    severity: row.severity as CognitiveLoopSeverity,
    trigger: row.trigger as CognitiveLoopRun["trigger"],
    summary: row.summary,
    currentStage: row.current_stage as CognitiveLoopStage | null,
    surfaceId: row.surface_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToEvent(row: CognitiveLoopEventRow): CognitiveLoopEvent {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = { parseError: true };
    }
  }
  return {
    id: row.id,
    loopId: row.loop_id,
    stage: row.stage as CognitiveLoopStage,
    title: row.title,
    body: row.body,
    metadata,
    ts: row.ts,
  };
}

export function createCognitiveLoopRun(opts: {
  title: string;
  severity: CognitiveLoopSeverity;
  trigger: CognitiveLoopRun["trigger"];
  summary: string;
  surfaceId?: string | null;
}): CognitiveLoopRun {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cognitive_loop_runs
      (id, title, status, severity, trigger, summary, current_stage, surface_id, created_at, updated_at)
    VALUES (?, ?, 'running', ?, ?, ?, NULL, ?, ?, ?)
  `).run(
    id,
    opts.title.slice(0, 200),
    opts.severity,
    opts.trigger,
    opts.summary.slice(0, 2000),
    opts.surfaceId ?? null,
    now,
    now,
  );
  return getCognitiveLoopRun(id)!;
}

export function getCognitiveLoopRun(id: string): CognitiveLoopRun | null {
  const row = getDb().prepare("SELECT * FROM cognitive_loop_runs WHERE id = ?").get(id) as CognitiveLoopRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listCognitiveLoopRuns(limit = 20): CognitiveLoopRun[] {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 20), 100);
  const rows = getDb()
    .prepare("SELECT * FROM cognitive_loop_runs ORDER BY created_at DESC LIMIT ?")
    .all(safeLimit) as CognitiveLoopRunRow[];
  return rows.map(rowToRun);
}

export function listRunningCognitiveLoopRuns(): CognitiveLoopRun[] {
  const rows = getDb()
    .prepare("SELECT * FROM cognitive_loop_runs WHERE status = 'running' ORDER BY updated_at ASC")
    .all() as CognitiveLoopRunRow[];
  return rows.map(rowToRun);
}

export function updateCognitiveLoopRun(id: string, updates: {
  status?: CognitiveLoopStatus;
  currentStage?: CognitiveLoopStage | null;
  surfaceId?: string | null;
  completedAt?: string | null;
}): CognitiveLoopRun | null {
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [new Date().toISOString()];
  if (updates.status !== undefined) {
    sets.push("status = ?");
    params.push(updates.status);
  }
  if (updates.currentStage !== undefined) {
    sets.push("current_stage = ?");
    params.push(updates.currentStage);
  }
  if (updates.surfaceId !== undefined) {
    sets.push("surface_id = ?");
    params.push(updates.surfaceId);
  }
  if (updates.completedAt !== undefined) {
    sets.push("completed_at = ?");
    params.push(updates.completedAt);
  }
  params.push(id);
  getDb().prepare(`UPDATE cognitive_loop_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getCognitiveLoopRun(id);
}

export function appendCognitiveLoopEvent(opts: {
  loopId: string;
  stage: CognitiveLoopStage;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
}): CognitiveLoopEvent {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cognitive_loop_events (id, loop_id, stage, title, body, metadata, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.loopId,
    opts.stage,
    opts.title.slice(0, 240),
    opts.body?.slice(0, 5000) ?? null,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
    now,
  );
  const row = db.prepare("SELECT * FROM cognitive_loop_events WHERE id = ?").get(id) as CognitiveLoopEventRow;
  return rowToEvent(row);
}

export function listCognitiveLoopEvents(loopId: string): CognitiveLoopEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM cognitive_loop_events WHERE loop_id = ? ORDER BY ts ASC")
    .all(loopId) as CognitiveLoopEventRow[];
  return rows.map(rowToEvent);
}
