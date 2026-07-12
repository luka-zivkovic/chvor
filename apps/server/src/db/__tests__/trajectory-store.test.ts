import Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalTrajectoryStepV1, CanonicalTrajectoryV1 } from "@chvor/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-trajectories-"));
process.env.CHVOR_DATA_DIR = dataDir;

let store: typeof import("../trajectory-store.ts");
let getDb: typeof import("../database.ts").getDb;
let closeDb: typeof import("../database.ts").closeDb;
let runMigrations: typeof import("../migrations.ts").runMigrations;
let getRetentionConfig: typeof import("../config/retention.ts").getRetentionConfig;
let updateRetentionConfig: typeof import("../config/retention.ts").updateRetentionConfig;
let retentionRoute: typeof import("../../routes/retention.ts").default;
let runRetentionCleanup: typeof import("../../lib/session-cleanup.ts").runRetentionCleanup;

const STARTED_AT = "2026-01-01T00:00:00.000Z";
const COMPLETED_AT = "2026-01-01T00:01:00.000Z";
const SECRET = "persist-me-not-123456";

function trajectory(
  id: string,
  overrides: Partial<CanonicalTrajectoryV1> & Record<string, unknown> = {}
): CanonicalTrajectoryV1 {
  return {
    schemaVersion: 1,
    id,
    origin: { kind: "test" },
    actor: { type: "test", id: "trajectory-store-test" },
    status: "running",
    startedAt: STARTED_AT,
    modelUsage: [],
    steps: [],
    artifacts: [],
    labels: [],
    attributes: {},
    ...overrides,
  } as CanonicalTrajectoryV1;
}

function step(
  trajectoryId: string,
  sequence: number,
  overrides: Partial<CanonicalTrajectoryStepV1> & Record<string, unknown> = {}
): CanonicalTrajectoryStepV1 {
  return {
    id: `${trajectoryId}-step-${sequence}`,
    trajectoryId,
    sequence,
    kind: "reasoning",
    status: "completed",
    startedAt: new Date(Date.parse(STARTED_AT) + sequence * 1_000).toISOString(),
    completedAt: new Date(Date.parse(STARTED_AT) + sequence * 1_000 + 500).toISOString(),
    artifacts: [],
    attributes: {},
    ...overrides,
  } as CanonicalTrajectoryStepV1;
}

function scalarTextInTable(db: Database.Database, table: string): string {
  return JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
}

beforeAll(async () => {
  store = await import("../trajectory-store.ts");
  ({ getDb, closeDb } = await import("../database.ts"));
  ({ runMigrations } = await import("../migrations.ts"));
  ({ getRetentionConfig, updateRetentionConfig } = await import("../config/retention.ts"));
  ({ default: retentionRoute } = await import("../../routes/retention.ts"));
  ({ runRetentionCleanup } = await import("../../lib/session-cleanup.ts"));
});

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("trajectory migrations v31-v32", () => {
  it("creates normalized storage and chronological query indexes on a fresh database", () => {
    const db = getDb();
    expect(db.pragma("user_version", { simple: true })).toBe(35);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'trajector%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(tables.map(({ name }) => name)).toEqual([
      "trajectories",
      "trajectory_artifacts",
      "trajectory_steps",
    ]);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_trajector%' ORDER BY name"
      )
      .all() as { name: string }[];
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "idx_trajectories_completed",
        "idx_trajectories_started_key",
        "idx_trajectories_status_updated",
        "idx_trajectory_artifacts_step_position",
        "idx_trajectory_steps_trajectory_started",
      ])
    );

    const stepForeignKeys = db.pragma("foreign_key_list(trajectory_steps)") as Array<{
      table: string;
      on_delete: string;
    }>;
    expect(stepForeignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "trajectories", on_delete: "CASCADE" }),
      ])
    );
  });

  it("upgrades an explicit v30 database through current migrations without requiring older application tables", () => {
    const migrationDir = mkdtempSync(join(tmpdir(), "chvor-v30-v31-"));
    const databasePath = join(migrationDir, "migration.db");
    const db = new Database(databasePath);
    try {
      // runMigrations always performs these legacy ALTERs before checking
      // user_version, so a real v30 database necessarily has schedules.
      db.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY)");
      db.pragma("user_version = 30");
      runMigrations(db, false);

      expect(db.pragma("user_version", { simple: true })).toBe(35);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)"
          )
          .get("trajectories", "trajectory_steps", "trajectory_artifacts")
      ).toEqual({ count: 3 });
      expect(() => runMigrations(db, false)).not.toThrow();
      expect(db.pragma("user_version", { simple: true })).toBe(35);
    } finally {
      db.close();
      rmSync(migrationDir, { recursive: true, force: true });
    }
  });
});

