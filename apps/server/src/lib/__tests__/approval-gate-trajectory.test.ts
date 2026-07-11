import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalTrajectoryV1, GatewayServerEvent } from "@chvor/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-synth-approval-trajectory-"));
process.env.CHVOR_DATA_DIR = dataDir;

let adapter: typeof import("../orchestrator/trajectory-adapter.ts");
let requestApproval: typeof import("../approval-gate.ts").requestApproval;
let resolveSynthesizedApproval: typeof import("../approval-gate.ts").resolveSynthesizedApproval;
let getTrajectory: typeof import("../../db/trajectory-store.ts").getTrajectory;
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;
let setWSInstance: typeof import("../../gateway/ws-instance.ts").setWSInstance;

const events: GatewayServerEvent[] = [];
const clientId = "approval-client";

function installWS(): void {
  setWSInstance({
    sendTo: (_target: string, event: GatewayServerEvent) => {
      events.push(event);
      return true;
    },
    broadcast: (event: GatewayServerEvent) => events.push(event),
  } as never);
}

function approvalArgs(overrides: Partial<Parameters<typeof requestApproval>[0]> = {}) {
  return {
    sessionId: "synth-approval-session",
    originClientId: clientId,
    toolId: "github-lite",
    toolName: "GitHub Lite",
    endpointName: "create-issue",
    method: "POST",
    path: "/issues",
    resolvedUrl: "https://api.example.com/issues",
    argsPreview: '{"title":"A bug"}',
    body: { title: "A bug" },
    verified: true,
    source: "openapi" as const,
    toolCallId: "synth-approval-call",
    ...overrides,
  };
}

function runApproval(
  id: string,
  overrides: Partial<Parameters<typeof requestApproval>[0]> = {},
  afterApproval?: () => Promise<void>
) {
  return adapter.runWithTrajectoryCapture({
    messages: [],
    emit: () => undefined,
    context: {
      id,
      origin: { kind: "web-chat", sessionId: overrides.sessionId ?? "synth-approval-session" },
      actor: { type: "user", id: "approval-user" },
    },
    execute: async () => {
      const args = approvalArgs(overrides);
      adapter.recordTrajectoryToolStarted({
        round: 1,
        call: {
          toolCallId: args.toolCallId,
          toolName: `${args.toolId}__${args.endpointName}`,
          args: args.body ?? {},
          toolKind: "synthesized",
        },
      });
      const result = await requestApproval(args);
      await afterApproval?.();
      adapter.recordTrajectoryToolFinished({
        round: 1,
        result: {
          toolCallId: args.toolCallId,
          toolName: `${args.toolId}__${args.endpointName}`,
          result,
          success: result.allowed,
        },
      });
      return result;
    },
  });
}

async function waitForConfirm(): Promise<Extract<GatewayServerEvent, { type: "synthesized.confirm" }>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const event = events.find(
      (candidate): candidate is Extract<GatewayServerEvent, { type: "synthesized.confirm" }> =>
        candidate.type === "synthesized.confirm"
    );
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("synthesized approval prompt was not emitted");
}

function approvalSteps(trajectory: CanonicalTrajectoryV1) {
  return trajectory.steps.filter((step) => step.kind.startsWith("approval."));
}

beforeAll(async () => {
  adapter = await import("../orchestrator/trajectory-adapter.ts");
  ({ requestApproval, resolveSynthesizedApproval } = await import("../approval-gate.ts"));
  ({ getTrajectory } = await import("../../db/trajectory-store.ts"));
  ({ getDb, closeDb } = await import("../../db/database.ts"));
  ({ setWSInstance } = await import("../../gateway/ws-instance.ts"));
});

beforeEach(() => {
  events.length = 0;
  getDb().prepare("DELETE FROM trajectories").run();
  installWS();
});

