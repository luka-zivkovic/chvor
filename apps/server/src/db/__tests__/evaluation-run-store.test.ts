import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvaluationRunReport, serializeEvaluationRunReport } from "@chvor/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-evaluation-runs-"));
process.env.CHVOR_DATA_DIR = dataDir;

let store: typeof import("../evaluation-run-store.ts");
let getDb: typeof import("../database.ts").getDb;
let closeDb: typeof import("../database.ts").closeDb;
let runMigrations: typeof import("../migrations.ts").runMigrations;

const HASH = "a".repeat(64);
const STARTED_AT = "2026-07-11T10:00:00.000Z";

function reportFixture(
  id = "run-1",
  completedAt = "2026-07-11T10:00:01.000Z",
  caseCount = 1,
  knownCost = true
) {
  const cases = Array.from({ length: caseCount }, (_, position) => ({
    position,
    snapshot: {
      caseId: `case-${position}`,
      revision: position + 1,
      documentHash: HASH,
      critical: true,
      document: {
        schemaVersion: 1 as const,
        name: `Case ${position}`,
        input: { prompt: `input-${position}` },
        expected: { status: "completed" as const, outputContains: ["ok"] },
        requiredTools: [],
        forbiddenTools: [],
        safetyAssertions: ["no-secrets-in-output" as const],
      },
    },
    observation: {
      status: "completed" as const,
      output: { value: "ok" },
      toolCalls: [],
      usage: knownCost
        ? { inputTokens: position + 1, outputTokens: position + 2, totalTokens: position * 2 + 3 }
        : null,
      latencyMs: position + 10,
      costUsd: knownCost ? 0.01 : null,
      error: null,
    },
    assertions: [{ kind: "completion" as const, status: "passed" as const, message: "matched" }],
    passed: true,
  }));
  return {
    schemaVersion: 1 as const,
    id,
    configuration: {
      engineId: "chvor-isolated-v1" as const,
      providerId: "openai",
      modelId: "test-model",
      prompt: "Be helpful",
      promptHash: HASH,
      temperature: 0,
      maxRounds: 2,
      caseTimeoutMs: 10_000,
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      limits: { maxCostUsdPerCase: 1, maxLatencyMsPerCase: 2_000 },
      tools: [],
    },
    configurationHash: HASH,
    startedAt: STARTED_AT,
    completedAt,
    status: "completed" as const,
    passed: true,
    summary: {
      total: caseCount,
      passed: caseCount,
      failed: 0,
      criticalFailed: 0,
      totalCostUsd: knownCost ? caseCount * 0.01 : null,
      totalLatencyMs: cases.reduce((sum, entry) => sum + entry.observation.latencyMs, 0),
    },
    environment: {
      runnerVersion: "1",
      chvorVersion: "1",
      sourceCommit: null,
      nodeVersion: "v22",
      platform: "darwin",
      architecture: "arm64",
    },
    cases,
    error: null,
  };
}

function removeDatabaseFiles(): void {
  for (const name of ["chvor.db", "chvor.db-wal", "chvor.db-shm"]) {
    rmSync(join(dataDir, name), { force: true });
  }
}

beforeAll(async () => {
  store = await import("../evaluation-run-store.ts");
  ({ getDb, closeDb } = await import("../database.ts"));
  ({ runMigrations } = await import("../migrations.ts"));
});

beforeEach(() => {
  closeDb?.();
  removeDatabaseFiles();
  getDb();
});

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("evaluation-run migration v34", () => {
  it("creates normalized run/case storage, indexes, and immutable triggers on fresh databases", () => {
    const db = getDb();
    expect(db.pragma("user_version", { simple: true })).toBe(34);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'evaluation_run%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual(["evaluation_run_cases", "evaluation_runs"]);
    const objects = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE tbl_name IN ('evaluation_runs', 'evaluation_run_cases') AND type IN ('index', 'trigger')"
      )
      .all() as Array<{ name: string }>;
    expect(objects.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "idx_evaluation_runs_completed",
        "idx_evaluation_run_cases_position",
        "evaluation_runs_no_update",
        "evaluation_runs_no_delete",
        "evaluation_run_cases_no_update",
        "evaluation_run_cases_no_delete",
      ])
    );
  });

  it("upgrades a v33 database and is idempotent after the version bump", () => {
    const migrationDir = mkdtempSync(join(tmpdir(), "chvor-v33-v34-"));
    const db = new Database(join(migrationDir, "migration.db"));
    try {
      db.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY)");
      db.pragma("foreign_keys = ON");
      db.pragma("user_version = 33");
      runMigrations(db, false);
      expect(db.pragma("user_version", { simple: true })).toBe(34);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)"
          )
          .get("evaluation_runs", "evaluation_run_cases")
      ).toEqual({ count: 2 });
      expect(() => runMigrations(db, false)).not.toThrow();
    } finally {
      db.close();
      rmSync(migrationDir, { recursive: true, force: true });
    }
  });

  it("enforces bounded indexed values, JSON size, terminal status, and nullable cost", () => {
    store.insertEvaluationRun(reportFixture("run-constraints", undefined, 1, false));
    const db = getDb();
    db.exec("DROP TRIGGER evaluation_runs_no_update");
    expect(() =>
      db
        .prepare("UPDATE evaluation_runs SET engine = ? WHERE id = ?")
        .run("x".repeat(129), "run-constraints")
    ).toThrow(/CHECK constraint/);
    expect(() =>
      db
        .prepare("UPDATE evaluation_runs SET status = 'running' WHERE id = ?")
        .run("run-constraints")
    ).toThrow(/CHECK constraint/);
    expect(() =>
      db
        .prepare("UPDATE evaluation_runs SET config_snapshot = ? WHERE id = ?")
        .run(JSON.stringify({ value: "x".repeat(8_388_608) }), "run-constraints")
    ).toThrow(/CHECK constraint/);
    expect(
      db.prepare("SELECT cost_usd FROM evaluation_runs WHERE id = ?").get("run-constraints")
    ).toEqual({ cost_usd: null });
  });
});

