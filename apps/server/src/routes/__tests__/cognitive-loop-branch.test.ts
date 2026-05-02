import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "chvor-cognitive-loop-branch-"));
process.env.CHVOR_DATA_DIR = tmp;

let app: typeof import("../cognitive-loop.ts").default;
let createCognitiveLoopRun: typeof import("../../db/cognitive-loop-store.ts").createCognitiveLoopRun;
let appendStoredCognitiveLoopEvent: typeof import("../../db/cognitive-loop-store.ts").appendCognitiveLoopEvent;
let listCognitiveLoopEvents: typeof import("../../db/cognitive-loop-store.ts").listCognitiveLoopEvents;

beforeAll(async () => {
  app = (await import("../cognitive-loop.ts")).default;
  ({
    createCognitiveLoopRun,
    appendCognitiveLoopEvent: appendStoredCognitiveLoopEvent,
    listCognitiveLoopEvents,
  } = await import("../../db/cognitive-loop-store.ts"));
});

async function postBranch(loopId: string, body: Record<string, unknown>): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/${loopId}/branch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /cognitive-loops/:id/branch", () => {
  it("creates a new branch loop and queues linked daemon work", async () => {
    const source = createCognitiveLoopRun({
      title: "Source health loop",
      severity: "warning",
      trigger: "pulse",
      summary: "Original remediation timeline",
    });
    const first = appendStoredCognitiveLoopEvent({
      loopId: source.id,
      stage: "pulse.detected",
      title: "Pulse detected an issue",
      body: "MCP server was down",
    });
    appendStoredCognitiveLoopEvent({
      loopId: source.id,
      stage: "memory.consolidation.completed",
      title: "Memory consolidated",
    });

    const res = await postBranch(source.id, { eventId: first.id });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        run: { id: string; title: string; trigger: string; severity: string };
        task: { loopId: string; priority: number; prompt: string };
        sourceLoopId: string;
        sourceEventId: string;
      };
    };

    expect(body.data.run.id).not.toBe(source.id);
    expect(body.data.run.trigger).toBe("manual");
    expect(body.data.run.severity).toBe("warning");
    expect(body.data.task.loopId).toBe(body.data.run.id);
    expect(body.data.task.priority).toBe(2);
    expect(body.data.task.prompt).toContain(source.id);
    expect(body.data.task.prompt).toContain("Pulse detected an issue");
    expect(body.data.task.prompt).not.toContain("Memory consolidated");
    expect(body.data.sourceLoopId).toBe(source.id);
    expect(body.data.sourceEventId).toBe(first.id);

    const stages = listCognitiveLoopEvents(body.data.run.id).map((event) => event.stage);
    expect(stages).toEqual(["playbook.action.requested", "daemon.task.queued"]);
  });

  it("returns 404 when the requested event is not part of the source loop", async () => {
    const source = createCognitiveLoopRun({
      title: "Missing event branch",
      severity: "info",
      trigger: "manual",
      summary: "No matching event",
    });

    const res = await postBranch(source.id, { eventId: "missing-event" });
    expect(res.status).toBe(404);
  });
});
