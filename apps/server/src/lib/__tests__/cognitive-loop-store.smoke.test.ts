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
let getCognitiveLoopRun: typeof import("../../db/cognitive-loop-store.ts").getCognitiveLoopRun;
let createDaemonTask: typeof import("../../db/daemon-store.ts").createDaemonTask;
let completeCognitiveLoop: typeof import("../cognitive-loop.ts").completeCognitiveLoop;
let recoverStaleCognitiveLoops: typeof import("../cognitive-loop.ts").recoverStaleCognitiveLoops;
let startLoopPlaybook: typeof import("../cognitive-loop-playbooks.ts").startLoopPlaybook;
let queueLoopPlaybookDaemonStep: typeof import("../cognitive-loop-playbooks.ts").queueLoopPlaybookDaemonStep;
let getDb: typeof import("../../db/database.ts").getDb;

beforeAll(async () => {
  ({
    createCognitiveLoopRun,
    appendCognitiveLoopEvent,
    listCognitiveLoopEvents,
    updateCognitiveLoopRun,
    listRunningCognitiveLoopRuns,
    getCognitiveLoopRun,
  } = await import("../../db/cognitive-loop-store.ts"));
  ({ createDaemonTask } = await import("../../db/daemon-store.ts"));
  ({ completeCognitiveLoop, recoverStaleCognitiveLoops } = await import("../cognitive-loop.ts"));
  ({ startLoopPlaybook, queueLoopPlaybookDaemonStep } =
    await import("../cognitive-loop-playbooks.ts"));
  ({ getDb } = await import("../../db/database.ts"));
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
    expect(run.parentLoopId).toBeNull();
    expect(run.parentEventId).toBeNull();
    expect(run.branchReason).toBeNull();
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

  it("persists run-level branch lineage", () => {
    const source = createCognitiveLoopRun({
      title: "Source loop",
      severity: "info",
      trigger: "manual",
      summary: "Original timeline",
    });
    const event = appendCognitiveLoopEvent({
      loopId: source.id,
      stage: "pulse.detected",
      title: "Branch point",
    });

    const branch = createCognitiveLoopRun({
      title: "Branch loop",
      severity: "info",
      trigger: "manual",
      summary: "Alternative timeline",
      parentLoopId: source.id,
      parentEventId: event.id,
      branchReason: "Try a safer path",
    });

    expect(branch.parentLoopId).toBe(source.id);
    expect(branch.parentEventId).toBe(event.id);
    expect(branch.branchReason).toBe("Try a safer path");
    expect(getCognitiveLoopRun(branch.id)?.parentLoopId).toBe(source.id);
  });

  it("completeCognitiveLoop transitions a running loop to completed via the wrapper", () => {
    const run = createCognitiveLoopRun({
      title: "Pulse-success loop",
      severity: "info",
      trigger: "pulse",
      summary: "Pulse recorded with no remediation needed",
    });
    expect(run.status).toBe("running");

    completeCognitiveLoop(run.id, "Loop completed", "Pulse recorded, no remediation queued.");

    const after = getCognitiveLoopRun(run.id);
    expect(after?.status).toBe("completed");
    expect(after?.currentStage).toBe("loop.completed");
    expect(after?.completedAt).not.toBeNull();
    const events = listCognitiveLoopEvents(run.id);
    expect(events.some((e) => e.stage === "loop.completed")).toBe(true);
  });

  it("recoverStaleCognitiveLoops marks running loops past the staleness threshold as failed", () => {
    const fresh = createCognitiveLoopRun({
      title: "Fresh loop",
      severity: "info",
      trigger: "a2ui",
      summary: "Recently active",
    });
    const stale = createCognitiveLoopRun({
      title: "Stale loop",
      severity: "warning",
      trigger: "pulse",
      summary: "Last activity was a long time ago",
    });

    // Backdate the stale loop's updated_at to an hour ago — past the 30-min default cutoff.
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    getDb()
      .prepare("UPDATE cognitive_loop_runs SET updated_at = ? WHERE id = ?")
      .run(oldTs, stale.id);

    const recovered = recoverStaleCognitiveLoops();
    expect(recovered).toBeGreaterThanOrEqual(1);

    expect(getCognitiveLoopRun(stale.id)?.status).toBe("failed");
    expect(getCognitiveLoopRun(fresh.id)?.status).toBe("running");
  });

  it("records playbook starts and queues dashboard-requested daemon steps", () => {
    const run = createCognitiveLoopRun({
      title: "Playbook loop",
      severity: "warning",
      trigger: "manual",
      summary: "Needs a follow-up step",
    });

    startLoopPlaybook(run.id, "health_anomaly", { test: true });
    const task = queueLoopPlaybookDaemonStep({
      loopId: run.id,
      action: "retry",
      title: "Retry test step",
      priority: 2,
    });

    expect(task?.loopId).toBe(run.id);
    expect(task?.title).toBe("Retry test step");

    const events = listCognitiveLoopEvents(run.id);
    const started = events.find((e) => e.stage === "playbook.started");
    expect(started).toBeTruthy();
    expect(started?.metadata).toMatchObject({
      stepIds: [
        "detect-pulse-delta",
        "consolidate-memory",
        "queue-daemon-investigation",
        "repair-or-summarize",
        "update-live-dashboard",
      ],
    });
    expect(events.some((e) => e.stage === "playbook.action.requested")).toBe(true);
    const queued = events.find((e) => e.stage === "daemon.task.queued");
    expect(queued?.metadata).toMatchObject({
      stepIndex: 2,
      stepId: "queue-daemon-investigation",
      stepName: "Queue daemon investigation",
    });
  });
});
