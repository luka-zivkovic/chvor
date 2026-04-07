import { randomUUID } from "node:crypto";
import type {
  Schedule,
  ScheduleRun,
  CreateScheduleRequest,
  UpdateScheduleRequest,
  DeliveryTarget,
} from "@chvor/shared";
import { getDb } from "./database.ts";
import cronParser from "cron-parser";
const parseExpression = cronParser.parseExpression ?? cronParser;

interface ScheduleRow {
  id: string;
  name: string;
  cron_expression: string;
  prompt: string;
  workspace_id: string;
  enabled: number;
  one_shot: number;
  deliver_to: string | null;
  workflow_id: string | null;
  workflow_params: string | null;
  last_run_at: string | null;
  last_result: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function safeJsonParse<T>(json: string | null, fallback: T, label: string, id: string): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    console.warn(`[schedule-store] corrupt JSON in ${label} for schedule ${id}, using fallback`);
    return fallback;
  }
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    cronExpression: row.cron_expression,
    prompt: row.prompt,
    workspaceId: row.workspace_id,
    enabled: row.enabled === 1,
    oneShot: row.one_shot === 1,
    deliverTo: safeJsonParse<DeliveryTarget[] | null>(row.deliver_to, null, "deliver_to", row.id),
    workflowId: row.workflow_id ?? null,
    workflowParams: safeJsonParse<Record<string, string> | null>(row.workflow_params, null, "workflow_params", row.id),
    lastRunAt: row.last_run_at,
    lastResult: row.last_result,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const MAX_SCHEDULES = 100;

export function countSchedules(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM schedules").get() as { count: number };
  return row.count;
}

export function listSchedules(): Schedule[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM schedules ORDER BY created_at DESC")
    .all() as ScheduleRow[];
  return rows.map(rowToSchedule);
}

export function getSchedule(id: string): Schedule | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM schedules WHERE id = ?")
    .get(id) as ScheduleRow | undefined;
  return row ? rowToSchedule(row) : null;
}

export function createSchedule(req: CreateScheduleRequest): Schedule {
  if (countSchedules() >= MAX_SCHEDULES) {
    throw new Error(`Schedule limit reached (max ${MAX_SCHEDULES}). Delete unused schedules before creating new ones.`);
  }
  try {
    parseExpression(req.cronExpression);
  } catch {
    throw new Error(`Invalid cron expression: "${req.cronExpression}"`);
  }
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const deliverTo = req.deliverTo ? JSON.stringify(req.deliverTo) : null;
  const enabled = (req.enabled ?? true) ? 1 : 0;
  const oneShot = req.oneShot ? 1 : 0;
  const workflowId = req.workflowId ?? null;
  const workflowParams = req.workflowParams ? JSON.stringify(req.workflowParams) : null;
  db.prepare(
    `INSERT INTO schedules (id, name, cron_expression, prompt, workspace_id, enabled, one_shot, deliver_to, workflow_id, workflow_params, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.name, req.cronExpression, req.prompt, req.workspaceId, enabled, oneShot, deliverTo, workflowId, workflowParams, now, now);
  return getSchedule(id)!;
}

export function updateSchedule(
  id: string,
  updates: UpdateScheduleRequest
): Schedule | null {
  const existing = getSchedule(id);
  if (!existing) return null;

  const db = getDb();
  const now = new Date().toISOString();
  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [now];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.cronExpression !== undefined) {
    try {
      parseExpression(updates.cronExpression);
    } catch {
      throw new Error(`Invalid cron expression: "${updates.cronExpression}"`);
    }
    fields.push("cron_expression = ?");
    values.push(updates.cronExpression);
  }
  if (updates.prompt !== undefined) {
    fields.push("prompt = ?");
    values.push(updates.prompt);
  }
  if (updates.workspaceId !== undefined) {
    fields.push("workspace_id = ?");
    values.push(updates.workspaceId);
  }
  if (updates.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(updates.enabled ? 1 : 0);
  }
  if (updates.deliverTo !== undefined) {
    fields.push("deliver_to = ?");
    values.push(updates.deliverTo ? JSON.stringify(updates.deliverTo) : null);
  }
  if (updates.workflowId !== undefined) {
    fields.push("workflow_id = ?");
    values.push(updates.workflowId);
  }
  if (updates.workflowParams !== undefined) {
    fields.push("workflow_params = ?");
    values.push(updates.workflowParams ? JSON.stringify(updates.workflowParams) : null);
  }

  values.push(id);
  db.prepare(`UPDATE schedules SET ${fields.join(", ")} WHERE id = ?`).run(
    ...values
  );
  return getSchedule(id)!;
}

export function deleteSchedule(id: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM schedule_runs WHERE schedule_id = ?").run(id);
  const result = db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  return result.changes > 0;
}

export function recordRun(
  id: string,
  startedAt: string,
  result: string | null,
  error: string | null
): void {
  const db = getDb();
  const completedAt = new Date().toISOString();
  const truncated = result ? result.slice(0, 2000) : null;
  const truncatedError = error ? error.slice(0, 2000) : null;

  // Insert into run history
  const runId = randomUUID();
  db.prepare(
    `INSERT INTO schedule_runs (id, schedule_id, started_at, completed_at, status, result, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, id, startedAt, completedAt, error ? "failed" : "completed", truncated, truncatedError);

  // Update schedule's last_run fields for quick access
  db.prepare(
    `UPDATE schedules SET last_run_at = ?, last_result = ?, last_error = ?, updated_at = ? WHERE id = ?`
  ).run(completedAt, truncated, truncatedError, completedAt, id);

  // Prune: keep only last 50 runs per schedule
  db.prepare(
    `DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN (
       SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 50
     )`
  ).run(id, id);
}

interface ScheduleRunRow {
  id: string;
  schedule_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  result: string | null;
  error: string | null;
}

export function listScheduleRuns(scheduleId: string, limit = 50): ScheduleRun[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(scheduleId, limit) as ScheduleRunRow[];
  return rows.map((r) => ({
    id: r.id,
    scheduleId: r.schedule_id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    status: r.status as "completed" | "failed",
    result: r.result,
    error: r.error,
  }));
}
