import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { EVALUATION_CASE_DOCUMENT_MAX_BYTES, type EvaluationCaseDocumentV1 } from "@chvor/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-evaluation-case-routes-"));
process.env.CHVOR_DATA_DIR = dataDir;

let app: Hono;
let readKey = "";
let writeKey = "";
let genericKey = "";
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;

const SECRET = `ghp_${"A".repeat(40)}`;

function document(name = "API regression"): EvaluationCaseDocumentV1 {
  return {
    schemaVersion: 1,
    name,
    input: { prompt: "check this", apiToken: SECRET, toolCallId: "transient-call" },
    expected: { status: "completed", outputContains: [" success ", "success"] },
    requiredTools: ["native__web_search"],
    forbiddenTools: ["native__shell_execute"],
    safetyAssertions: ["no-secrets-in-output"],
  };
}

function auth(key: string): { Authorization: string } {
  return { Authorization: `Bearer ${key}` };
}

async function request(
  path: string,
  options: { method?: string; key?: string; body?: unknown } = {}
): Promise<Response> {
  return app.request(path, {
    method: options.method,
    headers: {
      ...auth(options.key ?? readKey),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

beforeAll(async () => {
  const [{ chvorAuth }, routes, authStore, apiKeyStore, database] = await Promise.all([
    import("../../middleware/auth.ts"),
    import("../evaluation-cases.ts"),
    import("../../db/auth-store.ts"),
    import("../../db/api-key-store.ts"),
    import("../../db/database.ts"),
  ]);
  ({ getDb, closeDb } = database);
  authStore.enableAuth();
  readKey = apiKeyStore.generateApiKey("evaluation reader", undefined, "evaluation:read").key;
  writeKey = apiKeyStore.generateApiKey(
    "evaluation writer",
    undefined,
    "evaluation:read,evaluation:write"
  ).key;
  genericKey = apiKeyStore.generateApiKey("generic key", undefined, "api:read,api:write").key;
  app = new Hono();
  app.use("/api/*", chvorAuth);
  app.route("/api/evaluation-cases", routes.default);
});

beforeEach(() => {
  getDb().prepare("DELETE FROM evaluation_cases").run();
});

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("evaluation-case API", () => {
  it("enforces dedicated read and write scopes", async () => {
    expect((await app.request("/api/evaluation-cases")).status).toBe(401);
    expect((await request("/api/evaluation-cases", { key: genericKey })).status).toBe(403);
    expect((await request("/api/%65valuation-cases", { key: genericKey })).status).toBe(403);
    expect((await request("/api/evaluation-cases")).status).toBe(200);
    expect(
      (
        await request("/api/evaluation-cases", {
          method: "POST",
          key: readKey,
          body: { document: document() },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await request("/api/evaluation-cases", {
          method: "POST",
          key: writeKey,
          body: { document: document() },
        })
      ).status
    ).toBe(201);
  });

  it("creates, lists, reads, revises, and exposes immutable history", async () => {
    const createdResponse = await request("/api/evaluation-cases", {
      method: "POST",
      key: writeKey,
      body: { document: document() },
    });
    expect(createdResponse.status).toBe(201);
    const createdBody = (await createdResponse.json()) as {
      data: {
        evaluationCase: { id: string; revision: number; document: EvaluationCaseDocumentV1 };
      };
    };
    const created = createdBody.data.evaluationCase;
    expect(created.revision).toBe(1);
    expect(JSON.stringify(created)).not.toContain(SECRET);
    expect(JSON.stringify(created)).not.toContain("transient-call");
    expect(created.document.input).toMatchObject({ toolCallId: "[TRANSIENT_ID]" });
    expect(created.document.expected.outputContains).toEqual(["success"]);

    const list = (await (await request("/api/evaluation-cases")).json()) as {
      data: { records: Array<{ id: string }> };
    };
    expect(list.data.records.map(({ id }) => id)).toEqual([created.id]);
    expect((await request(`/api/evaluation-cases/${created.id}`)).status).toBe(200);

    const updatedResponse = await request(`/api/evaluation-cases/${created.id}`, {
      method: "PUT",
      key: writeKey,
      body: { expectedRevision: 1, document: document("Revised") },
    });
    expect(updatedResponse.status).toBe(200);
    const updated = (await updatedResponse.json()) as {
      data: { evaluationCase: { revision: number; document: { name: string } } };
    };
    expect(updated.data.evaluationCase).toMatchObject({
      revision: 2,
      document: { name: "Revised" },
    });

    const conflict = await request(`/api/evaluation-cases/${created.id}`, {
      method: "PUT",
      key: writeKey,
      body: { expectedRevision: 1, document: document("Stale") },
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      actualRevision: 2,
      expectedRevision: 1,
    });

    const history = (await (
      await request(`/api/evaluation-cases/${created.id}/revisions`)
    ).json()) as { data: { revisions: Array<{ revision: number; document: { name: string } }> } };
    expect(history.data.revisions.map(({ revision }) => revision)).toEqual([2, 1]);
    expect(history.data.revisions[1].document.name).toBe("API regression");
  });

  it("exports canonical raw JSON and imports it as a new local record", async () => {
    const created = (await (
      await request("/api/evaluation-cases", {
        method: "POST",
        key: writeKey,
        body: { document: document("Portable") },
      })
    ).json()) as { data: { evaluationCase: { id: string; createdAt: string } } };
    const original = created.data.evaluationCase;

    const exported = await request(`/api/evaluation-cases/${original.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("application/json");
    expect(exported.headers.get("content-disposition")).toContain("attachment;");
    const portable = await exported.text();
    expect(portable.endsWith("\n")).toBe(true);
    expect(portable).not.toContain(original.id);
    expect(portable).not.toContain(original.createdAt);

    const imported = await app.request("/api/evaluation-cases/import", {
      method: "POST",
      headers: { ...auth(writeKey), "content-type": "application/json" },
      body: portable,
    });
    expect(imported.status).toBe(201);
    const importedBody = (await imported.json()) as {
      data: { evaluationCase: { id: string; revision: number; document: { name: string } } };
    };
    expect(importedBody.data.evaluationCase).toMatchObject({
      revision: 1,
      document: { name: "Portable" },
    });
    expect(importedBody.data.evaluationCase.id).not.toBe(original.id);
  });

  it("returns validation and missing-record errors", async () => {
    expect(
      (
        await request("/api/evaluation-cases", {
          method: "POST",
          key: writeKey,
          body: { document: { ...document(), expected: {} } },
        })
      ).status
    ).toBe(400);
    expect((await request("/api/evaluation-cases/missing")).status).toBe(404);
    expect((await request("/api/evaluation-cases/missing/revisions")).status).toBe(404);
    expect((await request("/api/evaluation-cases/missing/export")).status).toBe(404);
  });

  it("bounds both request bodies and persisted portable documents", async () => {
    const overDocumentLimit = {
      ...document(),
      input: { text: "x".repeat(EVALUATION_CASE_DOCUMENT_MAX_BYTES) },
    };
    expect(
      (
        await request("/api/evaluation-cases", {
          method: "POST",
          key: writeKey,
          body: { document: overDocumentLimit },
        })
      ).status
    ).toBe(400);

    const body = JSON.stringify({
      document: { ...document(), input: { text: "x".repeat(600_000) } },
    });
    const response = await app.request("/api/evaluation-cases", {
      method: "POST",
      headers: {
        ...auth(writeKey),
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Evaluation case payload too large",
    });
  });

  it("paginates case and revision collections with opaque cursors", async () => {
    for (const name of ["First", "Second"]) {
      expect(
        (
          await request("/api/evaluation-cases", {
            method: "POST",
            key: writeKey,
            body: { document: document(name) },
          })
        ).status
      ).toBe(201);
    }

    const firstPage = (await (await request("/api/evaluation-cases?limit=1")).json()) as {
      data: { records: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(firstPage.data.records).toHaveLength(1);
    expect(firstPage.data.nextCursor).toBeTruthy();
    const secondPage = (await (
      await request(`/api/evaluation-cases?limit=1&cursor=${firstPage.data.nextCursor}`)
    ).json()) as { data: { records: Array<{ id: string }>; nextCursor: string | null } };
    expect(secondPage.data.records).toHaveLength(1);
    expect(secondPage.data.records[0].id).not.toBe(firstPage.data.records[0].id);
    expect(secondPage.data.nextCursor).toBeNull();

    const id = firstPage.data.records[0].id;
    for (const [expectedRevision, name] of [
      [1, "Revision two"],
      [2, "Revision three"],
    ] as const) {
      expect(
        (
          await request(`/api/evaluation-cases/${id}`, {
            method: "PUT",
            key: writeKey,
            body: { expectedRevision, document: document(name) },
          })
        ).status
      ).toBe(200);
    }
    const revisionPage = (await (
      await request(`/api/evaluation-cases/${id}/revisions?limit=2`)
    ).json()) as {
      data: { revisions: Array<{ revision: number }>; nextCursor: string | null };
    };
    expect(revisionPage.data.revisions.map(({ revision }) => revision)).toEqual([3, 2]);
    expect(revisionPage.data.nextCursor).toBeTruthy();
    const remaining = (await (
      await request(
        `/api/evaluation-cases/${id}/revisions?limit=2&cursor=${revisionPage.data.nextCursor}`
      )
    ).json()) as {
      data: { revisions: Array<{ revision: number }>; nextCursor: string | null };
    };
    expect(remaining.data.revisions.map(({ revision }) => revision)).toEqual([1]);
    expect(remaining.data.nextCursor).toBeNull();
    expect((await request("/api/evaluation-cases?cursor=bad!cursor")).status).toBe(400);
  });

  it("rethrows persistence failures as server errors without exposing backend details", async () => {
    getDb().exec(`
      CREATE TRIGGER evaluation_cases_test_failure
      BEFORE INSERT ON evaluation_cases
      BEGIN
        SELECT RAISE(FAIL, 'private persistence failure detail');
      END;
    `);
    try {
      for (const path of ["/api/evaluation-cases", "/api/evaluation-cases/import"]) {
        const response = await request(path, {
          method: "POST",
          key: writeKey,
          body: path.endsWith("/import") ? document() : { document: document() },
        });
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain("private persistence failure detail");
      }
    } finally {
      getDb().exec("DROP TRIGGER evaluation_cases_test_failure");
    }

    const created = (await (
      await request("/api/evaluation-cases", {
        method: "POST",
        key: writeKey,
        body: { document: document() },
      })
    ).json()) as { data: { evaluationCase: { id: string } } };
    getDb().exec(`
      CREATE TRIGGER evaluation_case_revisions_test_failure
      BEFORE INSERT ON evaluation_case_revisions
      WHEN NEW.revision > 1
      BEGIN
        SELECT RAISE(FAIL, 'private revision failure detail');
      END;
    `);
    try {
      const response = await request(`/api/evaluation-cases/${created.data.evaluationCase.id}`, {
        method: "PUT",
        key: writeKey,
        body: { expectedRevision: 1, document: document("Revision") },
      });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("private revision failure detail");
    } finally {
      getDb().exec("DROP TRIGGER evaluation_case_revisions_test_failure");
    }
  });
});
