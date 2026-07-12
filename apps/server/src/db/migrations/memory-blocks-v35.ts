import type Database from "better-sqlite3";
import { safeParseMemoryBlockDocument } from "@chvor/shared";

/** Register the deterministic scalar used by v35 character-budget checks. */
export function registerMemoryBlockSqlFunctions(db: Database.Database): void {
  db.function("memory_block_character_count", { deterministic: true }, (value: unknown) =>
    typeof value === "string" ? Array.from(value).length : null
  );
  db.function("memory_block_valid_document", { deterministic: true }, (value: unknown) => {
    if (typeof value !== "string") return 0;
    try {
      return safeParseMemoryBlockDocument(JSON.parse(value) as unknown).success ? 1 : 0;
    } catch {
      return 0;
    }
  });
}

/** Persist bounded stable memory blocks as immutable, auditable snapshots. */
export function migrateMemoryBlocksV35(db: Database.Database): void {
  registerMemoryBlockSqlFunctions(db);
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE memory_blocks (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
        layer TEXT NOT NULL CHECK(layer IN ('identity', 'human', 'procedural')),
        managed_by TEXT NOT NULL CHECK(managed_by IN ('user', 'agent')),
        current_revision INTEGER NOT NULL
          CHECK(current_revision BETWEEN 1 AND 2147483647),
        created_at TEXT NOT NULL CHECK(
          length(created_at) BETWEEN 20 AND 32 AND julianday(created_at) IS NOT NULL
        ),
        updated_at TEXT NOT NULL CHECK(
          length(updated_at) BETWEEN 20 AND 32 AND julianday(updated_at) IS NOT NULL
        ),
        CHECK(layer = 'procedural' OR managed_by = 'user'),
        CHECK(julianday(updated_at) >= julianday(created_at)),
        FOREIGN KEY(id, current_revision)
          REFERENCES memory_block_revisions(block_id, revision)
          DEFERRABLE INITIALLY DEFERRED
      );

      CREATE TABLE memory_block_revisions (
        block_id TEXT NOT NULL CHECK(length(block_id) BETWEEN 1 AND 256),
        revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
        operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'restore')),
        actor_type TEXT NOT NULL CHECK(actor_type IN (
          'user', 'session', 'apikey', 'agent', 'channel', 'schedule',
          'daemon', 'webhook', 'system', 'test'
        )),
        actor_id TEXT CHECK(actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 256),
        restored_from_revision INTEGER CHECK(
          restored_from_revision IS NULL OR
          restored_from_revision BETWEEN 1 AND 2147483647
        ),
        snapshot TEXT NOT NULL
          CHECK(json_valid(snapshot) AND json_type(snapshot) = 'object')
          CHECK(memory_block_valid_document(snapshot) = 1)
          CHECK(length(CAST(snapshot AS BLOB)) BETWEEN 2 AND 4194304)
          CHECK(json_type(snapshot, '$.schemaVersion') = 'integer')
          CHECK(json_extract(snapshot, '$.schemaVersion') = 1)
          CHECK(json_type(snapshot, '$.layer') = 'text')
          CHECK(json_extract(snapshot, '$.layer') IN ('identity', 'human', 'procedural'))
          CHECK(json_type(snapshot, '$.managedBy') = 'text')
          CHECK(json_extract(snapshot, '$.managedBy') IN ('user', 'agent'))
          CHECK(
            json_extract(snapshot, '$.layer') = 'procedural' OR
            json_extract(snapshot, '$.managedBy') = 'user'
          )
          CHECK(
            json_type(snapshot, '$.label') = 'text' AND
            length(json_extract(snapshot, '$.label')) BETWEEN 1 AND 256
          )
          CHECK(
            json_type(snapshot, '$.description') IS NOT NULL AND
            (json_type(snapshot, '$.description') = 'null' OR
            (json_type(snapshot, '$.description') = 'text' AND
             length(json_extract(snapshot, '$.description')) <= 4096))
          )
          CHECK(json_type(snapshot, '$.content') = 'text')
          CHECK(
            json_type(snapshot, '$.characterBudget') = 'object' AND
            json_type(snapshot, '$.characterBudget.unit') = 'text' AND
            json_extract(snapshot, '$.characterBudget.unit') = 'characters' AND
            json_type(snapshot, '$.characterBudget.limit') = 'integer' AND
            json_extract(snapshot, '$.characterBudget.limit') BETWEEN 1 AND 1000000 AND
            json_remove(
              json_extract(snapshot, '$.characterBudget'), '$.unit', '$.limit'
            ) = '{}'
          )
          CHECK(
            memory_block_character_count(json_extract(snapshot, '$.content')) <=
            json_extract(snapshot, '$.characterBudget.limit')
          )
          CHECK(
            json_type(snapshot, '$.declaredOrder') = 'integer' AND
            json_extract(snapshot, '$.declaredOrder') BETWEEN 0 AND 2147483647
          )
          CHECK(
            (json_extract(snapshot, '$.layer') = 'procedural' AND
             json_type(snapshot, '$.proceduralPriority') = 'text' AND
             json_extract(snapshot, '$.proceduralPriority') IN ('required', 'optional')) OR
            (json_extract(snapshot, '$.layer') IN ('identity', 'human') AND
             json_type(snapshot, '$.proceduralPriority') IS NULL)
          )
          CHECK(json_type(snapshot, '$.readOnly') IN ('true', 'false'))
          CHECK(
            json_type(snapshot, '$.confidence') IN ('integer', 'real') AND
            json_extract(snapshot, '$.confidence') BETWEEN 0.0 AND 1.0
          )
          CHECK(
            json_type(snapshot, '$.provenance') = 'object' AND
            length(CAST(json_extract(snapshot, '$.provenance') AS BLOB)) BETWEEN 2 AND 65536
          )
          CHECK(
            json_type(snapshot, '$.verifiedAt') IS NOT NULL AND
            (json_type(snapshot, '$.verifiedAt') = 'null' OR
            (json_type(snapshot, '$.verifiedAt') = 'text' AND
             length(json_extract(snapshot, '$.verifiedAt')) BETWEEN 20 AND 32 AND
             julianday(json_extract(snapshot, '$.verifiedAt')) IS NOT NULL))
          ),
        created_at TEXT NOT NULL CHECK(
          length(created_at) BETWEEN 20 AND 32 AND julianday(created_at) IS NOT NULL
        ),
        PRIMARY KEY(block_id, revision),
        FOREIGN KEY(block_id) REFERENCES memory_blocks(id) ON DELETE CASCADE,
        FOREIGN KEY(block_id, restored_from_revision)
          REFERENCES memory_block_revisions(block_id, revision),
        CHECK(
          (operation = 'create' AND revision = 1 AND restored_from_revision IS NULL) OR
          (operation = 'update' AND revision > 1 AND restored_from_revision IS NULL) OR
          (operation = 'restore' AND revision > 1 AND
           restored_from_revision IS NOT NULL AND restored_from_revision < revision - 1)
        )
      );

      CREATE INDEX idx_memory_blocks_layer_order
        ON memory_blocks(layer, updated_at DESC, id DESC);
      CREATE INDEX idx_memory_blocks_updated_order
        ON memory_blocks(updated_at DESC, id DESC);
      CREATE INDEX idx_memory_block_revisions_block
        ON memory_block_revisions(block_id, revision DESC);
      CREATE INDEX idx_memory_block_revisions_actor
        ON memory_block_revisions(actor_type, actor_id, created_at DESC);

      CREATE TRIGGER memory_block_revisions_validate_snapshot
      BEFORE INSERT ON memory_block_revisions
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM json_each(NEW.snapshot)
          WHERE key NOT IN (
            'schemaVersion', 'layer', 'managedBy', 'label', 'description', 'content',
            'characterBudget', 'declaredOrder', 'proceduralPriority',
            'readOnly', 'confidence', 'provenance', 'verifiedAt'
          )
        ) THEN RAISE(ABORT, 'memory block snapshot contains unknown fields') END;

        SELECT CASE WHEN (
          SELECT count(*) FROM json_each(NEW.snapshot)
        ) != CASE json_extract(NEW.snapshot, '$.layer')
          WHEN 'procedural' THEN 13 ELSE 12 END
        THEN RAISE(ABORT, 'memory block snapshot fields are incomplete or duplicated') END;

        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM memory_blocks b
          WHERE b.id = NEW.block_id AND (
            b.layer != json_extract(NEW.snapshot, '$.layer') OR
            b.managed_by != json_extract(NEW.snapshot, '$.managedBy') OR
            (NEW.revision = 1 AND b.current_revision != 1) OR
            (NEW.revision > 1 AND NEW.revision != b.current_revision + 1)
          )
        ) THEN RAISE(ABORT, 'memory block revision is inconsistent with current snapshot') END;

        SELECT CASE WHEN NEW.revision = 1 AND NEW.operation != 'create'
        THEN RAISE(ABORT, 'first memory block revision must be a create') END;

        SELECT CASE WHEN NEW.actor_type IN (
          'apikey', 'agent', 'channel', 'schedule', 'daemon', 'webhook'
        ) AND
          json_extract(NEW.snapshot, '$.managedBy') != 'agent'
        THEN RAISE(ABORT, 'agent cannot revise a user-managed memory block') END;

        SELECT CASE WHEN NEW.actor_type IN (
          'apikey', 'agent', 'channel', 'schedule', 'daemon', 'webhook'
        ) AND NEW.revision > 1 AND EXISTS (
          SELECT 1
          FROM memory_blocks b
          JOIN memory_block_revisions current
            ON current.block_id = b.id AND current.revision = b.current_revision
          WHERE b.id = NEW.block_id
            AND json_extract(current.snapshot, '$.readOnly') = 1
        ) THEN RAISE(ABORT, 'agent cannot alter a read-only memory block') END;

        SELECT CASE WHEN NEW.operation = 'restore' AND NOT EXISTS (
          SELECT 1 FROM memory_block_revisions restored
          WHERE restored.block_id = NEW.block_id
            AND restored.revision = NEW.restored_from_revision
            AND restored.snapshot = NEW.snapshot
        ) THEN RAISE(ABORT, 'restore snapshot must match the restored revision') END;
      END;

      CREATE TRIGGER memory_blocks_validate_insert
      AFTER INSERT ON memory_blocks
      WHEN EXISTS (
        SELECT 1 FROM memory_block_revisions
        WHERE block_id = NEW.id AND revision = NEW.current_revision
      )
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM memory_block_revisions r
          WHERE r.block_id = NEW.id AND r.revision = NEW.current_revision AND (
            json_extract(r.snapshot, '$.layer') != NEW.layer OR
            json_extract(r.snapshot, '$.managedBy') != NEW.managed_by
          )
        ) THEN RAISE(ABORT, 'memory block current snapshot is inconsistent') END;
      END;

      CREATE TRIGGER memory_blocks_validate_update
      BEFORE UPDATE ON memory_blocks
      BEGIN
        SELECT CASE WHEN NEW.id != OLD.id OR NEW.layer != OLD.layer OR
          NEW.managed_by != OLD.managed_by OR NEW.created_at != OLD.created_at
        THEN RAISE(ABORT, 'memory block identity fields are immutable') END;

        SELECT CASE WHEN NEW.current_revision != OLD.current_revision + 1
        THEN RAISE(ABORT, 'memory block current revision must advance by one') END;

        SELECT CASE WHEN julianday(NEW.updated_at) < julianday(OLD.updated_at)
        THEN RAISE(ABORT, 'memory block updated timestamp cannot move backwards') END;

        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM memory_block_revisions r
          WHERE r.block_id = NEW.id AND r.revision = NEW.current_revision
            AND json_extract(r.snapshot, '$.layer') = NEW.layer
            AND json_extract(r.snapshot, '$.managedBy') = NEW.managed_by
        ) THEN RAISE(ABORT, 'memory block current snapshot is inconsistent') END;
      END;

      CREATE TRIGGER memory_blocks_no_delete
      BEFORE DELETE ON memory_blocks
      BEGIN
        SELECT RAISE(ABORT, 'memory blocks and their revisions are immutable');
      END;

      CREATE TRIGGER memory_block_revisions_no_update
      BEFORE UPDATE ON memory_block_revisions
      BEGIN
        SELECT RAISE(ABORT, 'memory block revisions are immutable');
      END;

      CREATE TRIGGER memory_block_revisions_no_delete
      BEFORE DELETE ON memory_block_revisions
      WHEN EXISTS (SELECT 1 FROM memory_blocks WHERE id = OLD.block_id)
      BEGIN
        SELECT RAISE(ABORT, 'memory block revisions are immutable');
      END;
    `);

    db.pragma("user_version = 35");
  });

  migrate();
}
