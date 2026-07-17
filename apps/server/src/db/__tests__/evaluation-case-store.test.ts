import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluationCaseDocumentV1 } from "@chvor/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-evaluation-cases-"));
process.env.CHVOR_DATA_DIR = dataDir;

let store: typeof import("../evaluation-case-store.ts");
let getDb: typeof import("../database.ts").getDb;
let closeDb: typeof import("../database.ts").closeDb;
let runMigrations: typeof import("../migrations.ts").runMigrations;

const SECRET = `sk-${"A".repeat(24)}`;

function document(name = "Regression case"): EvaluationCaseDocumentV1 {
  return {
    schemaVersion: 1,
    name,
    input: { prompt: "safe", password: SECRET, sessionId: "transient-session" },
    expected: { status: "completed", outputContains: [" zebra ", "alpha", "alpha"] },
    requiredTools: [" native__web_search ", "native__memory_search", "native__web_search"],
    forbiddenTools: [" native__shell_execute ", "native__shell_execute"],
    safetyAssertions: ["no-secrets-in-output"],
  };
}

beforeAll(async () => {
  store = await import("../evaluation-case-store.ts");
  ({ getDb, closeDb } = await import("../database.ts"));
  ({ runMigrations } = await import("../migrations.ts"));
});

beforeEach(() => {
  getDb().prepare("DELETE FROM evaluation_cases").run();
});

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("evaluation-case migration v33", () => {
  it("creates identity and immutable revision storage on fresh databases", () => {
    const db = getDb();
    expect(db.pragma("user_version", { simple: true })).toBe(36);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'evaluation_case%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "evaluation_case_revisions",
      "evaluation_cases",
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'evaluation_case_revisions_no_update'"
        )
        .get()
    ).toBeTruthy();
  });

  it("upgrades an explicit v32 database and is idempotent after the version bump", () => {
    const migrationDir = mkdtempSync(join(tmpdir(), "chvor-v32-v33-"));
    const db = new Database(join(migrationDir, "migration.db"));
    try {
      db.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY)");
      db.pragma("foreign_keys = ON");
      db.pragma("user_version = 32");
      runMigrations(db, false);
      expect(db.pragma("user_version", { simple: true })).toBe(36);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)"
          )
          .get("evaluation_cases", "evaluation_case_revisions")
      ).toEqual({ count: 2 });
      expect(() => runMigrations(db, false)).not.toThrow();
    } finally {
      db.close();
      rmSync(migrationDir, { recursive: true, force: true });
    }
  });
});

describe("evaluation-case store", () => {
  it("redacts and canonicalizes documents before persisting them", () => {
    const created = store.createEvaluationCase(document(`api_key=${SECRET}`));
    expect(created.revision).toBe(1);
    expect(created.document.name).toBe("api_key=[REDACTED]");
    expect(created.document.input).toEqual({
      prompt: "safe",
      password: "[REDACTED]",
      sessionId: "[TRANSIENT_ID]",
    });
    expect(created.document.expected.outputContains).toEqual(["alpha", "zebra"]);
    expect(created.document.requiredTools).toEqual(["native__memory_search", "native__web_search"]);
    expect(created.document.forbiddenTools).toEqual(["native__shell_execute"]);

    const raw = getDb()
      .prepare("SELECT document FROM evaluation_case_revisions WHERE case_id = ?")
      .get(created.id) as { document: string };
    expect(raw.document).not.toContain(SECRET);
    expect(raw.document).not.toContain("transient-session");
    expect(store.getEvaluationCase(created.id)).toEqual(created);
    expect(store.listEvaluationCases().records).toEqual([created]);
  });

  it("appends immutable revisions and rejects stale optimistic updates atomically", () => {
    const created = store.createEvaluationCase(document("First"));
    const revised = store.updateEvaluationCase(created.id, 1, document("Second"));
    expect(revised).toMatchObject({ id: created.id, revision: 2 });
    expect(
      store.listEvaluationCaseRevisions(created.id).revisions.map(({ revision }) => revision)
    ).toEqual([2, 1]);

    expect(() => store.updateEvaluationCase(created.id, 1, document("Stale"))).toThrow(
      store.EvaluationCaseRevisionConflictError
    );
    expect(store.getEvaluationCase(created.id)?.document.name).toBe("Second");
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM evaluation_case_revisions WHERE case_id = ?")
        .get(created.id)
    ).toEqual({ count: 2 });
    expect(() =>
      getDb()
        .prepare(
          "UPDATE evaluation_case_revisions SET document = document WHERE case_id = ? AND revision = 1"
        )
        .run(created.id)
    ).toThrow(/immutable/);
    expect(() =>
      getDb()
        .prepare("DELETE FROM evaluation_case_revisions WHERE case_id = ? AND revision = 1")
        .run(created.id)
    ).toThrow(/immutable/);
  });

  it("exports canonical portable JSON without local metadata", () => {
    const created = store.createEvaluationCase(document("Canonical"));
    const exported = store.exportEvaluationCase(created.id)!;
    expect(exported.endsWith("\n")).toBe(true);
    expect(exported).toBe(store.canonicalEvaluationCaseJson(created.document));
    expect(exported).not.toContain(created.id);
    expect(exported).not.toContain(created.createdAt);
    expect(exported.indexOf('"expected"')).toBeLessThan(exported.indexOf('"input"'));
    expect(exported).toContain(
      '"input":{"password":"[REDACTED]","prompt":"safe","sessionId":"[TRANSIENT_ID]"}'
    );
  });

  it("paginates cases and immutable revision history with stable cursors", () => {
    const first = store.createEvaluationCase(document("First page case"));
    const second = store.createEvaluationCase(document("Second page case"));
    const firstPage = store.listEvaluationCases(1);
    expect(firstPage.records).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = store.listEvaluationCases(1, firstPage.nextCursor!);
    expect(secondPage.records).toHaveLength(1);
    expect(new Set([firstPage.records[0].id, secondPage.records[0].id])).toEqual(
      new Set([first.id, second.id])
    );
    expect(secondPage.nextCursor).toBeNull();

    store.updateEvaluationCase(first.id, 1, document("Revision two"));
    store.updateEvaluationCase(first.id, 2, document("Revision three"));
    const revisionPage = store.listEvaluationCaseRevisions(first.id, 2);
    expect(revisionPage.revisions.map(({ revision }) => revision)).toEqual([3, 2]);
    expect(revisionPage.nextCursor).toBe(2);
    const remaining = store.listEvaluationCaseRevisions(first.id, 2, revisionPage.nextCursor!);
    expect(remaining.revisions.map(({ revision }) => revision)).toEqual([1]);
    expect(remaining.nextCursor).toBeNull();
  });

  it("rejects invalid documents and missing records", () => {
    const invalid = { ...document(), expected: {} };
    expect(() => store.createEvaluationCase(invalid)).toThrow();
    expect(() => store.updateEvaluationCase("missing", 1, document())).toThrow(
      store.EvaluationCaseNotFoundError
    );
    expect(store.exportEvaluationCase("missing")).toBeNull();
  });
});
