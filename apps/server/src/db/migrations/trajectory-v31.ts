import type Database from "better-sqlite3";

/** Create normalized, append-oriented storage for canonical v1 trajectories. */
export function migrateTrajectoryPersistenceV31(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE trajectories (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'running', 'waiting', 'completed', 'failed', 'aborted', 'round-limited'
        )),
        origin_kind TEXT NOT NULL CHECK(origin_kind IN (
          'web-chat', 'channel', 'schedule', 'webhook', 'daemon',
          'cognitive-loop', 'api', 'system', 'test'
        )),
        origin TEXT NOT NULL CHECK(json_valid(origin) AND json_type(origin) = 'object'),
        actor TEXT NOT NULL CHECK(json_valid(actor) AND json_type(actor) = 'object'),
        title TEXT,
        summary TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
        input TEXT CHECK(input IS NULL OR json_valid(input)),
        output TEXT CHECK(output IS NULL OR json_valid(output)),
        model_usage TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(model_usage) AND json_type(model_usage) = 'array'),
        error TEXT CHECK(error IS NULL OR (json_valid(error) AND json_type(error) = 'object')),
        labels TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(labels) AND json_type(labels) = 'array'),
        attributes TEXT NOT NULL DEFAULT '{}'
          CHECK(json_valid(attributes) AND json_type(attributes) = 'object'),
        extensions TEXT NOT NULL DEFAULT '{}'
          CHECK(json_valid(extensions) AND json_type(extensions) = 'object'),
        next_sequence INTEGER NOT NULL DEFAULT 0 CHECK(next_sequence >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(julianday(started_at) IS NOT NULL),
        CHECK(julianday(created_at) IS NOT NULL),
        CHECK(julianday(updated_at) IS NOT NULL),
        CHECK(completed_at IS NULL OR (
          julianday(completed_at) IS NOT NULL AND
          julianday(completed_at) >= julianday(started_at)
        )),
        CHECK(status NOT IN ('completed', 'failed', 'aborted', 'round-limited') OR completed_at IS NOT NULL),
        CHECK(status != 'failed' OR error IS NOT NULL)
      );

      CREATE TABLE trajectory_steps (
        id TEXT PRIMARY KEY,
        trajectory_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        parent_step_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN (
          'trajectory.started', 'context.assembled', 'model.request', 'model.response',
          'reasoning', 'tool.call', 'tool.result', 'approval.requested',
          'approval.resolved', 'memory.read', 'memory.write', 'message.output',
          'checkpoint', 'trajectory.completed', 'trajectory.failed', 'custom'
        )),
        custom_type TEXT,
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'running', 'waiting', 'completed', 'failed', 'skipped', 'aborted'
        )),
        name TEXT,
        actor TEXT CHECK(actor IS NULL OR (json_valid(actor) AND json_type(actor) = 'object')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
        input TEXT CHECK(input IS NULL OR json_valid(input)),
        output TEXT CHECK(output IS NULL OR json_valid(output)),
        model_usage TEXT
          CHECK(model_usage IS NULL OR (json_valid(model_usage) AND json_type(model_usage) = 'object')),
        tool_call TEXT
          CHECK(tool_call IS NULL OR (json_valid(tool_call) AND json_type(tool_call) = 'object')),
        approval TEXT
          CHECK(approval IS NULL OR (json_valid(approval) AND json_type(approval) = 'object')),
        error TEXT CHECK(error IS NULL OR (json_valid(error) AND json_type(error) = 'object')),
        attributes TEXT NOT NULL DEFAULT '{}'
          CHECK(json_valid(attributes) AND json_type(attributes) = 'object'),
        extensions TEXT NOT NULL DEFAULT '{}'
          CHECK(json_valid(extensions) AND json_type(extensions) = 'object'),
        created_at TEXT NOT NULL,
        UNIQUE(trajectory_id, sequence),
        UNIQUE(trajectory_id, id),
        FOREIGN KEY(trajectory_id) REFERENCES trajectories(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_step_id) REFERENCES trajectory_steps(id)
          ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
        CHECK(julianday(started_at) IS NOT NULL),
        CHECK(julianday(created_at) IS NOT NULL),
        CHECK(completed_at IS NULL OR (
          julianday(completed_at) IS NOT NULL AND
          julianday(completed_at) >= julianday(started_at)
        )),
        CHECK(status NOT IN ('completed', 'failed', 'skipped', 'aborted') OR completed_at IS NOT NULL),
        CHECK(status != 'failed' OR error IS NOT NULL),
        CHECK(kind != 'custom' OR custom_type IS NOT NULL),
        CHECK(kind NOT LIKE 'tool.%' OR tool_call IS NOT NULL),
        CHECK(kind NOT LIKE 'approval.%' OR approval IS NOT NULL),
        CHECK(kind NOT LIKE 'model.%' OR model_usage IS NOT NULL)
      );

      CREATE TABLE trajectory_artifacts (
        trajectory_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        step_id TEXT,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('trajectory', 'step')),
        position INTEGER NOT NULL CHECK(position >= 0),
        kind TEXT NOT NULL CHECK(kind IN ('media', 'file', 'log', 'trace', 'ui', 'other')),
        name TEXT,
        media_type TEXT,
        locator TEXT,
        size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),
        sha256 TEXT CHECK(sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-fA-F]*')),
        extensions TEXT NOT NULL DEFAULT '{}'
          CHECK(json_valid(extensions) AND json_type(extensions) = 'object'),
        created_at TEXT NOT NULL,
        PRIMARY KEY(trajectory_id, artifact_id),
        FOREIGN KEY(trajectory_id) REFERENCES trajectories(id) ON DELETE CASCADE,
        FOREIGN KEY(trajectory_id, step_id)
          REFERENCES trajectory_steps(trajectory_id, id) ON DELETE CASCADE,
        CHECK(julianday(created_at) IS NOT NULL),
        CHECK(
          (owner_kind = 'trajectory' AND step_id IS NULL) OR
          (owner_kind = 'step' AND step_id IS NOT NULL)
        )
      );

      CREATE INDEX idx_trajectories_status_updated
        ON trajectories(status, updated_at DESC);
      CREATE INDEX idx_trajectories_origin_started
        ON trajectories(origin_kind, started_at DESC);
      CREATE INDEX idx_trajectories_started
        ON trajectories(started_at DESC);
      CREATE INDEX idx_trajectories_completed
        ON trajectories(completed_at DESC) WHERE completed_at IS NOT NULL;
      CREATE INDEX idx_trajectory_steps_status_started
        ON trajectory_steps(status, started_at DESC);
      CREATE INDEX idx_trajectory_steps_trajectory_started
        ON trajectory_steps(trajectory_id, started_at ASC);
      CREATE INDEX idx_trajectory_artifacts_step
        ON trajectory_artifacts(trajectory_id, step_id, position)
        WHERE step_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_trajectory_artifacts_trajectory_position
        ON trajectory_artifacts(trajectory_id, position)
        WHERE owner_kind = 'trajectory';
      CREATE UNIQUE INDEX idx_trajectory_artifacts_step_position
        ON trajectory_artifacts(trajectory_id, step_id, position)
        WHERE owner_kind = 'step';

      CREATE TRIGGER trajectory_steps_no_update
      BEFORE UPDATE ON trajectory_steps
      BEGIN
        SELECT RAISE(ABORT, 'trajectory steps are append-only');
      END;

      CREATE TRIGGER trajectory_steps_no_delete
      BEFORE DELETE ON trajectory_steps
      WHEN EXISTS (SELECT 1 FROM trajectories WHERE id = OLD.trajectory_id)
      BEGIN
        SELECT RAISE(ABORT, 'trajectory steps are append-only');
      END;
    `);
    db.pragma("user_version = 31");
  });

  migrate();
}