afterAll(() => {
  setWSInstance(null);
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("synthesized approval trajectory capture", () => {
  it("marks the trajectory waiting and records an allowed decision", async () => {
    let resume!: () => void;
    const holdAfterApproval = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const promise = runApproval(
      "synth-approved",
      { sessionId: "approved-session" },
      () => holdAfterApproval
    );
    const event = await waitForConfirm();

    const waiting = getTrajectory("synth-approved")!;
    const callStep = waiting.steps.find((step) => step.kind === "tool.call")!;
    expect(waiting.status).toBe("waiting");
    expect(approvalSteps(waiting)).toEqual([
      expect.objectContaining({
        kind: "approval.requested",
        status: "waiting",
        parentStepId: callStep.id,
        approval: expect.objectContaining({ kind: "synthesized", status: "pending" }),
      }),
    ]);

    expect(resolveSynthesizedApproval(
      event.data.requestId,
      { requestId: event.data.requestId, decision: "allow-once" },
      clientId
    )).toBe(true);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (getTrajectory("synth-approved")?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(getTrajectory("synth-approved")?.status).toBe("running");
    expect(approvalSteps(getTrajectory("synth-approved")!).at(-1)?.kind).toBe(
      "approval.resolved"
    );
    resume();
    await expect(promise).resolves.toEqual({ allowed: true, persisted: false });

    const completed = getTrajectory("synth-approved")!;
    expect(completed.status).toBe("completed");
    expect(approvalSteps(completed).map((step) => step.kind)).toEqual([
      "approval.requested",
      "approval.resolved",
    ]);
    expect(approvalSteps(completed)[1]).toMatchObject({
      status: "completed",
      output: { status: "allowed", decision: "allow-once", decidedBy: "user" },
      approval: { kind: "synthesized", status: "allowed", decision: "allow-once" },
    });
  });

  it("records denied and aborted waits as terminal approval resolutions", async () => {
    const deniedPromise = runApproval("synth-denied", { sessionId: "denied-session" });
    const deniedEvent = await waitForConfirm();
    resolveSynthesizedApproval(
      deniedEvent.data.requestId,
      { requestId: deniedEvent.data.requestId, decision: "deny" },
      clientId
    );
    await expect(deniedPromise).resolves.toEqual({ allowed: false, reason: "denied" });
    expect(approvalSteps(getTrajectory("synth-denied")!)[1]).toMatchObject({
      output: { status: "denied", decision: "deny", decidedBy: "user" },
    });

    events.length = 0;
    const controller = new AbortController();
    const abortedPromise = runApproval("synth-aborted", {
      sessionId: "aborted-session",
      abortSignal: controller.signal,
    });
    await waitForConfirm();
    expect(getTrajectory("synth-aborted")?.status).toBe("waiting");
    controller.abort();
    await expect(abortedPromise).resolves.toEqual({ allowed: false, reason: "aborted" });
    expect(approvalSteps(getTrajectory("synth-aborted")!)[1]).toMatchObject({
      output: { status: "expired", decidedBy: "system" },
      approval: { status: "expired" },
    });
  });

  it("does not create approval steps for no-WS or session-cached outcomes", async () => {
    setWSInstance(null);
    await expect(runApproval("synth-no-ws", { sessionId: "no-ws-session" })).resolves.toEqual({
      allowed: false,
      reason: "no-ws",
    });
    expect(approvalSteps(getTrajectory("synth-no-ws")!)).toEqual([]);

    installWS();
    const first = runApproval("synth-cache-seed", { sessionId: "cache-session" });
    const event = await waitForConfirm();
    resolveSynthesizedApproval(
      event.data.requestId,
      { requestId: event.data.requestId, decision: "allow-session" },
      clientId
    );
    await expect(first).resolves.toEqual({ allowed: true, persisted: true });

    setWSInstance(null);
    await expect(runApproval("synth-cache-hit", { sessionId: "cache-session" })).resolves.toEqual({
      allowed: true,
      persisted: true,
    });
    expect(approvalSteps(getTrajectory("synth-cache-hit")!)).toEqual([]);
  });

  it("registers the waiter before sending and suppresses pre-aborted prompts", async () => {
    setWSInstance({
      sendTo: (_target: string, event: GatewayServerEvent) => {
        events.push(event);
        if (event.type === "synthesized.confirm") {
          resolveSynthesizedApproval(
            event.data.requestId,
            { requestId: event.data.requestId, decision: "allow-once" },
            clientId
          );
        }
        return true;
      },
      broadcast: (event: GatewayServerEvent) => events.push(event),
    } as never);

    await expect(
      runApproval("synth-immediate", { sessionId: "immediate-session" })
    ).resolves.toEqual({ allowed: true, persisted: false });
    expect(approvalSteps(getTrajectory("synth-immediate")!).map((step) => step.kind)).toEqual([
      "approval.requested",
      "approval.resolved",
    ]);

    events.length = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(
      runApproval("synth-pre-aborted", {
        sessionId: "pre-aborted-session",
        abortSignal: controller.signal,
      })
    ).resolves.toEqual({ allowed: false, reason: "aborted" });
    expect(events).toEqual([]);
    expect(approvalSteps(getTrajectory("synth-pre-aborted")!)).toEqual([]);
  });
});