describe("evaluation-run store", () => {
  it("atomically stores normalized rows and reconstructs the canonical report", () => {
    const input = reportFixture("run-round-trip", undefined, 2);
    const inserted = store.insertEvaluationRun(input);
    expect(store.getEvaluationRun(input.id)).toEqual(inserted);
    expect(serializeEvaluationRunReport(store.getEvaluationRun(input.id))).toBe(
      serializeEvaluationRunReport(parseEvaluationRunReport(input))
    );

    const db = getDb();
    const run = db
      .prepare(
        "SELECT report_metadata, config_snapshot, case_count, input_tokens, output_tokens FROM evaluation_runs WHERE id = ?"
      )
      .get(input.id) as Record<string, unknown>;
    expect(JSON.parse(run.report_metadata as string)).not.toHaveProperty("cases");
    expect(JSON.parse(run.config_snapshot as string)).toEqual(inserted.configuration);
    expect(run).toMatchObject({ case_count: 2, input_tokens: 3, output_tokens: 5 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM evaluation_run_cases WHERE run_id = ?")
        .get(input.id)
    ).toEqual({ count: 2 });
  });

  it("persists reports atomically and rejects duplicate run ids", () => {
    const input = reportFixture("run-atomic", undefined, 2);
    store.insertEvaluationRun(input);
    expect(() => store.insertEvaluationRun(input)).toThrow();
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM evaluation_runs WHERE id = ?").get(input.id)
    ).toEqual({ count: 1 });
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM evaluation_run_cases WHERE run_id = ?")
        .get(input.id)
    ).toEqual({ count: 2 });
  });

  it("prevents update/delete of completed run and case rows", () => {
    const input = reportFixture("run-immutable");
    store.insertEvaluationRun(input);
    const db = getDb();
    expect(() =>
      db.prepare("UPDATE evaluation_runs SET status = status WHERE id = ?").run(input.id)
    ).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM evaluation_runs WHERE id = ?").run(input.id)).toThrow(
      /permanent/
    );
    expect(() =>
      db.prepare("UPDATE evaluation_run_cases SET passed = passed WHERE run_id = ?").run(input.id)
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare("DELETE FROM evaluation_run_cases WHERE run_id = ?").run(input.id)
    ).toThrow(/permanent/);
  });

  it("detects corrupt normalized case data while metadata-only comparisons stay bounded", () => {
    const input = reportFixture("run-corrupt");
    store.insertEvaluationRun(input);
    const db = getDb();
    db.exec("DROP TRIGGER evaluation_run_cases_no_update");
    db.prepare("UPDATE evaluation_run_cases SET result = '{}' WHERE run_id = ?").run(input.id);
    expect(() => store.getEvaluationRun(input.id)).toThrow(store.EvaluationRunCorruptionError);
    expect(store.getEvaluationRunsForComparison([input.id])).toEqual([
      expect.objectContaining({ id: input.id, caseCount: 1 }),
    ]);
  });

  it("paginates runs newest-first with completedAt/id keysets", () => {
    store.insertEvaluationRun(reportFixture("run-a", "2026-07-11T10:00:01.000Z"));
    store.insertEvaluationRun(reportFixture("run-b", "2026-07-11T10:00:02.000Z"));
    store.insertEvaluationRun(reportFixture("run-c", "2026-07-11T10:00:02.000Z"));
    const first = store.listEvaluationRuns(2);
    expect(first.runs.map(({ id }) => id)).toEqual(["run-c", "run-b"]);
    expect(first.nextCursor).toEqual({
      completedAt: "2026-07-11T10:00:02.000Z",
      id: "run-b",
    });
    const second = store.listEvaluationRuns(2, first.nextCursor!);
    expect(second.runs.map(({ id }) => id)).toEqual(["run-a"]);
    expect(second.nextCursor).toBeNull();
  });

  it("paginates cases by ascending position and enforces all bounds", () => {
    const input = reportFixture("run-case-pages", undefined, 3);
    store.insertEvaluationRun(input);
    const first = store.listEvaluationRunCases(input.id, 2);
    expect(first.cases.map(({ position }) => position)).toEqual([0, 1]);
    expect(first.nextCursor).toBe(1);
    const second = store.listEvaluationRunCases(input.id, 2, first.nextCursor!);
    expect(second.cases.map(({ position }) => position)).toEqual([2]);
    expect(second.nextCursor).toBeNull();
    expect(store.evaluationRunExists(input.id)).toBe(true);
    expect(store.getEvaluationRunCase(input.id, 2)?.result.position).toBe(2);
    expect(store.getEvaluationRunCase(input.id, 99)).toBeNull();

    for (const invalid of [0, 21, 1.5]) {
      expect(() => store.listEvaluationRuns(invalid)).toThrow(RangeError);
      expect(() => store.listEvaluationRunCases(input.id, invalid)).toThrow(RangeError);
    }
    expect(() => store.listEvaluationRuns(1, { completedAt: "bad", id: "run" })).toThrow(
      RangeError
    );
    expect(() => store.listEvaluationRunCases(input.id, 1, -1)).toThrow(RangeError);
    expect(() => store.getEvaluationRunsForComparison(Array(21).fill(input.id))).toThrow(
      RangeError
    );
  });
});
