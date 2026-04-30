import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "chvor-a2ui-cognitive-loop-"));
process.env.CHVOR_DATA_DIR = tmp;

let app: typeof import("../a2ui.ts").default;
let createCognitiveLoopRun: typeof import("../../db/cognitive-loop-store.ts").createCognitiveLoopRun;
let listCognitiveLoopEvents: typeof import("../../db/cognitive-loop-store.ts").listCognitiveLoopEvents;
let getCognitiveLoopRun: typeof import("../../db/cognitive-loop-store.ts").getCognitiveLoopRun;
let updateCognitiveLoopRun: typeof import("../../db/cognitive-loop-store.ts").updateCognitiveLoopRun;

beforeAll(async () => {
  app = (await import("../a2ui.ts")).default;
  ({
    createCognitiveLoopRun,
    listCognitiveLoopEvents,
    getCognitiveLoopRun,
    updateCognitiveLoopRun,
  } = await import("../../db/cognitive-loop-store.ts"));
});

async function postAction(body: Record<string, unknown>): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /a2ui/actions — cognitive_loop dashboard branch", () => {
  it("queues a daemon retry task linked to the loop and resumes terminated loops", async () => {
    const run = createCognitiveLoopRun({
      title: "Dashboard retry loop",
      severity: "warning",
      trigger: "pulse",
      summary: "Needs a retry from the dashboard",
    });
    // Mark the loop as failed so we can verify resumeCognitiveLoop fires.
    updateCognitiveLoopRun(run.id, {
      status: "failed",
      currentStage: "loop.failed",
      completedAt: new Date().toISOString(),
    });

    const res = await postAction({
      surfaceId: `cognitive-loop-${run.id}`,
      sourceId: "retry",
      eventName: "cognitive_loop.retry",
      payload: { loopId: run.id },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; loopId: string; source: string; priority: number } };
    expect(body.data.loopId).toBe(run.id);
    expect(body.data.source).toBe("a2ui");
    expect(body.data.priority).toBe(2);

    const after = getCognitiveLoopRun(run.id);
    expect(after?.status).toBe("running");
    expect(after?.completedAt).toBeNull();

    const stages = listCognitiveLoopEvents(run.id).map((e) => e.stage);
    expect(stages).toContain("loop.resumed");
    expect(stages).toContain("playbook.action.requested");
    expect(stages).toContain("daemon.task.queued");
  });

  it("queues an escalate task with priority 3", async () => {
    const run = createCognitiveLoopRun({
      title: "Dashboard escalate loop",
      severity: "critical",
      trigger: "pulse",
      summary: "Needs escalation",
    });

    const res = await postAction({
      surfaceId: `cognitive-loop-${run.id}`,
      sourceId: "escalate",
      eventName: "cognitive_loop.escalate",
      payload: { loopId: run.id },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { priority: number; loopId: string } };
    expect(body.data.priority).toBe(3);
    expect(body.data.loopId).toBe(run.id);
  });

  it("returns 404 when the loop id does not exist", async () => {
    const res = await postAction({
      surfaceId: "cognitive-loop-missing",
      eventName: "cognitive_loop.retry",
      payload: { loopId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the loop id is not a valid UUID", async () => {
    const res = await postAction({
      surfaceId: "cognitive-loop-bad",
      eventName: "cognitive_loop.retry",
      payload: { loopId: "not-a-uuid; DROP TABLE cognitive_loop_runs;--" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown cognitive_loop.* event name", async () => {
    const run = createCognitiveLoopRun({
      title: "Unknown action loop",
      severity: "info",
      trigger: "pulse",
      summary: "Testing unknown action",
    });
    const res = await postAction({
      surfaceId: `cognitive-loop-${run.id}`,
      eventName: "cognitive_loop.unknown",
      payload: { loopId: run.id },
    });
    expect(res.status).toBe(404);
  });
});
