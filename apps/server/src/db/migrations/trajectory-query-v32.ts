import type Database from "better-sqlite3";
import { trajectoryTimestampKey } from "../../lib/trajectory-time.ts";

/** Support chronological trajectory keyset queries without a full-table sort. */
export function migrateTrajectoryQueryIndexV32(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec("ALTER TABLE trajectories ADD COLUMN started_at_key TEXT");
    const rows = db.prepare("SELECT id, started_at FROM trajectories").all() as Array<{
      id: string;
      started_at: string;
    }>;
    const update = db.prepare("UPDATE trajectories SET started_at_key = ? WHERE id = ?");
    for (const row of rows) update.run(trajectoryTimestampKey(row.started_at), row.id);
    db.exec(`
      CREATE INDEX idx_trajectories_started_key
        ON trajectories(started_at_key DESC, id DESC);
      CREATE TRIGGER trajectories_started_at_key_required
      BEFORE INSERT ON trajectories
      WHEN NEW.started_at_key IS NULL OR NEW.started_at_key = ''
      BEGIN
        SELECT RAISE(ABORT, 'trajectory started_at_key is required');
      END;
    `);
    db.pragma("user_version = 32");
  });

  migrate();
}
