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
let initA2UIDb: typeof import("../../db/a2ui-store.ts").initA2UIDb;
let upsertSurface: typeof import("../../db/a2ui-store.ts").upsertSurface;

beforeAll(async () => {
  app = (await import("../a2ui.ts")).default;
  ({
    createCognitiveLoopRun,
    listCognitiveLoopEvents,
    getCognitiveLoopRun,
    updateCognitiveLoopRun,
  } = await import("../../db/cognitive-loop-store.ts"));
  ({ initA2UIDb, upsertSurface } = await import("../../db/a2ui-store.ts"));
  initA2UIDb();
});

async function postAction(body: Record<string, unknown>): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function emitAction(eventName: string, payload: Record<string, unknown> = {}): string {
  return `emit:${eventName}?${encodeURIComponent(JSON.stringify(payload))}`;
}

function upsertButtonSurface(
  surfaceId: string,
  sourceId: string,
  eventName: string,
  payload: Record<string, unknown> = {}
): void {
  upsertSurface({
    surfaceId,
    title: `Surface ${surfaceId}`,
    root: sourceId,
    rendering: true,
    components: {
      [sourceId]: {
        id: sourceId,
        component: {
          Button: {
            label: { literalString: sourceId },
            action: emitAction(eventName, payload),
          },
        },
      },
    },
  });
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
    upsertButtonSurface(`cognitive-loop-${run.id}`, "retry", "cognitive_loop.retry", {
      loopId: run.id,
    });

    const res = await postAction({
      surfaceId: `cognitive-loop-${run.id}`,
      sourceId: "retry",
      eventName: "cognitive_loop.retry",
      payload: { loopId: run.id },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; loopId: string; source: string; priority: number };
    };
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
    upsertButtonSurface(`cognitive-loop-${run.id}`, "escalate", "cognitive_loop.escalate", {
      loopId: run.id,
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

  it("returns 404 when the surface does not exist", async () => {
    const res = await postAction({
      surfaceId: "cognitive-loop-missing",
      sourceId: "retry",
      eventName: "cognitive_loop.retry",
      payload: { loopId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the loop id is not a valid UUID", async () => {
    upsertButtonSurface("cognitive-loop-bad", "retry", "cognitive_loop.retry");
    const res = await postAction({
      surfaceId: "cognitive-loop-bad",
      sourceId: "retry",
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
    upsertButtonSurface(`cognitive-loop-${run.id}`, "unknown", "cognitive_loop.unknown", {
      loopId: run.id,
    });
    const res = await postAction({
      surfaceId: `cognitive-loop-${run.id}`,
      sourceId: "unknown",
      eventName: "cognitive_loop.unknown",
      payload: { loopId: run.id },
    });
    expect(res.status).toBe(404);
  });

  it("rejects events when sourceId does not reference an actionable component", async () => {
    upsertSurface({
      surfaceId: "source-missing-action",
      title: "Source missing action",
      root: "text",
      rendering: true,
      components: {
        text: {
          id: "text",
          component: { Text: { text: { literalString: "Not clickable" } } },
        },
      },
    });

    const res = await postAction({
      surfaceId: "source-missing-action",
      sourceId: "text",
      eventName: "user.refresh",
    });

    expect(res.status).toBe(400);
  });

  it("rejects events that do not match the source component action", async () => {
    upsertButtonSurface("source-event-mismatch", "run", "safe.action");

    const res = await postAction({
      surfaceId: "source-event-mismatch",
      sourceId: "run",
      eventName: "dangerous.action",
    });

    expect(res.status).toBe(403);
  });

  it("queues generic A2UI events only from matching surface actions", async () => {
    upsertButtonSurface("generic-action-surface", "run", "user.refresh", {
      title: "Refresh dashboard",
      prompt: "Refresh this dashboard safely.",
    });

    const res = await postAction({
      surfaceId: "generic-action-surface",
      sourceId: "run",
      eventName: "user.refresh",
      payload: { title: "Refresh dashboard", prompt: "Refresh this dashboard safely." },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { title: string; source: string; loopId: string } };
    expect(body.data.title).toBe("Refresh dashboard");
    expect(body.data.source).toBe("a2ui");
    expect(getCognitiveLoopRun(body.data.loopId)?.trigger).toBe("a2ui");
  });

  it("accepts matching form submit actions", async () => {
    upsertSurface({
      surfaceId: "generic-form-surface",
      title: "Generic form",
      root: "form",
      rendering: true,
      components: {
        form: {
          id: "form",
          component: {
            Form: {
              children: { explicitList: [] },
              submitAction: emitAction("user.submit"),
            },
          },
        },
      },
    });

    const res = await postAction({
      surfaceId: "generic-form-surface",
      sourceId: "form",
      eventName: "user.submit",
      payload: { form: { note: "hello" } },
    });

    expect(res.status).toBe(201);
  });
});
