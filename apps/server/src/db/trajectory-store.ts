import type Database from "better-sqlite3";
import {
  canonicalTrajectorySchema,
  canonicalTrajectoryStepV1Schema,
  trajectoryArtifactRefSchema,
  trajectoryErrorSchema,
  type CanonicalTrajectoryStepV1,
  type CanonicalTrajectoryV1,
  type TrajectoryArtifactRef,
  type TrajectoryError,
  type TrajectoryStatus,
} from "@chvor/shared";
import { getDb } from "./database.ts";

const TERMINAL_STATUSES = new Set<TrajectoryStatus>([
  "completed",
  "failed",
  "aborted",
  "round-limited",
]);

const TRAJECTORY_KEYS = new Set([
  "schemaVersion",
  "id",
  "origin",
  "actor",
  "status",
  "title",
  "summary",
  "startedAt",
  "completedAt",
  "durationMs",
  "input",
  "output",
  "modelUsage",
  "steps",
  "artifacts",
  "error",
  "labels",
  "attributes",
]);

const STEP_KEYS = new Set([
  "id",
  "trajectoryId",
  "sequence",
  "parentStepId",
  "kind",
  "customType",
  "status",
  "name",
  "actor",
  "startedAt",
  "completedAt",
  "durationMs",
  "input",
  "output",
  "modelUsage",
  "toolCall",
  "approval",
  "error",
  "artifacts",
  "attributes",
]);

const ARTIFACT_KEYS = new Set([
  "artifactId",
  "kind",
  "name",
  "mediaType",
  "locator",
  "sizeBytes",
  "sha256",
]);

const IMMUTABLE_METADATA_KEYS = new Set([
  "schemaVersion",
  "id",
  "origin",
  "actor",
  "startedAt",
  "steps",
  "artifacts",
]);

interface TrajectoryRow {
  id: string;
  schema_version: number;
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
  error_json: string | null;
  labels_json: string;
  attributes_json: string;
  extensions_json: string;
  next_sequence: number;
}

interface StepRow {
  id: string;
  trajectory_id: string;
  sequence: number;
  parent_step_id: string | null;
  kind: string;
  custom_type: string | null;
  status: string;
  name: string | null;
  actor_json: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  input_json: string | null;
  output_json: string | null;
  model_usage_json: string | null;
  tool_call_json: string | null;
  approval_json: string | null;
  error_json: string | null;
  attributes_json: string;
  extensions_json: string;
}

interface ArtifactRow {
  trajectory_id: string;
  step_id: string | null;
  position: number;
  artifact_id: string;
  kind: string;
  name: string | null;
  media_type: string | null;
  locator: string | null;
  size_bytes: number | null;
  sha256: string | null;
  extensions_json: string;
}

function parseJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`corrupt trajectory data in ${context}: invalid JSON`, { cause: error });
  }
}

function parseExtensions(value: string, context: string): Record<string, unknown> {
  const parsed = parseJson(value, context);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`corrupt trajectory data in ${context}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

function serializeOptionalJson(value: unknown): string | null {
  return value === undefined ? null : serializeJson(value);
}

function extensionsOf(
  value: Record<string, unknown>,
  knownKeys: Set<string>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !knownKeys.has(key)));
}

function assertNonnegativeFiniteDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite nonnegative number`);
  }
}

function artifactFromRow(row: ArtifactRow): Record<string, unknown> {
  return {
    ...parseExtensions(row.extensions_json, `artifact ${row.artifact_id} extensions`),
    artifactId: row.artifact_id,
    kind: row.kind,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.media_type === null ? {} : { mediaType: row.media_type }),
    ...(row.locator === null ? {} : { locator: row.locator }),
    ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
  };
}

