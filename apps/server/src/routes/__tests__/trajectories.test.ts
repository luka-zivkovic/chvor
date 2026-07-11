import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { CanonicalTrajectoryV1, TrajectoryStatus } from "@chvor/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-trajectory-routes-"));
process.env.CHVOR_DATA_DIR = dataDir;

let app: Hono;
let readKey = "";
let genericReadKey = "";
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;
let createTrajectory: typeof import("../../db/trajectory-store.ts").createTrajectory;
let appendTrajectoryStep: typeof import("../../db/trajectory-store.ts").appendTrajectoryStep;
let updateTrajectoryMetadata: typeof import("../../db/trajectory-store.ts").updateTrajectoryMetadata;

const times = {
  early: "2026-07-10T11:00:00.000Z",
  middle: "2026-07-10T12:00:00.000Z",
  later: "2026-07-10T13:00:00.000Z",
  latest: "2026-07-10T14:00:00.000Z",
};

interface SeedInput {
  id: string;
  startedAt: string;
  origin: CanonicalTrajectoryV1["origin"];
  status: TrajectoryStatus;
  model: string;
  tool: string;
  artifact?: boolean;
}

interface ListResponseBody {
  data: {
    records: Array<{ id: string; input?: unknown }>;
    nextCursor: string | null;
  };
}

interface DetailResponseBody {
  data: {
    trajectory: {
      artifacts: Array<Record<string, unknown>>;
      input?: unknown;
      output?: unknown;
      payloadTruncation: { input: boolean; output: boolean };
    };
  };
}

function seedTrajectory(input: SeedInput): void {
  createTrajectory({
    schemaVersion: 1,
    id: input.id,
    origin: input.origin,
    actor: { type: "test", id: "route-test" },
    status: "running",
    startedAt: input.startedAt,
    input: { prompt: `input for ${input.id}` },
    modelUsage: [
      {
        providerId: "test-provider",
        modelId: input.model,
        wasFallback: false,
        inputTokens: 10,
        outputTokens: 5,
      },
    ],
    steps: [],
    artifacts: input.artifact
      ? [{ artifactId: `${input.id}-artifact`, kind: "trace", locator: `trace://${input.id}` }]
      : [],
    labels: [],
    attributes: {},
  });
  appendTrajectoryStep(input.id, {
    id: `${input.id}-tool-call`,
    trajectoryId: input.id,
    sequence: 0,
    kind: "tool.call",
    status: "completed",
    name: input.tool,
    startedAt: input.startedAt,
    completedAt: input.startedAt,
    durationMs: 0,
    toolCall: {
      toolCallId: `${input.id}-call`,
      toolName: input.tool,
      toolKind: "native",
      credentialRefs: [],
      args: { command: "safe" },
    },
    artifacts: [],
    attributes: {},
  });
  if (input.status !== "running") {
    updateTrajectoryMetadata(input.id, {
      status: input.status,
      completedAt: new Date(Date.parse(input.startedAt) + 1_000).toISOString(),
      durationMs: 1_000,
      output: { result: input.id },
      ...(input.status === "failed"
        ? {
            error: {
              code: "route_test_failure",
              category: "test",
              message: "expected failure",
              retryable: false,
            },
          }
        : {}),
    });
  }
}

function auth(key = readKey): { Authorization: string } {
  return { Authorization: `Bearer ${key}` };
}

async function json<T>(path: string, key = readKey): Promise<{ response: Response; body: T }> {
  const response = await app.request(path, { headers: auth(key) });
  return { response, body: (await response.json()) as T };
}

beforeAll(async () => {
  const [{ chvorAuth }, trajectoryRoutes, authStore, apiKeyStore, trajectoryStore, database] =
    await Promise.all([
      import("../../middleware/auth.ts"),
      import("../trajectories.ts"),
      import("../../db/auth-store.ts"),
      import("../../db/api-key-store.ts"),
      import("../../db/trajectory-store.ts"),
      import("../../db/database.ts"),
    ]);
  ({ getDb, closeDb } = database);
  ({ createTrajectory, appendTrajectoryStep, updateTrajectoryMetadata } = trajectoryStore);
  authStore.enableAuth();
  readKey = apiKeyStore.generateApiKey("trajectory reader", undefined, "trajectory:read").key;
  genericReadKey = apiKeyStore.generateApiKey("generic reader", undefined, "api:read").key;
  app = new Hono();
  app.use("/api/*", chvorAuth);
  app.route("/api/trajectories", trajectoryRoutes.default);
});

