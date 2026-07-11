import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EvaluationRunReport } from "@chvor/shared";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-evaluation-run-routes-"));
process.env.CHVOR_DATA_DIR = dataDir;
const runMock = vi.fn();
vi.mock("../../evaluation/evaluation-runner.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../evaluation/evaluation-runner.ts")>()),
  runEvaluation: runMock,
}));

let app: Hono;
let readKey = "";
let runOnlyKey = "";
let runKey = "";
let legacyInstallToken = "";
let genericKey = "";
let closeDb: typeof import("../../db/database.ts").closeDb;
const hash = "a".repeat(64);

function report(id: string, passed: boolean): EvaluationRunReport {
  return {
    schemaVersion: 1,
    id,
    configuration: {
      engineId: "chvor-isolated-v1",
      providerId: "openai",
      modelId: "test",
      prompt: "safe prompt",
      promptHash: hash,
      temperature: 0,
      maxRounds: 1,
      caseTimeoutMs: 10_000,
      limits: {},
      tools: [],
    },
    configurationHash: hash,
    startedAt: "2026-07-11T00:00:00.000Z",
    completedAt: id === "run-1" ? "2026-07-11T00:00:01.000Z" : "2026-07-11T00:00:02.000Z",
    status: "completed",
    passed,
    summary: {
      total: 1,
      passed: Number(passed),
      failed: Number(!passed),
      criticalFailed: Number(!passed),
      totalCostUsd: null,
      totalLatencyMs: 10,
    },
    environment: {
      runnerVersion: "1",
      chvorVersion: "test",
      sourceCommit: null,
      nodeVersion: "v22",
      platform: "test",
      architecture: "test",
    },
    cases: [
      {
        position: 0,
        snapshot: {
          caseId: "case-1",
          revision: 1,
          documentHash: hash,
          critical: true,
          document: {
            schemaVersion: 1,
            name: "case",
            input: "hello",
            expected: { status: "completed", outputContains: [] },
            requiredTools: [],
            forbiddenTools: [],
            safetyAssertions: [],
          },
        },
        observation: {
          status: "completed",
          output: "hello",
          toolCalls: [],
          usage: null,
          latencyMs: 10,
          costUsd: null,
          error: null,
        },
        assertions: [
          { kind: "completion", status: passed ? "passed" : "failed", message: "result" },
        ],
        passed,
      },
    ],
    error: null,
  };
}

function auth(key: string): { Authorization: string } {
  return { Authorization: `Bearer ${key}` };
}

beforeAll(async () => {
  const [{ chvorAuth }, routes, authStore, apiKeyStore, database] = await Promise.all([
    import("../../middleware/auth.ts"),
    import("../evaluation-runs.ts"),
    import("../../db/auth-store.ts"),
    import("../../db/api-key-store.ts"),
    import("../../db/database.ts"),
  ]);
  closeDb = database.closeDb;
  authStore.enableAuth();
  readKey = apiKeyStore.generateApiKey("evaluation reader", undefined, "evaluation:read").key;
  runOnlyKey = apiKeyStore.generateApiKey("evaluation runner only", undefined, "evaluation:run").key;
  runKey = apiKeyStore.generateApiKey(
    "evaluation runner",
    undefined,
    "evaluation:read,evaluation:run"
  ).key;
  legacyInstallToken = "0123456789abcdef".repeat(4);
  database
    .getDb()
    .prepare(
      `INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes, created_at)
       VALUES (?, ?, ?, ?, '*', ?)`
    )
    .run(
      "legacy-install-token",
      "Legacy CHVOR_TOKEN",
      legacyInstallToken.slice(0, 8),
      createHash("sha256").update(legacyInstallToken).digest("hex"),
      new Date().toISOString()
    );
  genericKey = apiKeyStore.generateApiKey("generic", undefined, "api:read,api:write").key;
  app = new Hono();
  app.use("/api/*", chvorAuth);
  app.route("/api/evaluation-runs", routes.default);
});

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("evaluation-run API", () => {
  it("requires evaluation:read for reads", async () => {
    expect((await app.request("/api/evaluation-runs")).status).toBe(401);
    expect((await app.request("/api/evaluation-runs", { headers: auth(genericKey) })).status).toBe(
      403
    );
    expect((await app.request("/api/evaluation-runs", { headers: auth(readKey) })).status).toBe(
      200
    );
  });

  it("requires both evaluation:run and evaluation:read to start a run", async () => {
    const readOnlyResponse = await app.request("/api/evaluation-runs", {
      method: "POST",
      headers: auth(readKey),
      body: "{}",
    });
    expect(readOnlyResponse.status).toBe(403);
    expect(await readOnlyResponse.json()).toEqual({
      error: "Forbidden",
      detail: 'API key missing required scope "evaluation:run"',
    });

    const runOnlyResponse = await app.request("/api/evaluation-runs", {
      method: "POST",
      headers: auth(runOnlyKey),
      body: "{}",
    });
    expect(runOnlyResponse.status).toBe(403);
    expect(await runOnlyResponse.json()).toEqual({
      error: "Forbidden",
      detail: 'API key missing required scope "evaluation:read"',
    });

    runMock.mockResolvedValueOnce(report("auth-run", true));
    expect(
      (
        await app.request("/api/evaluation-runs", {
          method: "POST",
          headers: { ...auth(runKey), "content-type": "application/json" },
          body: JSON.stringify({ cases: [], configuration: {} }),
        })
      ).status
    ).toBe(201);

    runMock.mockResolvedValueOnce(report("auth-run-legacy", true));
    expect(
      (
        await app.request("/api/evaluation-runs", {
          method: "POST",
          headers: { ...auth(legacyInstallToken), "content-type": "application/json" },
          body: JSON.stringify({ cases: [], configuration: {} }),
        })
      ).status
    ).toBe(201);
  });

  it("runs, persists, paginates, reads case detail, and compares reports", async () => {
    runMock
      .mockResolvedValueOnce(report("run-1", true))
      .mockResolvedValueOnce(report("run-2", false));
    for (let index = 0; index < 2; index += 1) {
      const response = await app.request("/api/evaluation-runs", {
        method: "POST",
        headers: { ...auth(runKey), "content-type": "application/json" },
        body: JSON.stringify({ cases: [], configuration: {} }),
      });
      expect(response.status).toBe(201);
    }
    const page = await app.request("/api/evaluation-runs?limit=1", { headers: auth(readKey) });
    const pageBody = (await page.json()) as {
      data: { runs: Array<{ id: string }>; nextCursor: string };
    };
    expect(pageBody.data.runs).toHaveLength(1);
    expect(pageBody.data.nextCursor).toBeTruthy();
    expect(
      (await app.request("/api/evaluation-runs/run-1", { headers: auth(readKey) })).status
    ).toBe(200);
    expect(
      (await app.request("/api/evaluation-runs/run-1/cases/0", { headers: auth(readKey) })).status
    ).toBe(200);
    const comparison = await app.request(
      "/api/evaluation-runs/compare?baseline=run-1&candidate=run-2",
      { headers: auth(readKey) }
    );
    expect(comparison.status).toBe(200);
    expect(await comparison.json()).toMatchObject({ data: { regressions: 1, improvements: 0 } });

    const negativeCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        kind: "comparison",
        baseline: "run-1",
        candidate: "run-2",
        position: -1,
      })
    ).toString("base64url");
    expect(
      (
        await app.request(
          `/api/evaluation-runs/compare?baseline=run-1&candidate=run-2&cursor=${negativeCursor}`,
          { headers: auth(readKey) }
        )
      ).status
    ).toBe(400);
  });
});
