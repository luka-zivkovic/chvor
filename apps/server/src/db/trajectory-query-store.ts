import {
  trajectoryActorSchema,
  trajectoryModelUsageSchema,
  trajectoryOriginSchema,
  trajectoryStatusSchema,
  type TrajectoryActor,
  type TrajectoryModelUsage,
  type TrajectoryOrigin,
  type TrajectoryStatus,
} from "@chvor/shared";
import { getDb } from "./database.ts";
import { trajectoryTimestampKey } from "../lib/trajectory-time.ts";

export interface TrajectoryListCursor {
  startedAt: string;
  id: string;
}

export interface TrajectoryListQuery {
  limit: number;
  cursor?: TrajectoryListCursor;
  sessionId?: string;
  channelType?: string;
  channelId?: string;
  scheduleId?: string;
  origin?: TrajectoryOrigin["kind"];
  status?: TrajectoryStatus;
  model?: string;
  tool?: string;
  startedAfter?: string;
  startedBefore?: string;
}

export interface TrajectoryListRecord {
  id: string;
  origin: TrajectoryOrigin;
  actor: TrajectoryActor;
  status: TrajectoryStatus;
  title?: string;
  summary?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  modelUsage: TrajectoryModelUsage[];
  stepCount: number;
  artifactCount: number;
}

export interface TrajectoryListResult {
  records: TrajectoryListRecord[];
  nextCursor: TrajectoryListCursor | null;
}

interface ListRow {
  id: string;
  origin_json: string;
  actor_json: string;
  status: string;
  title: string | null;
  summary: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  input_json: string | null;
  output_json: string | null;
  model_usage_json: string;
  step_count: number;
  artifact_count: number;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`corrupt trajectory query data in ${label}`, { cause: error });
  }
}

function recordFromRow(row: ListRow): TrajectoryListRecord {
  return {
    id: row.id,
    origin: trajectoryOriginSchema.parse(parseJson(row.origin_json, `${row.id} origin`)),
    actor: trajectoryActorSchema.parse(parseJson(row.actor_json, `${row.id} actor`)),
    status: trajectoryStatusSchema.parse(row.status),
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.input_json === null ? {} : { input: parseJson(row.input_json, `${row.id} input`) }),
    ...(row.output_json === null ? {} : { output: parseJson(row.output_json, `${row.id} output`) }),
    modelUsage: trajectoryModelUsageSchema
      .array()
      .parse(parseJson(row.model_usage_json, `${row.id} model usage`)),
    stepCount: row.step_count,
    artifactCount: row.artifact_count,
  };
}

/** Stable keyset pagination ordered by newest start time, then ID. */
export function listTrajectories(query: TrajectoryListQuery): TrajectoryListResult {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, ...values: unknown[]): void => {
    clauses.push(clause);
    params.push(...values);
  };

  if (query.sessionId) add("json_extract(t.origin, '$.sessionId') = ?", query.sessionId);
  if (query.channelType) add("json_extract(t.origin, '$.channelType') = ?", query.channelType);
  if (query.channelId) add("json_extract(t.origin, '$.channelId') = ?", query.channelId);
  if (query.scheduleId) add("json_extract(t.origin, '$.scheduleId') = ?", query.scheduleId);
  if (query.origin) add("t.origin_kind = ?", query.origin);
  if (query.status) add("t.status = ?", query.status);
  if (query.startedAfter) add("t.started_at_key >= ?", trajectoryTimestampKey(query.startedAfter));
  if (query.startedBefore) add("t.started_at_key < ?", trajectoryTimestampKey(query.startedBefore));
  if (query.model) {
    add(
      `(EXISTS (
         SELECT 1 FROM json_each(t.model_usage) AS model
          WHERE json_extract(model.value, '$.modelId') = ?
             OR json_extract(model.value, '$.providerId') = ?
       ) OR EXISTS (
         SELECT 1 FROM trajectory_steps AS model_step
          WHERE model_step.trajectory_id = t.id
            AND (json_extract(model_step.model_usage, '$.modelId') = ?
              OR json_extract(model_step.model_usage, '$.providerId') = ?)
       ))`,
      query.model,
      query.model,
      query.model,
      query.model
    );
  }
  if (query.tool) {
    add(
      `EXISTS (
         SELECT 1 FROM trajectory_steps AS tool_step
          WHERE tool_step.trajectory_id = t.id
            AND json_extract(tool_step.tool_call, '$.toolName') = ?
       )`,
      query.tool
    );
  }
  if (query.cursor) {
    add(
      `(t.started_at_key < ? OR (t.started_at_key = ? AND t.id < ?))`,
      trajectoryTimestampKey(query.cursor.startedAt),
      trajectoryTimestampKey(query.cursor.startedAt),
      query.cursor.id
    );
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.origin AS origin_json, t.actor AS actor_json, t.status,
              t.title, t.summary, t.started_at, t.completed_at, t.duration_ms,
              t.input AS input_json, t.output AS output_json,
              t.model_usage AS model_usage_json,
              (SELECT COUNT(*) FROM trajectory_steps s WHERE s.trajectory_id = t.id) AS step_count,
              (SELECT COUNT(*) FROM trajectory_artifacts a WHERE a.trajectory_id = t.id) AS artifact_count
         FROM trajectories t
         ${where}
        ORDER BY t.started_at_key DESC, t.id DESC
        LIMIT ?`
    )
    .all(...params, query.limit + 1) as ListRow[];

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const records = page.map(recordFromRow);
  const last = records.at(-1);
  return {
    records,
    nextCursor: hasMore && last ? { startedAt: last.startedAt, id: last.id } : null,
  };
}