function insertArtifacts(
  db: Database.Database,
  trajectoryId: string,
  stepId: string | null,
  artifacts: CanonicalTrajectoryV1["artifacts"],
  startPosition = 0
): void {
  const insert = db.prepare(
    `INSERT INTO trajectory_artifacts (
       trajectory_id, step_id, owner_kind, position, artifact_id, kind, name,
       media_type, locator, size_bytes, sha256, extensions, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const now = new Date().toISOString();
  artifacts.forEach((artifact, index) => {
    insert.run(
      trajectoryId,
      stepId,
      stepId === null ? "trajectory" : "step",
      startPosition + index,
      artifact.artifactId,
      artifact.kind,
      artifact.name ?? null,
      artifact.mediaType ?? null,
      artifact.locator ?? null,
      artifact.sizeBytes ?? null,
      artifact.sha256 ?? null,
      serializeJson(extensionsOf(artifact as Record<string, unknown>, ARTIFACT_KEYS)),
      now
    );
  });
}

function insertTrajectoryRow(db: Database.Database, trajectory: CanonicalTrajectoryV1): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO trajectories (
       id, schema_version, origin_kind, origin, actor, status, title, summary,
       started_at, completed_at, duration_ms, input, output, model_usage,
       error, labels, attributes, extensions, next_sequence, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    trajectory.id,
    trajectory.schemaVersion,
    trajectory.origin.kind,
    serializeJson(trajectory.origin),
    serializeJson(trajectory.actor),
    trajectory.status,
    trajectory.title ?? null,
    trajectory.summary ?? null,
    trajectory.startedAt,
    trajectory.completedAt ?? null,
    trajectory.durationMs ?? null,
    serializeOptionalJson(trajectory.input),
    serializeOptionalJson(trajectory.output),
    serializeJson(trajectory.modelUsage),
    serializeOptionalJson(trajectory.error),
    serializeJson(trajectory.labels),
    serializeJson(trajectory.attributes),
    serializeJson(extensionsOf(trajectory as Record<string, unknown>, TRAJECTORY_KEYS)),
    now,
    now
  );
}

function insertStepRow(db: Database.Database, step: CanonicalTrajectoryStepV1): void {
  db.prepare(
    `INSERT INTO trajectory_steps (
       id, trajectory_id, sequence, parent_step_id, kind, custom_type, status,
       name, actor, started_at, completed_at, duration_ms, input, output,
       model_usage, tool_call, approval, error, attributes, extensions, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    step.id,
    step.trajectoryId,
    step.sequence,
    step.parentStepId ?? null,
    step.kind,
    step.customType ?? null,
    step.status,
    step.name ?? null,
    serializeOptionalJson(step.actor),
    step.startedAt,
    step.completedAt ?? null,
    step.durationMs ?? null,
    serializeOptionalJson(step.input),
    serializeOptionalJson(step.output),
    serializeOptionalJson(step.modelUsage),
    serializeOptionalJson(step.toolCall),
    serializeOptionalJson(step.approval),
    serializeOptionalJson(step.error),
    serializeJson(step.attributes),
    serializeJson(extensionsOf(step as Record<string, unknown>, STEP_KEYS)),
    new Date().toISOString()
  );
}

function getArtifacts(
  db: Database.Database,
  trajectoryId: string
): { topLevel: Record<string, unknown>[]; byStep: Map<string, Record<string, unknown>[]> } {
  const rows = db
    .prepare(
      `SELECT trajectory_id, step_id, position, artifact_id, kind, name,
              media_type, locator, size_bytes, sha256, extensions AS extensions_json
         FROM trajectory_artifacts
        WHERE trajectory_id = ?
        ORDER BY CASE WHEN step_id IS NULL THEN 0 ELSE 1 END,
                 step_id ASC, position ASC, artifact_id ASC`
    )
    .all(trajectoryId) as ArtifactRow[];
  const topLevel: Record<string, unknown>[] = [];
  const byStep = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const artifact = artifactFromRow(row);
    if (row.step_id === null) {
      topLevel.push(artifact);
    } else {
      const values = byStep.get(row.step_id) ?? [];
      values.push(artifact);
      byStep.set(row.step_id, values);
    }
  }
  return { topLevel, byStep };
}

function stepFromRow(row: StepRow, artifacts: Record<string, unknown>[]): Record<string, unknown> {
  return {
    ...parseExtensions(row.extensions_json, `step ${row.id} extensions`),
    id: row.id,
    trajectoryId: row.trajectory_id,
    sequence: row.sequence,
    ...(row.parent_step_id === null ? {} : { parentStepId: row.parent_step_id }),
    kind: row.kind,
    ...(row.custom_type === null ? {} : { customType: row.custom_type }),
    status: row.status,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.actor_json === null
      ? {}
      : { actor: parseJson(row.actor_json, `step ${row.id} actor`) }),
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.input_json === null
      ? {}
      : { input: parseJson(row.input_json, `step ${row.id} input`) }),
    ...(row.output_json === null
      ? {}
      : { output: parseJson(row.output_json, `step ${row.id} output`) }),
    ...(row.model_usage_json === null
      ? {}
      : { modelUsage: parseJson(row.model_usage_json, `step ${row.id} model usage`) }),
    ...(row.tool_call_json === null
      ? {}
      : { toolCall: parseJson(row.tool_call_json, `step ${row.id} tool call`) }),
    ...(row.approval_json === null
      ? {}
      : { approval: parseJson(row.approval_json, `step ${row.id} approval`) }),
    ...(row.error_json === null
      ? {}
      : { error: parseJson(row.error_json, `step ${row.id} error`) }),
    artifacts,
    attributes: parseJson(row.attributes_json, `step ${row.id} attributes`),
  };
}

