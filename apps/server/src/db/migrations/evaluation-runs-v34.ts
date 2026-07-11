import type Database from "better-sqlite3";

/**
 * Create normalized immutable storage for completed evaluation reports.
 *
 * v34 intentionally treats reports as permanent local audit records. Retention/purge
 * must be introduced as an explicit later migration and privileged store operation.
 */
export function migrateEvaluationRunsV34(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE evaluation_runs (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
        schema_version INTEGER NOT NULL CHECK(schema_version BETWEEN 1 AND 1000),
        engine TEXT NOT NULL CHECK(length(engine) BETWEEN 1 AND 128),
        provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 128),
        model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 256),
        status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
        passed INTEGER NOT NULL CHECK(passed IN (0, 1)),
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 0 AND 2678400000),
        config_snapshot TEXT NOT NULL
          CHECK(json_valid(config_snapshot) AND json_type(config_snapshot) = 'object')
          CHECK(length(CAST(config_snapshot AS BLOB)) BETWEEN 2 AND 8388608),
        config_sha256 TEXT NOT NULL
          CHECK(length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^0-9a-f]*'),
        report_metadata TEXT NOT NULL
          CHECK(json_valid(report_metadata) AND json_type(report_metadata) = 'object')
          CHECK(length(CAST(report_metadata AS BLOB)) BETWEEN 2 AND 8388608),
        report_sha256 TEXT NOT NULL
          CHECK(length(report_sha256) = 64 AND report_sha256 NOT GLOB '*[^0-9a-f]*'),
        case_count INTEGER NOT NULL CHECK(case_count BETWEEN 1 AND 100),
        passed_case_count INTEGER NOT NULL CHECK(passed_case_count BETWEEN 0 AND case_count),
        failed_case_count INTEGER NOT NULL CHECK(failed_case_count BETWEEN 0 AND case_count),
        assertion_count INTEGER NOT NULL CHECK(assertion_count BETWEEN 1 AND 50000),
        passed_assertion_count INTEGER NOT NULL
          CHECK(passed_assertion_count BETWEEN 0 AND assertion_count),
        failed_assertion_count INTEGER NOT NULL
          CHECK(failed_assertion_count BETWEEN 0 AND assertion_count),
        input_tokens INTEGER NOT NULL CHECK(input_tokens BETWEEN 0 AND 9007199254740991),
        output_tokens INTEGER NOT NULL CHECK(output_tokens BETWEEN 0 AND 9007199254740991),
        cost_usd REAL CHECK(cost_usd IS NULL OR cost_usd BETWEEN 0 AND 1000000),
        total_latency_ms INTEGER NOT NULL CHECK(total_latency_ms BETWEEN 0 AND 360000000),
        CHECK(julianday(started_at) IS NOT NULL),
        CHECK(julianday(completed_at) IS NOT NULL),
        CHECK(julianday(completed_at) >= julianday(started_at)),
        CHECK(passed_case_count + failed_case_count = case_count),
        CHECK(passed_assertion_count + failed_assertion_count = assertion_count)
      );

      CREATE TABLE evaluation_run_cases (
        run_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 99),
        status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'aborted', 'round-limited')),
        passed INTEGER NOT NULL CHECK(passed IN (0, 1)),
        source_case_id TEXT CHECK(source_case_id IS NULL OR length(source_case_id) BETWEEN 1 AND 256),
        source_case_revision INTEGER CHECK(
          source_case_revision IS NULL OR source_case_revision BETWEEN 1 AND 2147483647
        ),
        case_snapshot TEXT NOT NULL
          CHECK(json_valid(case_snapshot) AND json_type(case_snapshot) = 'object')
          CHECK(length(CAST(case_snapshot AS BLOB)) BETWEEN 2 AND 1048576),
        case_sha256 TEXT NOT NULL
          CHECK(length(case_sha256) = 64 AND case_sha256 NOT GLOB '*[^0-9a-f]*'),
        result TEXT NOT NULL
          CHECK(json_valid(result) AND json_type(result) = 'object')
          CHECK(length(CAST(result AS BLOB)) BETWEEN 2 AND 8388608),
        assertions TEXT NOT NULL
          CHECK(json_valid(assertions) AND json_type(assertions) = 'array')
          CHECK(length(CAST(assertions AS BLOB)) BETWEEN 2 AND 2097152),
        assertion_count INTEGER NOT NULL CHECK(assertion_count BETWEEN 0 AND 10000),
        passed_assertion_count INTEGER NOT NULL
          CHECK(passed_assertion_count BETWEEN 0 AND assertion_count),
        failed_assertion_count INTEGER NOT NULL
          CHECK(failed_assertion_count BETWEEN 0 AND assertion_count),
        usage TEXT NOT NULL
          CHECK(json_valid(usage) AND json_type(usage) IN ('object', 'null'))
          CHECK(length(CAST(usage AS BLOB)) BETWEEN 2 AND 65536),
        input_tokens INTEGER NOT NULL CHECK(input_tokens BETWEEN 0 AND 9007199254740991),
        output_tokens INTEGER NOT NULL CHECK(output_tokens BETWEEN 0 AND 9007199254740991),
        cost_usd REAL CHECK(cost_usd IS NULL OR cost_usd BETWEEN 0 AND 10000),
        latency_ms INTEGER NOT NULL CHECK(latency_ms BETWEEN 0 AND 3600000),
        PRIMARY KEY(run_id, position),
        FOREIGN KEY(run_id) REFERENCES evaluation_runs(id) ON DELETE CASCADE,
        CHECK((source_case_id IS NULL) = (source_case_revision IS NULL)),
        CHECK(passed_assertion_count + failed_assertion_count = assertion_count)
      );

      CREATE INDEX idx_evaluation_runs_completed
        ON evaluation_runs(completed_at DESC, id DESC);
      CREATE INDEX idx_evaluation_run_cases_position
        ON evaluation_run_cases(run_id, position ASC);

      CREATE TRIGGER evaluation_runs_no_update
      BEFORE UPDATE ON evaluation_runs
      BEGIN
        SELECT RAISE(ABORT, 'completed evaluation run reports are immutable');
      END;

      CREATE TRIGGER evaluation_runs_no_delete
      BEFORE DELETE ON evaluation_runs
      BEGIN
        SELECT RAISE(ABORT, 'completed evaluation run reports are permanent');
      END;

      CREATE TRIGGER evaluation_run_cases_no_update
      BEFORE UPDATE ON evaluation_run_cases
      BEGIN
        SELECT RAISE(ABORT, 'completed evaluation run case reports are immutable');
      END;

      CREATE TRIGGER evaluation_run_cases_no_delete
      BEFORE DELETE ON evaluation_run_cases
      BEGIN
        SELECT RAISE(ABORT, 'completed evaluation run case reports are permanent');
      END;
    `);
    db.pragma("user_version = 34");
  });

  migrate();
}
