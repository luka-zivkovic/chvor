import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-memory-blocks-"));
process.env.CHVOR_DATA_DIR = dataDir;

let store: typeof import("../memory-block-store.ts");
let getDb: typeof import("../database.ts").getDb;
let closeDb: typeof import("../database.ts").closeDb;
let runMigrations: typeof import("../migrations.ts").runMigrations;

type Document = import("../memory-block-store.ts").MemoryBlockDocumentV1;
type Actor = import("../memory-block-store.ts").MemoryBlockActor;

const USER: Actor = { actorType: "session", actorId: "session-1" };
const AGENT: Actor = { actorType: "apikey", actorId: "api-key-1" };

function document(label = "Human profile", overrides: Record<string, unknown> = {}): Document {
  const layer = (overrides.layer ?? "human") as Document["layer"];
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    layer,
    managedBy: overrides.managedBy ?? "user",
    label,
    description: "Stable context",
    content: "Prefers concise answers",
    characterBudget: { unit: "characters", limit: 200 },
    declaredOrder: 10,
    readOnly: false,
    confidence: 0.9,
    provenance: {
      kind: "stated",
      source: { type: "session", id: "session-1" },
    },
    verifiedAt: null,
    ...overrides,
  };
  if (layer === "procedural" && !("proceduralPriority" in base)) {
    base.proceduralPriority = "required";
  }
  if (layer !== "procedural") delete base.proceduralPriority;
  return base as unknown as Document;
}

function clearMemoryBlocks(): void {
  const db = getDb();
  db.exec("DROP TRIGGER memory_blocks_no_delete");
  db.prepare("DELETE FROM memory_blocks").run();
  db.exec(`
    CREATE TRIGGER memory_blocks_no_delete
    BEFORE DELETE ON memory_blocks
    BEGIN
      SELECT RAISE(ABORT, 'memory blocks and their revisions are immutable');
    END;
  `);
}

beforeAll(async () => {
  store = await import("../memory-block-store.ts");
  ({ getDb, closeDb } = await import("../database.ts"));
  ({ runMigrations } = await import("../migrations.ts"));
});

