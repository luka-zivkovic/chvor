import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "chvor-cognitive-loop-"));
process.env.CHVOR_DATA_DIR = tmp;

let createCognitiveLoopRun: typeof import("../../db/cognitive-loop-store.ts").createCognitiveLoopRun;
let appendCognitiveLoopEvent: typeof import("../../db/cognitive-loop-store.ts").appendCognitiveLoopEvent;
let listCognitiveLoopEvents: typeof import("../../db/cognitive-loop-store.ts").listCognitiveLoopEvents;
let updateCognitiveLoopRun: typeof import("../../db/cognitive-loop-store.ts").updateCognitiveLoopRun;
let listRunningCognitiveLoopRuns: typeof import("../../db/cognitive-loop-store.ts").listRunningCognitiveLoopRuns;
let createDaemonTask: typeof import("../../db/daemon-store.ts").createDaemonTask;

beforeAll(async () => {
  ({
    createCognitiveLoopRun,
    appendCognitiveLoopEvent,
    listCognitiveLoopEvents,
    updateCognitiveLoopRun,
    listRunningCognitiveLoopRuns,
  } = await import("../../db/cognitive-loop-store.ts"));
  ({ createDaemonTask } = await import("../../db/daemon-store.ts"));
});

describe("cognitive-loop store", () => {
  it("persists run/event timeline and links daemon tasks", () => {
    const run = createCognitiveLoopRun({
      title: "Test loop",
      severity: "warning",
      trigger: "pulse",
      summary: "Something happened",
    });
    expect(run.status).toBe("running");
    expect(listRunningCognitiveLoopRuns().some((r) => r.id === run.id)).toBe(true);

    const event = appendCognitiveLoopEvent({
      loopId: run.id,
      stage: "pulse.detected",
      title: "Pulse detected",
      metadata: { ok: true },
    });
    expect(event.loopId).toBe(run.id);
    expect(listCognitiveLoopEvents(run.id)).toHaveLength(1);

    const task = createDaemonTask({
      title: "Fix it",
      prompt: "Do the remediation",
      source: "pulse",
      priority: 2,
      loopId: run.id,
    });
    expect(task.loopId).toBe(run.id);

    const completed = updateCognitiveLoopRun(run.id, {
      status: "completed",
      currentStage: "loop.completed",
      completedAt: new Date().toISOString(),
    });
    expect(completed?.status).toBe("completed");
  });
});
