import type Database from "better-sqlite3";

/** Create versioned local storage for portable evaluation-case documents. */
export function migrateEvaluationCasesV33(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE evaluation_cases (
        id TEXT PRIMARY KEY,
        current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(julianday(created_at) IS NOT NULL),
        CHECK(julianday(updated_at) IS NOT NULL),
        CHECK(julianday(updated_at) >= julianday(created_at)),
        FOREIGN KEY(id, current_revision)
          REFERENCES evaluation_case_revisions(case_id, revision)
          DEFERRABLE INITIALLY DEFERRED
      );

      CREATE TABLE evaluation_case_revisions (
        case_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        document TEXT NOT NULL
          CHECK(json_valid(document) AND json_type(document) = 'object'),
        created_at TEXT NOT NULL,
        PRIMARY KEY(case_id, revision),
        FOREIGN KEY(case_id) REFERENCES evaluation_cases(id) ON DELETE CASCADE,
        CHECK(julianday(created_at) IS NOT NULL)
      );

      CREATE INDEX idx_evaluation_cases_updated
        ON evaluation_cases(updated_at DESC, id DESC);
      CREATE INDEX idx_evaluation_case_revisions_case
        ON evaluation_case_revisions(case_id, revision DESC);

      CREATE TRIGGER evaluation_case_revisions_no_update
      BEFORE UPDATE ON evaluation_case_revisions
      BEGIN
        SELECT RAISE(ABORT, 'evaluation case revisions are immutable');
      END;

      CREATE TRIGGER evaluation_case_revisions_no_delete
      BEFORE DELETE ON evaluation_case_revisions
      WHEN EXISTS (SELECT 1 FROM evaluation_cases WHERE id = OLD.case_id)
      BEGIN
        SELECT RAISE(ABORT, 'evaluation case revisions are immutable');
      END;
    `);
    db.pragma("user_version = 33");
  });

  migrate();
}