beforeEach(() => {
  clearMemoryBlocks();
});

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("memory-block migration v35", () => {
  it("creates bounded identity and immutable revision tables on fresh databases", () => {
    const db = getDb();
    expect(db.pragma("user_version", { simple: true })).toBe(36);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_block%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual(["memory_block_revisions", "memory_blocks"]);
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_block%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(triggers.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "memory_block_revisions_no_delete",
        "memory_block_revisions_no_update",
        "memory_block_revisions_validate_snapshot",
        "memory_blocks_no_delete",
        "memory_blocks_validate_update",
      ])
    );
    const queryPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT b.id, r.snapshot
           FROM memory_blocks b
           JOIN memory_block_revisions r
             ON r.block_id = b.id AND r.revision = b.current_revision
          ORDER BY b.updated_at DESC, b.id DESC LIMIT ?`
      )
      .all(21) as Array<{ detail: string }>;
    expect(queryPlan.map(({ detail }) => detail).join("\n")).toContain(
      "idx_memory_blocks_updated_order"
    );
    expect(queryPlan.map(({ detail }) => detail).join("\n")).not.toContain(
      "USE TEMP B-TREE FOR ORDER BY"
    );
  });

  it("upgrades v34 databases and is idempotent after the version bump", () => {
    const migrationDir = mkdtempSync(join(tmpdir(), "chvor-v34-v35-"));
    const db = new Database(join(migrationDir, "migration.db"));
    try {
      db.pragma("foreign_keys = ON");
      db.pragma("user_version = 34");
      runMigrations(db, false);
      expect(db.pragma("user_version", { simple: true })).toBe(36);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)"
          )
          .get("memory_blocks", "memory_block_revisions")
      ).toEqual({ count: 2 });
      expect(() => runMigrations(db, false)).not.toThrow();
    } finally {
      db.close();
      rmSync(migrationDir, { recursive: true, force: true });
    }
  });

  it("enforces strict snapshots and Unicode character budgets in SQL", () => {
    const db = getDb();
    const created = store.createMemoryBlock(document("Raw SQL base"), USER);
    const now = new Date().toISOString();
    const snapshot = document("SQL budget", {
      content: "😀😀",
      characterBudget: { unit: "characters", limit: 1 },
    });
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_block_revisions
             (block_id, revision, operation, actor_type, actor_id, snapshot, created_at)
           VALUES (?, 2, 'update', 'session', 'session-1', ?, ?)`
        )
        .run(created.id, JSON.stringify(snapshot), now)
    ).toThrow(/character budget|CHECK constraint/);

    const nulSnapshot = document("SQL NUL budget", {
      content: "A\0😀",
      characterBudget: { unit: "characters", limit: 2 },
    });
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_block_revisions
             (block_id, revision, operation, actor_type, actor_id, snapshot, created_at)
           VALUES (?, 2, 'update', 'session', 'session-1', ?, ?)`
        )
        .run(created.id, JSON.stringify(nulSnapshot), now)
    ).toThrow(/character budget|CHECK constraint/);

    const extraField = { ...document("Strict SQL"), unexpected: true };
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_block_revisions
             (block_id, revision, operation, actor_type, actor_id, snapshot, created_at)
           VALUES (?, 2, 'update', 'session', 'session-1', ?, ?)`
        )
        .run(created.id, JSON.stringify(extraField), now)
    ).toThrow(/unknown fields/);

    const whitespaceLabel = document("   ");
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_block_revisions
             (block_id, revision, operation, actor_type, actor_id, snapshot, created_at)
           VALUES (?, 2, 'update', 'session', 'session-1', ?, ?)`
        )
        .run(created.id, JSON.stringify(whitespaceLabel), now)
    ).toThrow(/CHECK constraint/);
  });
});

describe("memory-block store", () => {
  it("persists only allowed stable layer and manager combinations", () => {
    const records = [
      store.createMemoryBlock(document("Identity", { layer: "identity" }), USER),
      store.createMemoryBlock(document("Human"), USER),
      store.createMemoryBlock(
        document("User procedure", {
          layer: "procedural",
          managedBy: "user",
          proceduralPriority: "required",
        }),
        USER
      ),
      store.createMemoryBlock(
        document("Agent procedure", {
          layer: "procedural",
          managedBy: "agent",
          proceduralPriority: "optional",
        }),
        AGENT
      ),
    ];
    expect(records.map(({ revision }) => revision)).toEqual([1, 1, 1, 1]);
    expect(records.map(({ operation }) => operation)).toEqual([
      "create",
      "create",
      "create",
      "create",
    ]);
    expect(records[3].actor).toEqual(AGENT);
    expect(store.getMemoryBlock(records[0].id)).toEqual(records[0]);
    expect(store.listMemoryBlocks().records).toHaveLength(4);

    expect(() =>
      store.createMemoryBlock(
        document("Invalid identity", { layer: "identity", managedBy: "agent" }),
        USER
      )
    ).toThrow(store.MemoryBlockValidationError);
    expect(() =>
      store.createMemoryBlock(
        document("Invalid agent write", {
          layer: "procedural",
          managedBy: "user",
          proceduralPriority: "required",
        }),
        AGENT
      )
    ).toThrow(store.MemoryBlockForbiddenError);
    expect(() =>
      store.createMemoryBlock({ ...document(), proceduralPriority: "optional" }, USER)
    ).toThrow(store.MemoryBlockValidationError);
  });

  it("counts Unicode code points deterministically at the exact budget boundary", () => {
    expect("😀".length).toBe(2);
    expect(store.memoryBlockCharacterCount("A😀é")).toBe(4);
    const created = store.createMemoryBlock(
      document("Unicode", {
        content: "😀😀",
        characterBudget: { unit: "characters", limit: 2 },
      }),
      USER
    );
    expect(created.document.content).toBe("😀😀");
    expect(() =>
      store.createMemoryBlock(
        document("Over budget", {
          content: "😀😀😀",
          characterBudget: { unit: "characters", limit: 2 },
        }),
        USER
      )
    ).toThrow(/character budget/);
  });

  it("appends full update and restore snapshots with actor audit metadata", () => {
    const created = store.createMemoryBlock(document("First"), USER);
    const secondDocument = document("Second", {
      content: "Updated content",
      confidence: 0.75,
      verifiedAt: "2026-07-12T10:00:00.000Z",
    });
    const updated = store.updateMemoryBlock(created.id, 1, secondDocument, USER);
    expect(updated).toMatchObject({ revision: 2, operation: "update", actor: USER });
    const restored = store.restoreMemoryBlock(created.id, 2, 1, USER);
    expect(restored).toMatchObject({
      revision: 3,
      operation: "restore",
      actor: USER,
      restoredFromRevision: 1,
      document: created.document,
    });
    expect(store.getMemoryBlock(created.id)).toEqual(restored);
    expect(store.getMemoryBlockRevision(created.id, 2)?.document).toEqual(secondDocument);
    expect(
      store
        .listMemoryBlockRevisions(created.id)
        .revisions.map(({ revision, operation, restoredFromRevision }) => ({
          revision,
          operation,
          restoredFromRevision,
        }))
    ).toEqual([
      { revision: 3, operation: "restore", restoredFromRevision: 1 },
      { revision: 2, operation: "update", restoredFromRevision: null },
      { revision: 1, operation: "create", restoredFromRevision: null },
    ]);

    const raw = getDb()
      .prepare(
        "SELECT revision, snapshot FROM memory_block_revisions WHERE block_id = ? ORDER BY revision"
      )
      .all(created.id) as Array<{ revision: number; snapshot: string }>;
    expect(raw).toHaveLength(3);
    expect(JSON.parse(raw[0].snapshot)).toEqual(created.document);
    expect(JSON.parse(raw[1].snapshot)).toEqual(secondDocument);
    expect(JSON.parse(raw[2].snapshot)).toEqual(created.document);
  });

  it("rejects stale CAS writes atomically and keeps immutable revisions", () => {
    const created = store.createMemoryBlock(document("CAS one"), USER);
    store.updateMemoryBlock(created.id, 1, document("CAS two"), USER);
    expect(() => store.updateMemoryBlock(created.id, 1, document("Stale"), USER)).toThrow(
      store.MemoryBlockRevisionConflictError
    );
    expect(() => store.restoreMemoryBlock(created.id, 1, 1, USER)).toThrow(
      store.MemoryBlockRevisionConflictError
    );
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM memory_block_revisions WHERE block_id = ?")
        .get(created.id)
    ).toEqual({ count: 2 });

    expect(() =>
      getDb()
        .prepare(
          "UPDATE memory_block_revisions SET snapshot = snapshot WHERE block_id = ? AND revision = 1"
        )
        .run(created.id)
    ).toThrow(/immutable/);
    expect(() =>
      getDb()
        .prepare("DELETE FROM memory_block_revisions WHERE block_id = ? AND revision = 1")
        .run(created.id)
    ).toThrow(/immutable/);
    expect(() => getDb().prepare("DELETE FROM memory_blocks WHERE id = ?").run(created.id)).toThrow(
      /immutable/
    );
  });

  it("keeps layer and manager immutable and prevents agent changes to read-only blocks", () => {
    const identity = store.createMemoryBlock(document("Identity", { layer: "identity" }), USER);
    expect(() => store.updateMemoryBlock(identity.id, 1, document("Human now"), USER)).toThrow(
      store.MemoryBlockImmutableIdentityError
    );
    expect(() =>
      getDb().prepare("UPDATE memory_blocks SET layer = 'human' WHERE id = ?").run(identity.id)
    ).toThrow(/identity fields are immutable/);

    const procedure = store.createMemoryBlock(
      document("Procedure", {
        layer: "procedural",
        managedBy: "agent",
        proceduralPriority: "required",
      }),
      AGENT
    );
    const agentUpdated = store.updateMemoryBlock(
      procedure.id,
      1,
      document("Procedure v2", {
        layer: "procedural",
        managedBy: "agent",
        proceduralPriority: "required",
      }),
      AGENT
    );
    expect(agentUpdated.revision).toBe(2);
    expect(() =>
      store.updateMemoryBlock(
        procedure.id,
        2,
        document("Manager change", {
          layer: "procedural",
          managedBy: "user",
          proceduralPriority: "required",
        }),
        USER
      )
    ).toThrow(store.MemoryBlockImmutableIdentityError);

    const locked = store.updateMemoryBlock(
      procedure.id,
      2,
      document("Locked", {
        layer: "procedural",
        managedBy: "agent",
        proceduralPriority: "required",
        readOnly: true,
      }),
      USER
    );
    expect(() =>
      store.updateMemoryBlock(
        procedure.id,
        3,
        document("Agent edit", {
          layer: "procedural",
          managedBy: "agent",
          proceduralPriority: "required",
        }),
        AGENT
      )
    ).toThrow(store.MemoryBlockReadOnlyError);
    expect(() => store.restoreMemoryBlock(procedure.id, 3, 1, AGENT)).toThrow(
      store.MemoryBlockReadOnlyError
    );
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO memory_block_revisions
             (block_id, revision, operation, actor_type, actor_id, snapshot, created_at)
           VALUES (?, 4, 'update', 'apikey', 'api-key-1', ?, ?)`
        )
        .run(
          procedure.id,
          JSON.stringify(
            document("Raw agent bypass", {
              layer: "procedural",
              managedBy: "agent",
              proceduralPriority: "required",
            })
          ),
          new Date().toISOString()
        )
    ).toThrow(/read-only/);
    const userUnlocked = store.updateMemoryBlock(
      procedure.id,
      3,
      document("User correction", {
        layer: "procedural",
        managedBy: "agent",
        proceduralPriority: "required",
        readOnly: false,
      }),
      USER
    );
    expect(userUnlocked.revision).toBe(4);
    expect(locked.document.readOnly).toBe(true);
  });

  it("paginates blocks and revisions with bounded stable cursors", () => {
    const first = store.createMemoryBlock(document("First page"), USER);
    const second = store.createMemoryBlock(document("Second page"), USER);
    const firstPage = store.listMemoryBlocks(1);
    expect(firstPage.records).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = store.listMemoryBlocks(1, firstPage.nextCursor!);
    expect(secondPage.records).toHaveLength(1);
    expect(new Set([firstPage.records[0].id, secondPage.records[0].id])).toEqual(
      new Set([first.id, second.id])
    );
    expect(secondPage.nextCursor).toBeNull();

    store.updateMemoryBlock(first.id, 1, document("Revision 2"), USER);
    store.updateMemoryBlock(first.id, 2, document("Revision 3"), USER);
    const revisionPage = store.listMemoryBlockRevisions(first.id, 2);
    expect(revisionPage.revisions.map(({ revision }) => revision)).toEqual([3, 2]);
    expect(revisionPage.nextCursor).toBe(2);
    expect(
      store
        .listMemoryBlockRevisions(first.id, 2, revisionPage.nextCursor!)
        .revisions.map(({ revision }) => revision)
    ).toEqual([1]);

    expect(() => store.listMemoryBlocks(0)).toThrow(RangeError);
    expect(() => store.listMemoryBlocks(store.MEMORY_BLOCK_PAGE_MAX + 1)).toThrow(RangeError);
    expect(() => store.listMemoryBlocks(1, { updatedAt: "invalid", id: "cursor" })).toThrow(
      RangeError
    );
    expect(() => store.listMemoryBlockRevisions(first.id, 1, 0)).toThrow(RangeError);
  });

  it("reads current stable blocks in bounded canonical assembly order", () => {
    const procedural = store.createMemoryBlock(
      document("Procedure", {
        layer: "procedural",
        managedBy: "agent",
        declaredOrder: 0,
        proceduralPriority: "required",
      }),
      AGENT
    );
    const humanLater = store.createMemoryBlock(
      document("Human later", { declaredOrder: 20 }),
      USER
    );
    const identity = store.createMemoryBlock(
      document("Identity", { layer: "identity", declaredOrder: 99 }),
      USER
    );
    const humanTieA = store.createMemoryBlock(document("Human tie A", { declaredOrder: 10 }), USER);
    const humanTieB = store.createMemoryBlock(document("Human tie B", { declaredOrder: 10 }), USER);
    const tiedHumans = [humanTieA, humanTieB].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );

    expect(store.listMemoryBlocksForAssembly().map(({ id }) => id)).toEqual([
      identity.id,
      ...tiedHumans.map(({ id }) => id),
      humanLater.id,
      procedural.id,
    ]);
    expect(store.listMemoryBlocksForAssembly(2).map(({ id }) => id)).toEqual([
      identity.id,
      tiedHumans[0].id,
    ]);
    expect(() => store.listMemoryBlocksForAssembly(0)).toThrow(RangeError);
    expect(() => store.listMemoryBlocksForAssembly(store.MEMORY_BLOCK_ASSEMBLY_MAX + 1)).toThrow(
      RangeError
    );
  });

  it("detects corrupt stored snapshots at the read boundary", () => {
    const created = store.createMemoryBlock(document("Corruption"), USER);
    const db = getDb();
    const original = db
      .prepare("SELECT snapshot FROM memory_block_revisions WHERE block_id = ? AND revision = 1")
      .get(created.id) as { snapshot: string };
    db.exec("DROP TRIGGER memory_block_revisions_no_update");
    db.pragma("ignore_check_constraints = ON");
    try {
      db.prepare(
        "UPDATE memory_block_revisions SET snapshot = '{}' WHERE block_id = ? AND revision = 1"
      ).run(created.id);
      expect(() => store.getMemoryBlock(created.id)).toThrow(store.MemoryBlockCorruptionError);
    } finally {
      db.prepare(
        "UPDATE memory_block_revisions SET snapshot = ? WHERE block_id = ? AND revision = 1"
      ).run(original.snapshot, created.id);
      db.pragma("ignore_check_constraints = OFF");
      db.exec(`
        CREATE TRIGGER memory_block_revisions_no_update
        BEFORE UPDATE ON memory_block_revisions
        BEGIN
          SELECT RAISE(ABORT, 'memory block revisions are immutable');
        END;
      `);
    }
  });

  it("validates the v1 contract through the real HTTP route and store", async () => {
    const [{ chvorAuth }, routes, authStore] = await Promise.all([
      import("../../middleware/auth.ts"),
      import("../../routes/memory-blocks.ts"),
      import("../auth-store.ts"),
    ]);
    authStore.enableAuth();
    const token = authStore.createSession("memory-block-integration").token;
    const app = new Hono();
    app.use("/api/*", chvorAuth);
    app.route("/api/memory-blocks", routes.default);

    const valid = await app.request("/api/memory-blocks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ document: document("Real route") }),
    });
    expect(valid.status).toBe(201);
    await expect(valid.json()).resolves.toMatchObject({
      data: { memoryBlock: { revision: 1, document: { schemaVersion: 1 } } },
    });

    const missingVersion: Record<string, unknown> = { ...document("Missing version") };
    delete missingVersion.schemaVersion;
    const invalid = await app.request("/api/memory-blocks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ document: missingVersion }),
    });
    expect(invalid.status).toBe(400);
  });
});