describe("trajectory retention configuration", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM config WHERE key LIKE 'retention.%'").run();
  });

  it("defaults, persists, floors, and safely reads trajectory retention", () => {
    expect(getRetentionConfig().trajectoryMaxAgeDays).toBe(30);
    expect(updateRetentionConfig({ trajectoryMaxAgeDays: 12.9 }).trajectoryMaxAgeDays).toBe(12);
    expect(updateRetentionConfig({ trajectoryMaxAgeDays: 0 }).trajectoryMaxAgeDays).toBe(0);
    expect(() => updateRetentionConfig({ trajectoryMaxAgeDays: Number.POSITIVE_INFINITY })).toThrow(
      /finite non-negative/
    );

    getDb()
      .prepare("UPDATE config SET value = 'not-a-number' WHERE key = ?")
      .run("retention.trajectoryMaxAgeDays");
    expect(getRetentionConfig().trajectoryMaxAgeDays).toBe(30);
  });

  it("rejects malformed and invalid retention PATCH bodies", async () => {
    const app = new Hono().route("/", retentionRoute);
    const request = (body: string) =>
      app.request("/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
      });

    expect((await request("null")).status).toBe(400);
    expect((await request("{")).status).toBe(400);
    expect((await request('{"trajectoryMaxAgeDays":-1}')).status).toBe(400);
    expect((await request('{"trajectoryMaxAgeDays":"30"}')).status).toBe(400);
    expect((await request('{"archiveBeforeDelete":"false"}')).status).toBe(400);
    expect((await request('{"trajectoryMaxAgeDays":7.8}')).status).toBe(200);
    expect(getRetentionConfig().trajectoryMaxAgeDays).toBe(7);
  });
});