function reconstructTrajectory(
  db: Database.Database,
  trajectoryId: string
): CanonicalTrajectoryV1 | null {
  const row = db
    .prepare(
      `SELECT id, schema_version, origin AS origin_json, actor AS actor_json,
              status, title, summary, started_at, completed_at, duration_ms,
              input AS input_json, output AS output_json,
              model_usage AS model_usage_json, error AS error_json,
              labels AS labels_json, attributes AS attributes_json,
              extensions AS extensions_json, next_sequence
         FROM trajectories
        WHERE id = ?`
    )
    .get(trajectoryId) as TrajectoryRow | undefined;
  if (!row) return null;

  const stepRows = db
    .prepare(
      `SELECT id, trajectory_id, sequence, parent_step_id, kind, custom_type,
              status, name, actor AS actor_json, started_at, completed_at, duration_ms,
              input AS input_json, output AS output_json, model_usage AS model_usage_json,
              tool_call AS tool_call_json, approval AS approval_json, error AS error_json,
              attributes AS attributes_json, extensions AS extensions_json
         FROM trajectory_steps
        WHERE trajectory_id = ?
        ORDER BY sequence ASC, id ASC`
    )
    .all(trajectoryId) as StepRow[];
  const artifacts = getArtifacts(db, trajectoryId);
  const candidate = {
    ...parseExtensions(row.extensions_json, `trajectory ${row.id} extensions`),
    schemaVersion: row.schema_version,
    id: row.id,
    origin: parseJson(row.origin_json, `trajectory ${row.id} origin`),
    actor: parseJson(row.actor_json, `trajectory ${row.id} actor`),
    status: row.status,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.input_json === null
      ? {}
      : { input: parseJson(row.input_json, `trajectory ${row.id} input`) }),
    ...(row.output_json === null
      ? {}
      : { output: parseJson(row.output_json, `trajectory ${row.id} output`) }),
    modelUsage: parseJson(row.model_usage_json, `trajectory ${row.id} model usage`),
    steps: stepRows.map((step) => stepFromRow(step, artifacts.byStep.get(step.id) ?? [])),
    artifacts: artifacts.topLevel,
    ...(row.error_json === null
      ? {}
      : { error: parseJson(row.error_json, `trajectory ${row.id} error`) }),
    labels: parseJson(row.labels_json, `trajectory ${row.id} labels`),
    attributes: parseJson(row.attributes_json, `trajectory ${row.id} attributes`),
  };

  const parsed = canonicalTrajectorySchema.parse(candidate);
  if (row.next_sequence !== parsed.steps.length) {
    throw new Error(
      `corrupt trajectory data for ${row.id}: next_sequence ${row.next_sequence} does not match ${parsed.steps.length} stored steps`
    );
  }
  parsed.steps.forEach((step, index) => {
    if (step.sequence !== index) {
      throw new Error(
        `corrupt trajectory data for ${row.id}: expected contiguous sequence ${index}, got ${step.sequence}`
      );
    }
  });
  return parsed;
}

/** Insert a sanitized trajectory shell and its top-level artifacts atomically. */
export function createTrajectory(input: CanonicalTrajectoryV1): CanonicalTrajectoryV1 {
  const trajectory = canonicalTrajectorySchema.parse(input);
  if (trajectory.steps.length !== 0) {
    throw new Error("createTrajectory requires an empty steps array; append steps separately");
  }

  const db = getDb();
  const insert = db.transaction(() => {
    insertTrajectoryRow(db, trajectory);
    insertArtifacts(db, trajectory.id, null, trajectory.artifacts);
  });
  insert();
  return reconstructTrajectory(db, trajectory.id)!;
}