beforeEach(() => {
  getDb().prepare("DELETE FROM trajectories").run();
  seedTrajectory({
    id: "run-latest",
    startedAt: times.latest,
    origin: { kind: "daemon", sessionId: "sess-daemon" },
    status: "running",
    model: "model-latest",
    tool: "native__memory_search",
  });
  seedTrajectory({
    id: "run-schedule",
    startedAt: times.later,
    origin: { kind: "schedule", sessionId: "sess-schedule", scheduleId: "sched-1" },
    status: "failed",
    model: "model-schedule",
    tool: "native__schedule_run",
  });
  seedTrajectory({
    id: "run-offset",
    startedAt: "2026-07-10T15:30:00.000+02:00",
    origin: { kind: "api", sessionId: "sess-offset" },
    status: "completed",
    model: "model-offset",
    tool: "native__offset_test",
  });
  seedTrajectory({
    id: "run-web-z",
    startedAt: times.middle,
    origin: {
      kind: "web-chat",
      sessionId: "sess-web",
      channelType: "web",
      channelId: "browser-1",
    },
    status: "completed",
    model: "model-web-z",
    tool: "native__shell_execute",
    artifact: true,
  });
  seedTrajectory({
    id: "run-web-a",
    startedAt: times.middle,
    origin: {
      kind: "web-chat",
      sessionId: "sess-web",
      channelType: "web",
      channelId: "browser-2",
    },
    status: "completed",
    model: "model-web-a",
    tool: "native__web_search",
  });
  seedTrajectory({
    id: "run-channel",
    startedAt: times.early,
    origin: {
      kind: "channel",
      sessionId: "sess-channel",
      channelType: "discord",
      channelId: "chan-1",
    },
    status: "aborted",
    model: "model-channel",
    tool: "native__send_message",
  });
});

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("trajectory query API", () => {
  it("requires authentication and the dedicated read scope", async () => {
    expect((await app.request("/api/trajectories")).status).toBe(401);
    expect((await app.request("/api/trajectories", { headers: auth(genericReadKey) })).status).toBe(
      403
    );
    expect(
      (await app.request("/api/%74rajectories", { headers: auth(genericReadKey) })).status
    ).toBe(403);
    const allowed = await app.request("/api/trajectories", { headers: auth() });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
  });

  it("paginates newest-first with a stable startedAt/id cursor", async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const page: { response: Response; body: ListResponseBody } = await json<ListResponseBody>(
        `/api/trajectories?limit=2${suffix}`
      );
      expect(page.response.status).toBe(200);
      ids.push(...page.body.data.records.map((record) => record.id));
      cursor = page.body.data.nextCursor;
    } while (cursor);

    expect(ids).toEqual([
      "run-latest",
      "run-offset",
      "run-schedule",
      "run-web-z",
      "run-web-a",
      "run-channel",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves high-precision cursor timestamps without skipping the next record", async () => {
    seedTrajectory({
      id: "run-fraction-newer",
      startedAt: "2026-07-10T14:30:00.0004Z",
      origin: { kind: "test" },
      status: "running",
      model: "model-fraction",
      tool: "native__fraction",
    });
    seedTrajectory({
      id: "run-fraction-older",
      startedAt: "2026-07-10T14:30:00.0001Z",
      origin: { kind: "test" },
      status: "running",
      model: "model-fraction",
      tool: "native__fraction",
    });

    const first = await json<ListResponseBody>("/api/trajectories?limit=1");
    expect(first.body.data.records.map((record) => record.id)).toEqual(["run-fraction-newer"]);
    const cursor = first.body.data.nextCursor;
    expect(cursor).not.toBeNull();
    const second = await json<ListResponseBody>(
      `/api/trajectories?limit=1&cursor=${encodeURIComponent(cursor ?? "")}`
    );
    expect(second.body.data.records.map((record) => record.id)).toEqual(["run-fraction-older"]);

    const filtered = await json<ListResponseBody>(
      `/api/trajectories?origin=test&startedAfter=${encodeURIComponent(
        "2026-07-10T14:30:00.0002Z"
      )}&startedBefore=${encodeURIComponent("2026-07-10T14:30:00.0005Z")}`
    );
    expect(filtered.body.data.records.map((record) => record.id)).toEqual(["run-fraction-newer"]);
  });

  it.each([
    ["sessionId=sess-web", ["run-web-z", "run-web-a"]],
    ["channelType=discord", ["run-channel"]],
    ["channelId=chan-1", ["run-channel"]],
    ["scheduleId=sched-1", ["run-schedule"]],
    ["origin=schedule", ["run-schedule"]],
    ["status=failed", ["run-schedule"]],
    ["model=model-web-a", ["run-web-a"]],
    ["tool=native__shell_execute", ["run-web-z"]],
    [
      `startedAfter=${encodeURIComponent("2026-07-10T11:30:00Z")}&startedBefore=${encodeURIComponent("2026-07-10T13:30:00Z")}`,
      ["run-schedule", "run-web-z", "run-web-a"],
    ],
  ])("filters with %s", async (query, expected) => {
    const { response, body } = await json<ListResponseBody>(`/api/trajectories?${query}`);
    expect(response.status).toBe(200);
    expect(body.data.records.map((record) => record.id)).toEqual(expected);
  });

  it("rejects malformed cursors and invalid filters", async () => {
    expect((await json<unknown>("/api/trajectories?cursor=***")).response.status).toBe(400);
    expect((await json<unknown>("/api/trajectories?cursor=")).response.status).toBe(400);
    const nonCanonicalCursor = Buffer.from(
      JSON.stringify({ v: 1, startedAt: "0", id: "run-latest" })
    ).toString("base64url");
    expect(
      (await json<unknown>(`/api/trajectories?cursor=${encodeURIComponent(nonCanonicalCursor)}`))
        .response.status
    ).toBe(400);
    expect((await json<unknown>("/api/trajectories?limit=0")).response.status).toBe(400);
    expect((await json<unknown>("/api/trajectories?status=unknown")).response.status).toBe(400);
    expect(
      (
        await json<unknown>(
          "/api/trajectories?startedAfter=2026-07-11T00:00:00Z&startedBefore=2026-07-10T00:00:00Z"
        )
      ).response.status
    ).toBe(400);
  });

  it("returns detail, missing-run errors, artifact refs, and bounded redacted bodies", async () => {
    const secret = "route-secret-must-not-leak";
    getDb()
      .prepare("UPDATE trajectories SET input = ?, output = ? WHERE id = ?")
      .run(
        JSON.stringify({ password: secret, body: "x".repeat(30_000) }),
        JSON.stringify({ apiToken: secret, body: "y".repeat(30_000) }),
        "run-web-z"
      );

    const { response, body } = await json<DetailResponseBody>("/api/trajectories/run-web-z");
    expect(response.status).toBe(200);
    expect(body.data.trajectory.artifacts).toEqual([
      expect.objectContaining({ artifactId: "run-web-z-artifact", locator: "trace://run-web-z" }),
    ]);
    expect(body.data.trajectory.input).toMatchObject({ truncated: true });
    expect(body.data.trajectory.output).toMatchObject({ truncated: true });
    expect(body.data.trajectory.payloadTruncation).toEqual({ input: true, output: true });
    expect(JSON.stringify(body)).not.toContain(secret);

    const source = await json<{
      data: {
        source: {
          input: { password: string; body: string };
          output: { apiToken: string; body: string };
          outputOmitted: boolean;
        };
      };
    }>("/api/trajectories/run-web-z/evaluation-source");
    expect(source.response.status).toBe(200);
    expect(source.body.data.source.input.body).toHaveLength(30_000);
    expect(source.body.data.source.output.body).toHaveLength(30_000);
    expect(source.body.data.source.outputOmitted).toBe(false);
    expect(JSON.stringify(source.body)).not.toContain(secret);

    const list = await json<ListResponseBody>("/api/trajectories?sessionId=sess-web");
    expect(list.body.data.records[0].input).toMatchObject({ truncated: true });
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect((await json<unknown>("/api/trajectories/missing-run")).response.status).toBe(404);
  });
});