describe("canonical trajectory store", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM trajectories").run();
  });

  it("round-trips sanitized metadata, additive fields, steps, and deterministic artifacts", () => {
    const id = "round-trip";
    const created = store.createTrajectory(
      trajectory(id, {
        title: `password=${SECRET}`,
        input: { password: SECRET, safe: "retained" },
        labels: [`api_key=${SECRET}`, "safe-label"],
        futureMetadata: { safe: "top-level extension", accessToken: SECRET },
        artifacts: [
          {
            artifactId: "top-b",
            kind: "file",
            name: `secret=${SECRET}`,
            futureArtifactField: "top extension",
          },
          { artifactId: "top-a", kind: "trace", name: "second by position" },
        ],
      })
    );
    expect(created.steps).toEqual([]);
    expect(created.input).toEqual({ password: "[REDACTED]", safe: "retained" });
    expect(created.title).toBe("password=[REDACTED]");
    expect(created.labels).toEqual(["api_key=[REDACTED]", "safe-label"]);
    expect(created.futureMetadata).toEqual({
      safe: "top-level extension",
      accessToken: "[REDACTED]",
    });
    expect(created.artifacts.map(({ artifactId }) => artifactId)).toEqual(["top-b", "top-a"]);

    expect(
      store.appendTrajectoryArtifact(id, {
        artifactId: "top-final",
        kind: "ui",
        name: `api_key=${SECRET}`,
        finalArtifactMetadata: { password: SECRET, safe: "appended" },
      })
    ).toMatchObject({
      artifactId: "top-final",
      name: "api_key=[REDACTED]",
      finalArtifactMetadata: { password: "[REDACTED]", safe: "appended" },
    });
    expect(() =>
      store.appendTrajectoryArtifact(id, { artifactId: "top-b", kind: "other" })
    ).toThrow();

    store.appendTrajectoryStep(
      id,
      step(id, 0, {
        input: { apiKey: SECRET, safe: true },
        futureStepField: { refreshToken: SECRET, safe: "step extension" },
        artifacts: [
          { artifactId: "step-z", kind: "log", name: "first" },
          { artifactId: "step-a", kind: "other", name: "second" },
        ],
      })
    );
    store.appendTrajectoryStep(id, step(id, 1, { parentStepId: `${id}-step-0` }));

    const restored = store.getTrajectory(id)!;
    expect(restored.artifacts.map(({ artifactId }) => artifactId)).toEqual([
      "top-b",
      "top-a",
      "top-final",
    ]);
    expect(restored.steps.map(({ sequence }) => sequence)).toEqual([0, 1]);
    expect(restored.steps[0].artifacts.map(({ artifactId }) => artifactId)).toEqual([
      "step-z",
      "step-a",
    ]);
    expect(restored.steps[0].input).toEqual({ apiKey: "[REDACTED]", safe: true });
    expect(restored.steps[0].futureStepField).toEqual({
      refreshToken: "[REDACTED]",
      safe: "step extension",
    });

    const db = getDb();
    const raw = ["trajectories", "trajectory_steps", "trajectory_artifacts"]
      .map((table) => scalarTextInTable(db, table))
      .join("\n");
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain("[REDACTED]");
  });

  it("rejects nonempty creation and rolls back trajectory metadata when artifact insertion fails", () => {
    expect(() =>
      store.createTrajectory(trajectory("nonempty-create", { steps: [step("nonempty-create", 0)] }))
    ).toThrow(/empty steps array/);
    expect(store.getTrajectory("nonempty-create")).toBeNull();

    expect(() =>
      store.createTrajectory(
        trajectory("atomic-create", {
          artifacts: [
            { artifactId: "duplicate", kind: "file" },
            { artifactId: "duplicate", kind: "log" },
          ],
        })
      )
    ).toThrow();
    expect(store.getTrajectory("atomic-create")).toBeNull();
  });

  it("enforces exact sequence, matching trajectory, earlier parent, and atomic append rollback", () => {
    const id = "append-guards";
    store.createTrajectory(
      trajectory(id, { artifacts: [{ artifactId: "already-used", kind: "trace" }] })
    );

    expect(() => store.appendTrajectoryStep(id, step(id, 1))).toThrow(/expected sequence 0/);
    expect(() =>
      store.appendTrajectoryStep(id, step("different-trajectory", 0, { id: "wrong-step" }))
    ).toThrow(/does not match/);
    expect(() =>
      store.appendTrajectoryStep(
        "missing-trajectory",
        step("missing-trajectory", 0, { id: "missing-trajectory-step" })
      )
    ).toThrow(/not found/);
    expect(() =>
      store.appendTrajectoryStep(id, step(id, 0, { parentStepId: "missing-parent" }))
    ).toThrow(/earlier step/);

    expect(() =>
      store.appendTrajectoryStep(
        id,
        step(id, 0, { artifacts: [{ artifactId: "already-used", kind: "log" }] })
      )
    ).toThrow();
    expect(store.getTrajectory(id)?.steps).toEqual([]);
    expect(getDb().prepare("SELECT next_sequence FROM trajectories WHERE id = ?").get(id)).toEqual({
      next_sequence: 0,
    });

    store.appendTrajectoryStep(id, step(id, 0));
    expect(() =>
      getDb().prepare("UPDATE trajectory_steps SET output = '{}' WHERE trajectory_id = ?").run(id)
    ).toThrow(/append-only/);
    expect(() =>
      getDb().prepare("DELETE FROM trajectory_steps WHERE trajectory_id = ?").run(id)
    ).toThrow(/append-only/);
    expect(() =>
      store.appendTrajectoryStep(id, step(id, 1, { parentStepId: `${id}-step-1` }))
    ).toThrow(/earlier step/);
    expect(store.getTrajectory(id)?.steps).toHaveLength(1);
  });

  it("validates metadata finalization and prevents appends or metadata rewrites after terminal state", () => {
    const id = "finalization";
    store.createTrajectory(trajectory(id));
    store.appendTrajectoryStep(id, step(id, 0));

    expect(() => store.updateTrajectoryMetadata(id, { status: "completed" })).toThrow(
      /completedAt|completed_at/
    );
    expect(() => store.updateTrajectoryMetadata(id, { id: "replacement" })).toThrow(/immutable/);

    const finalized = store.updateTrajectoryMetadata(id, {
      status: "completed",
      completedAt: COMPLETED_AT,
      durationMs: 60_000,
      summary: `authorization=Bearer ${SECRET}`,
      futureFinalization: { password: SECRET, result: "ok" },
    });
    expect(finalized.status).toBe("completed");
    expect(finalized.summary).not.toContain(SECRET);
    expect(finalized.futureFinalization).toEqual({ password: "[REDACTED]", result: "ok" });
    expect(() => store.appendTrajectoryStep(id, step(id, 1))).toThrow(/terminal/);
    expect(() =>
      store.appendTrajectoryArtifact(id, { artifactId: "too-late", kind: "other" })
    ).toThrow(/terminal/);
    expect(() => store.updateTrajectoryMetadata(id, { summary: "rewrite" })).toThrow(/terminal/);
  });

  it("marks interrupted runs terminal without rewriting any prior step row", () => {
    const failedId = "interrupted-failed";
    store.createTrajectory(trajectory(failedId, { status: "waiting" }));
    store.appendTrajectoryStep(failedId, step(failedId, 0));
    const db = getDb();
    const before = db
      .prepare("SELECT * FROM trajectory_steps WHERE trajectory_id = ? ORDER BY sequence")
      .all(failedId);

    const failed = store.markTrajectoryInterrupted(failedId, {
      status: "failed",
      completedAt: COMPLETED_AT,
      error: {
        code: "INTERRUPTED",
        category: "runtime",
        message: `api_key=${SECRET}`,
        retryable: true,
      },
    });
    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toBe("api_key=[REDACTED]");
    expect(
      db
        .prepare("SELECT * FROM trajectory_steps WHERE trajectory_id = ? ORDER BY sequence")
        .all(failedId)
    ).toEqual(before);

    const abortedId = "interrupted-aborted";
    store.createTrajectory(trajectory(abortedId));
    expect(
      store.markTrajectoryInterrupted(abortedId, {
        status: "aborted",
        completedAt: COMPLETED_AT,
      }).status
    ).toBe("aborted");

    const missingErrorId = "interrupted-missing-error";
    store.createTrajectory(trajectory(missingErrorId));
    expect(() =>
      store.markTrajectoryInterrupted(missingErrorId, {
        status: "failed",
        completedAt: COMPLETED_AT,
      })
    ).toThrow(/error/);
    expect(store.getTrajectory(missingErrorId)?.status).toBe("running");
  });

  it("prunes only old terminal trajectories and reports cascaded row counts", () => {
    const now = Date.parse("2026-02-01T00:00:00.000Z");
    const oldCompletedAt = "2026-01-10T00:00:00.000Z";
    // This is 2026-01-24T18:00:00Z and therefore older than the cutoff,
    // despite sorting lexically after 2026-01-25T00:00:00Z.
    const offsetOldCompletedAt = "2026-01-25T08:00:00+14:00";
    const freshCompletedAt = "2026-01-31T12:00:00.000Z";

    store.createTrajectory(
      trajectory("prune-old", {
        artifacts: [{ artifactId: "prune-old-top", kind: "trace" }],
      })
    );
    store.appendTrajectoryStep(
      "prune-old",
      step("prune-old", 0, {
        artifacts: [{ artifactId: "prune-old-step-artifact", kind: "log" }],
      })
    );
    store.updateTrajectoryMetadata("prune-old", {
      status: "completed",
      completedAt: oldCompletedAt,
    });
    store.createTrajectory(trajectory("prune-offset-old"));
    store.updateTrajectoryMetadata("prune-offset-old", {
      status: "completed",
      completedAt: offsetOldCompletedAt,
    });

    store.createTrajectory(
      trajectory("prune-active", {
        status: "waiting",
        artifacts: [{ artifactId: "prune-active-artifact", kind: "trace" }],
      })
    );
    store.createTrajectory(trajectory("prune-fresh"));
    store.updateTrajectoryMetadata("prune-fresh", {
      status: "completed",
      completedAt: freshCompletedAt,
    });

    expect(() => store.pruneTerminalTrajectories(-1, now)).toThrow(/nonnegative/);
    expect(() => store.pruneTerminalTrajectories(Number.NaN, now)).toThrow(/nonnegative/);
    expect(store.pruneTerminalTrajectories(7 * 24 * 60 * 60 * 1_000, now)).toEqual({
      trajectories: 2,
      steps: 1,
      artifacts: 2,
    });
    expect(store.getTrajectory("prune-old")).toBeNull();
    expect(store.getTrajectory("prune-offset-old")).toBeNull();
    expect(
      getDb()
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM trajectory_steps WHERE trajectory_id = 'prune-old') AS steps,
             (SELECT COUNT(*) FROM trajectory_artifacts WHERE trajectory_id = 'prune-old') AS artifacts`
        )
        .get()
    ).toEqual({ steps: 0, artifacts: 0 });
    expect(store.getTrajectory("prune-active")?.status).toBe("waiting");
    expect(store.getTrajectory("prune-fresh")?.status).toBe("completed");
  });

  it("applies configured trajectory retention even when session retention is disabled", async () => {
    const oldId = "configured-retention-old";
    store.createTrajectory(trajectory(oldId));
    store.appendTrajectoryStep(oldId, step(oldId, 0));
    store.updateTrajectoryMetadata(oldId, {
      status: "completed",
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    updateRetentionConfig({ sessionMaxAgeDays: 0, trajectoryMaxAgeDays: 1 });

    await expect(runRetentionCleanup()).resolves.toMatchObject({
      archived: 0,
      deleted: 0,
      trajectoriesDeleted: 1,
    });
    expect(store.getTrajectory(oldId)).toBeNull();

    const foreverId = "configured-retention-forever";
    store.createTrajectory(trajectory(foreverId));
    store.updateTrajectoryMetadata(foreverId, {
      status: "completed",
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    updateRetentionConfig({ trajectoryMaxAgeDays: 0 });
    await expect(runRetentionCleanup()).resolves.toMatchObject({ trajectoriesDeleted: 0 });
    expect(store.getTrajectory(foreverId)).not.toBeNull();
  });

  it("fails closed for unsupported schema versions and corrupt persisted JSON", () => {
    const db = getDb();
    store.createTrajectory(trajectory("unsupported-data"));
    store.createTrajectory(trajectory("corrupt-data"));
    store.createTrajectory(trajectory("corrupt-extensions"));

    db.pragma("ignore_check_constraints = ON");
    try {
      db.prepare("UPDATE trajectories SET schema_version = 2 WHERE id = ?").run("unsupported-data");
      db.prepare("UPDATE trajectories SET origin = ? WHERE id = ?").run("{", "corrupt-data");
      db.prepare("UPDATE trajectories SET extensions = '[]' WHERE id = ?").run(
        "corrupt-extensions"
      );
    } finally {
      db.pragma("ignore_check_constraints = OFF");
    }

    expect(() => store.getTrajectory("unsupported-data")).toThrow();
    expect(() => store.getTrajectory("corrupt-data")).toThrow(/corrupt trajectory data/);
    expect(() => store.getTrajectory("corrupt-extensions")).toThrow(/expected a JSON object/);
  });
});