/** Append one immutable, sanitized step and its artifacts in a single transaction. */
export function appendTrajectoryStep(
  trajectoryId: string,
  input: CanonicalTrajectoryStepV1
): CanonicalTrajectoryStepV1 {
  const step = canonicalTrajectoryStepV1Schema.parse(input);
  if (step.trajectoryId !== trajectoryId) {
    throw new Error(
      `step trajectoryId ${step.trajectoryId} does not match target trajectory ${trajectoryId}`
    );
  }
  const db = getDb();
  const append = db.transaction(() => {
    const trajectory = db
      .prepare("SELECT status, next_sequence FROM trajectories WHERE id = ?")
      .get(step.trajectoryId) as { status: TrajectoryStatus; next_sequence: number } | undefined;
    if (!trajectory) throw new Error(`trajectory not found: ${step.trajectoryId}`);
    if (TERMINAL_STATUSES.has(trajectory.status)) {
      throw new Error(`cannot append to terminal trajectory ${step.trajectoryId}`);
    }
    if (step.sequence !== trajectory.next_sequence) {
      throw new Error(
        `trajectory ${step.trajectoryId} expected sequence ${trajectory.next_sequence}, got ${step.sequence}`
      );
    }
    if (step.parentStepId) {
      const parent = db
        .prepare(
          `SELECT sequence FROM trajectory_steps
            WHERE id = ? AND trajectory_id = ?`
        )
        .get(step.parentStepId, step.trajectoryId) as { sequence: number } | undefined;
      if (!parent || parent.sequence >= step.sequence) {
        throw new Error("parentStepId must reference an earlier step in the same trajectory");
      }
    }

    insertStepRow(db, step);
    insertArtifacts(db, step.trajectoryId, step.id, step.artifacts);
    const updated = db
      .prepare(
        `UPDATE trajectories
            SET next_sequence = next_sequence + 1, updated_at = ?
          WHERE id = ? AND next_sequence = ?`
      )
      .run(new Date().toISOString(), step.trajectoryId, step.sequence);
    if (updated.changes !== 1) throw new Error("trajectory sequence changed during append");
    const reconstructed = reconstructTrajectory(db, trajectoryId);
    if (!reconstructed) throw new Error(`trajectory disappeared during append: ${trajectoryId}`);
    return reconstructed.steps[reconstructed.steps.length - 1];
  });
  return append();
}

/** Reconstruct and validate a complete canonical trajectory from normalized rows. */
export function getTrajectory(trajectoryId: string): CanonicalTrajectoryV1 | null {
  return reconstructTrajectory(getDb(), trajectoryId);
}

/**
 * Append one sanitized top-level artifact without replacing prior trajectory
 * or step artifacts. Call this before finalizing a trajectory when the final
 * execution output produces new artifact references.
 */
export function appendTrajectoryArtifact(
  trajectoryId: string,
  input: TrajectoryArtifactRef
): TrajectoryArtifactRef {
  const artifact = trajectoryArtifactRefSchema.parse(input);
  const db = getDb();
  const append = db.transaction(() => {
    const trajectory = db
      .prepare("SELECT status FROM trajectories WHERE id = ?")
      .get(trajectoryId) as { status: TrajectoryStatus } | undefined;
    if (!trajectory) throw new Error(`trajectory not found: ${trajectoryId}`);
    if (TERMINAL_STATUSES.has(trajectory.status)) {
      throw new Error(`cannot append an artifact to terminal trajectory ${trajectoryId}`);
    }
    const position = db
      .prepare(
        `SELECT COALESCE(MAX(position), -1) + 1 AS position
           FROM trajectory_artifacts
          WHERE trajectory_id = ? AND owner_kind = 'trajectory'`
      )
      .get(trajectoryId) as { position: number };
    insertArtifacts(db, trajectoryId, null, [artifact], position.position);
    db.prepare("UPDATE trajectories SET updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      trajectoryId
    );
    const reconstructed = reconstructTrajectory(db, trajectoryId);
    if (!reconstructed) {
      throw new Error(`trajectory disappeared during artifact append: ${trajectoryId}`);
    }
    return reconstructed.artifacts[reconstructed.artifacts.length - 1];
  });
  return append();
}

export type TrajectoryMetadataUpdate = Record<string, unknown>;

/**
 * Validate and persist mutable top-level metadata without updating any step or
 * artifact row. Additive v1 fields are stored in `extensions_json`.
 */
export function updateTrajectoryMetadata(
  trajectoryId: string,
  update: TrajectoryMetadataUpdate
): CanonicalTrajectoryV1 {
  for (const key of Object.keys(update)) {
    if (IMMUTABLE_METADATA_KEYS.has(key)) {
      throw new Error(`trajectory metadata field ${key} is immutable`);
    }
  }

  const db = getDb();
  const apply = db.transaction(() => {
    const current = reconstructTrajectory(db, trajectoryId);
    if (!current) throw new Error(`trajectory not found: ${trajectoryId}`);
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new Error(`terminal trajectory metadata is immutable: ${trajectoryId}`);
    }
    const candidate = canonicalTrajectorySchema.parse({ ...current, ...update });
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE trajectories
          SET status = ?, title = ?, summary = ?, completed_at = ?,
              duration_ms = ?, input = ?, output = ?, model_usage = ?,
              error = ?, labels = ?, attributes = ?, extensions = ?, updated_at = ?
        WHERE id = ?`
    ).run(
      candidate.status,
      candidate.title ?? null,
      candidate.summary ?? null,
      candidate.completedAt ?? null,
      candidate.durationMs ?? null,
      serializeOptionalJson(candidate.input),
      serializeOptionalJson(candidate.output),
      serializeJson(candidate.modelUsage),
      serializeOptionalJson(candidate.error),
      serializeJson(candidate.labels),
      serializeJson(candidate.attributes),
      serializeJson(extensionsOf(candidate as Record<string, unknown>, TRAJECTORY_KEYS)),
      now,
      trajectoryId
    );
    return candidate;
  });
  apply();
  return reconstructTrajectory(db, trajectoryId)!;
}

export interface MarkTrajectoryInterruptedInput {
  status: "failed" | "aborted";
  completedAt?: string;
  durationMs?: number;
  error?: TrajectoryError;
  summary?: string;
}

/** Mark an in-flight trajectory failed/aborted while retaining every raw step row. */
export function markTrajectoryInterrupted(
  trajectoryId: string,
  input: MarkTrajectoryInterruptedInput
): CanonicalTrajectoryV1 {
  if (input.status === "failed" && input.error === undefined) {
    throw new Error("failed interruption requires error details");
  }
  const completedAt = input.completedAt ?? new Date().toISOString();
  const error = input.error === undefined ? undefined : trajectoryErrorSchema.parse(input.error);
  return updateTrajectoryMetadata(trajectoryId, {
    status: input.status,
    completedAt,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(error === undefined ? {} : { error }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
  });
}

export interface TrajectoryPruneResult {
  trajectories: number;
  steps: number;
  artifacts: number;
}

/** Delete only terminal trajectories completed before the requested retention horizon. */
export function pruneTerminalTrajectories(
  olderThanMs: number,
  nowMs = Date.now()
): TrajectoryPruneResult {
  assertNonnegativeFiniteDuration(olderThanMs, "olderThanMs");
  if (!Number.isFinite(nowMs)) throw new RangeError("nowMs must be finite");
  const cutoff = new Date(nowMs - olderThanMs).toISOString();
  const db = getDb();
  const prune = db.transaction(() => {
    const eligibility = `
      status IN ('completed', 'failed', 'aborted', 'round-limited')
      AND completed_at IS NOT NULL
      AND julianday(completed_at) < julianday(?)`;
    const trajectories = db
      .prepare(`SELECT COUNT(*) AS count FROM trajectories WHERE ${eligibility}`)
      .get(cutoff) as { count: number };
    if (trajectories.count === 0) return { trajectories: 0, steps: 0, artifacts: 0 };
    const steps = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM trajectory_steps AS step
          WHERE EXISTS (
            SELECT 1 FROM trajectories AS trajectory
             WHERE trajectory.id = step.trajectory_id AND ${eligibility}
          )`
      )
      .get(cutoff) as { count: number };
    const artifacts = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM trajectory_artifacts AS artifact
          WHERE EXISTS (
            SELECT 1 FROM trajectories AS trajectory
             WHERE trajectory.id = artifact.trajectory_id AND ${eligibility}
          )`
      )
      .get(cutoff) as { count: number };
    const deleted = db.prepare(`DELETE FROM trajectories WHERE ${eligibility}`).run(cutoff);
    return {
      trajectories: Number(deleted.changes),
      steps: steps.count,
      artifacts: artifacts.count,
    };
  });
  return prune();
}
