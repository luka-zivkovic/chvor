import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRecord, ChatMessage, ExecutionEvent } from "@chvor/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TrajectoryCaptureDependencies,
} from "../orchestrator/trajectory-adapter.ts";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-trajectory-adapter-"));
process.env.CHVOR_DATA_DIR = dataDir;

let adapter: typeof import("../orchestrator/trajectory-adapter.ts");
let storeModule: typeof import("../../db/trajectory-store.ts");
let runToolCalls: typeof import("../orchestrator/tool-call-runner.ts").runToolCalls;
let mcpManager: typeof import("../mcp-manager.ts").mcpManager;
let sanitizeResultForTrajectory: typeof import("../orchestrator/tool-result.ts").sanitizeResultForTrajectory;
let withSecretSeal: typeof import("../credential-injector.ts").withSecretSeal;
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;

const SECRET = "persist-me-not-trajectory-adapter-123456";
const BASE_TIME = Date.parse("2026-07-10T12:00:00.000Z");

function message(id = "message-1"): ChatMessage {
  return {
    id,
    role: "user",
    content: "Run the task",
    channelType: "web",
    timestamp: new Date(BASE_TIME).toISOString(),
  };
}

function testDependencies(prefix: string, logger?: TrajectoryCaptureDependencies["logger"]) {
  let id = 0;
  let tick = 0;
  return {
    id: () => `${prefix}-${++id}`,
    now: () => new Date(BASE_TIME + tick++ * 10),
    ...(logger ? { logger } : {}),
  };
}

function pendingApproval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    sessionId: "web:channel-1:default",
    actionId: "action-1",
    toolName: "native__shell_execute",
    kind: "native",
    args: { command: "echo safe", password: SECRET },
    risk: "high",
    reasons: ["Shell command requires confirmation"],
    checkpointId: "checkpoint-1",
    status: "pending",
    decision: null,
    decidedAt: null,
    decidedBy: null,
    createdAt: BASE_TIME + 100,
    expiresAt: BASE_TIME + 60_100,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function allTrajectoryRows(): string {
  const db = getDb();
  return JSON.stringify({
    trajectories: db.prepare("SELECT * FROM trajectories").all(),
    steps: db.prepare("SELECT * FROM trajectory_steps").all(),
    artifacts: db.prepare("SELECT * FROM trajectory_artifacts").all(),
  });
}

beforeAll(async () => {
  adapter = await import("../orchestrator/trajectory-adapter.ts");
  storeModule = await import("../../db/trajectory-store.ts");
  ({ runToolCalls } = await import("../orchestrator/tool-call-runner.ts"));
  ({ mcpManager } = await import("../mcp-manager.ts"));
  ({ sanitizeResultForTrajectory } = await import("../orchestrator/tool-result.ts"));
  ({ withSecretSeal } = await import("../credential-injector.ts"));
  ({ getDb, closeDb } = await import("../../db/database.ts"));
});

beforeEach(() => {
  adapter.clearTrajectorySecrets();
  getDb().prepare("DELETE FROM trajectories").run();
});

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("current-engine trajectory capture", () => {
  it("captures a completed model/tool lifecycle, redacts raw storage, and preserves public events", async () => {
    const firstEvent: ExecutionEvent = { type: "brain.thinking", data: { thought: "working" } };
    const secondEvent: ExecutionEvent = {
      type: "tool.invoked",
      data: { nodeId: "tool-1", toolId: "native__shell_execute" },
    };
    const emitted: ExecutionEvent[] = [];
    const result = { text: "done", hitRoundLimit: false, password: SECRET };

    const returned = await adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: (event) => emitted.push(event),
      context: {
        id: "completed-run",
        origin: { kind: "web-chat", sessionId: "session-1", channelType: "web" },
        actor: { type: "user", id: "user-1" },
        attributes: { engine: "current" },
      },
      dependencies: testDependencies("completed"),
      execute: async (emit) => {
        expect(adapter.getActiveTrajectoryId()).toBe("completed-run");
        emit(firstEvent);
        const requestId = adapter.recordTrajectoryModelStarted({
          providerId: "openai",
          modelId: "test-model",
          input: { authorization: `Bearer ${SECRET}`, safe: "keep" },
          round: 0,
        });
        adapter.recordTrajectoryModelFinished({
          requestStepId: requestId,
          output: { accessToken: SECRET, text: "model output" },
          inputTokens: 12,
          outputTokens: 5,
          totalTokens: 17,
          finishReason: "tool-calls",
        });
        adapter.recordTrajectoryToolRound({
          round: 0,
          calls: [
            {
              toolCallId: "call-1",
              toolName: "native__shell_execute",
              toolKind: "native",
              args: { password: SECRET, command: "echo safe" },
            },
          ],
          results: [
            {
              toolCallId: "call-1",
              toolName: "native__shell_execute",
              result: { accessToken: SECRET, stdout: "safe" },
              success: true,
            },
          ],
        });
        emit(secondEvent);
        return result;
      },
    });

    expect(returned).toBe(result);
    expect(emitted).toEqual([firstEvent, secondEvent]);
    expect(emitted[0]).toBe(firstEvent);
    expect(emitted[1]).toBe(secondEvent);
    expect(adapter.getActiveTrajectoryId()).toBeNull();

    const captured = storeModule.getTrajectory("completed-run")!;
    expect(captured.status).toBe("completed");
    expect(captured.output).toEqual({
      text: "done",
      hitRoundLimit: false,
      password: "[REDACTED]",
    });
    expect(captured.modelUsage).toEqual([
      expect.objectContaining({
        providerId: "openai",
        modelId: "test-model",
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
      }),
    ]);
    expect(captured.steps.map(({ kind }) => kind)).toEqual([
      "trajectory.started",
      "model.request",
      "model.response",
      "tool.call",
      "tool.result",
      "message.output",
      "trajectory.completed",
    ]);
    expect(captured.steps.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(captured.steps[3].input).toEqual({ password: "[REDACTED]", command: "echo safe" });
    expect(captured.steps[4].output).toEqual({ accessToken: "[REDACTED]", stdout: "safe" });
    expect(allTrajectoryRows()).not.toContain(SECRET);
  });

  it("records sequential tool results immediately in real execution order", async () => {
    await adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: () => undefined,
      context: {
        id: "ordered-tools-run",
        origin: { kind: "test", sessionId: "outer-session" },
        actor: { type: "test", id: "test" },
      },
      dependencies: testDependencies("ordered-tools"),
      execute: async () => {
        adapter.recordTrajectoryToolStarted({
          round: 1,
          call: { toolCallId: "call-1", toolName: "native__one", args: {} },
        });
        adapter.recordTrajectoryToolFinished({
          round: 1,
          result: { toolCallId: "call-1", result: { ok: true }, success: true },
        });
        adapter.recordTrajectoryToolStarted({
          round: 1,
          call: { toolCallId: "call-2", toolName: "native__two", args: {} },
        });
        adapter.recordTrajectoryToolFinished({
          round: 1,
          result: { toolCallId: "call-2", result: { ok: true }, success: true },
        });
        return { text: "done" };
      },
    });

    const steps = storeModule.getTrajectory("ordered-tools-run")!.steps.filter((step) =>
      ["tool.call", "tool.result"].includes(step.kind)
    );
    expect(steps.map((step) => `${step.kind}:${step.toolCall?.toolCallId}`)).toEqual([
      "tool.call:call-1",
      "tool.result:call-1",
      "tool.call:call-2",
      "tool.result:call-2",
    ]);
    expect(Date.parse(steps[1].completedAt!)).toBeGreaterThanOrEqual(
      Date.parse(steps[0].startedAt)
    );
  });

  it("wires the real tool runner to alternating call/result steps", async () => {
    await adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: () => undefined,
      context: {
        id: "tool-runner-order",
        origin: { kind: "test" },
        actor: { type: "test", id: "test" },
      },
      dependencies: testDependencies("tool-runner-order"),
      execute: async () => {
        await runToolCalls({
          round: 1,
          toolCalls: [
            { toolCallId: "unknown-1", toolName: "missing__one", args: {} },
            { toolCallId: "unknown-2", toolName: "missing__two", args: {} },
          ],
          currentMessages: [],
          emit: () => undefined,
          bagScope: {},
          preferredUsageContext: [],
          hitlAllowTurn: new Set(),
          toolSeverity: () => "low",
          collectEmotionOutcomes: false,
        });
        return { text: "done" };
      },
    });

    const steps = storeModule.getTrajectory("tool-runner-order")!.steps.filter((step) =>
      ["tool.call", "tool.result"].includes(step.kind)
    );
    expect(steps.map((step) => `${step.kind}:${step.toolCall?.toolCallId}`)).toEqual([
      "tool.call:unknown-1",
      "tool.result:unknown-1",
      "tool.call:unknown-2",
      "tool.result:unknown-2",
    ]);
  });

  it("keeps opaque credential-reveal values out of raw trajectory rows", async () => {
    const opaqueSecret = "opaque-credential-value-not-matched-by-token-patterns";
    const shortSecret = "q#7";
    await adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: () => undefined,
      context: {
        id: "credential-reveal-run",
        origin: { kind: "test" },
        actor: { type: "test", id: "test" },
      },
      dependencies: testDependencies("credential-reveal"),
      execute: async () => {
        await withSecretSeal([opaqueSecret, shortSecret], async () => undefined);
        const requestId = adapter.recordTrajectoryModelStarted({
          providerId: "test",
          modelId: "test",
        });
        adapter.recordTrajectoryModelFinished({
          requestStepId: requestId,
          output: { text: `echo ${opaqueSecret} and ${shortSecret}` },
        });
        adapter.recordTrajectoryToolStarted({
          round: 1,
          call: {
            toolCallId: "credential-call",
            toolName: "native__use_credential",
            toolKind: "native",
            args: {
              credentialId: "credential-1",
              revealValues: true,
              opaqueEcho: opaqueSecret,
            },
          },
        });
        adapter.recordTrajectoryToolFinished({
          round: 1,
          result: {
            toolCallId: "credential-call",
            toolName: "native__use_credential",
            result: sanitizeResultForTrajectory(
              { content: [{ type: "text", text: `X-API-Key=${opaqueSecret}` }] },
              undefined,
              "native__use_credential"
            ),
            success: true,
          },
        });
        return { text: `done ${opaqueSecret}` };
      },
    });

    expect(allTrajectoryRows()).not.toContain(opaqueSecret);
    expect(allTrajectoryRows()).not.toContain(shortSecret);
    expect(
      storeModule
        .getTrajectory("credential-reveal-run")!
        .steps.find((step) => step.kind === "tool.result")?.output
    ).toEqual({ content: [{ type: "text", text: "Credential retrieved." }] });
  });

  it("bounds message, model, and final output payloads before persistence", async () => {
    const oversized = "x".repeat(100_000);
    await adapter.runWithTrajectoryCapture({
      messages: [{ ...message(), content: oversized }],
      emit: () => undefined,
      context: {
        id: "bounded-payload-run",
        origin: { kind: "test" },
        actor: { type: "test", id: "test" },
      },
      dependencies: testDependencies("bounded-payload"),
      execute: async () => {
        const requestId = adapter.recordTrajectoryModelStarted({
          providerId: "test",
          modelId: "test",
        });
        adapter.recordTrajectoryModelFinished({
          requestStepId: requestId,
          output: { text: oversized },
        });
        return { text: oversized };
      },
    });

    const captured = storeModule.getTrajectory("bounded-payload-run")!;
    const inputText = (captured.input as Array<{ content: string }>)[0].content;
    const modelText = (
      captured.steps.find((step) => step.kind === "model.response")!.output as { text: string }
    ).text;
    const outputText = (captured.output as { text: string }).text;
    for (const value of [inputText, modelText, outputText]) {
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64_000);
      expect(value).toMatch(/\[TRUNCATED\]$/);
    }
  });

  it("aborts a hanging integration and terminalizes its trajectory before returning", async () => {
    const originalLookup = mcpManager.findToolForQualifiedName;
    const originalCall = mcpManager.callTool;
    mcpManager.findToolForQualifiedName = () => ({ toolId: "cancel", toolName: "hang" });
    mcpManager.callTool = async () => new Promise<never>(() => undefined);
    const controller = new AbortController();
    const events: ExecutionEvent[] = [];
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      await expect(
        adapter.runWithTrajectoryCapture({
          messages: [message()],
          emit: () => undefined,
          context: {
            id: "cancelled-tool-run",
            origin: { kind: "daemon" },
            actor: { type: "daemon", id: "task" },
          },
          abortSignal: controller.signal,
          dependencies: testDependencies("cancelled-tool"),
          execute: async () => {
            await runToolCalls({
              round: 1,
              toolCalls: [
                { toolCallId: "cancel-1", toolName: "cancel__hang", args: {} },
                { toolCallId: "cancel-2", toolName: "cancel__later", args: {} },
              ],
              currentMessages: [],
              emit: (event) => events.push(event),
              options: { abortSignal: controller.signal },
              bagScope: {},
              preferredUsageContext: [],
              hitlAllowTurn: new Set(),
              toolSeverity: () => "low",
              collectEmotionOutcomes: false,
            });
            return { text: "unreachable" };
          },
        })
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timer);
      mcpManager.findToolForQualifiedName = originalLookup;
      mcpManager.callTool = originalCall;
    }

    const captured = storeModule.getTrajectory("cancelled-tool-run")!;
    expect(events.some((event) => event.type === "tool.failed")).toBe(false);
    expect(captured.status).toBe("aborted");
    expect(captured.steps.map((step) => ({ kind: step.kind, status: step.status }))).toEqual([
      { kind: "trajectory.started", status: "completed" },
      { kind: "tool.call", status: "completed" },
      { kind: "tool.result", status: "failed" },
      { kind: "tool.call", status: "skipped" },
      { kind: "tool.result", status: "failed" },
      { kind: "trajectory.failed", status: "aborted" },
    ]);
  });

  it("records a failed result when the real tool runner throws outside a branch catch", async () => {
    const originalLookup = mcpManager.findToolForQualifiedName;
    const original = new Error("lookup failed");
    mcpManager.findToolForQualifiedName = () => {
      throw original;
    };
    try {
      await expect(
        adapter.runWithTrajectoryCapture({
          messages: [message()],
          emit: () => undefined,
          context: {
            id: "tool-runner-failure",
            origin: { kind: "test" },
            actor: { type: "test", id: "test" },
          },
          dependencies: testDependencies("tool-runner-failure"),
          execute: async () => {
            await runToolCalls({
              round: 1,
              toolCalls: [{ toolCallId: "broken-1", toolName: "broken__tool", args: {} }],
              currentMessages: [],
              emit: () => undefined,
              bagScope: {},
              preferredUsageContext: [],
              hitlAllowTurn: new Set(),
              toolSeverity: () => "low",
              collectEmotionOutcomes: false,
            });
            return { text: "unreachable" };
          },
        })
      ).rejects.toBe(original);
    } finally {
      mcpManager.findToolForQualifiedName = originalLookup;
    }

    expect(
      storeModule
        .getTrajectory("tool-runner-failure")!
        .steps.map((step) => ({ kind: step.kind, status: step.status }))
    ).toEqual([
      { kind: "trajectory.started", status: "completed" },
      { kind: "tool.call", status: "completed" },
      { kind: "tool.result", status: "failed" },
      { kind: "trajectory.failed", status: "failed" },
    ]);
  });

  it("preserves the exact thrown error while recording failed model and trajectory steps", async () => {
    const original = Object.assign(new Error(`provider secret=${SECRET}`), {
      code: "provider_failure",
    });

    await expect(
      adapter.runWithTrajectoryCapture({
        messages: [message()],
        emit: () => undefined,
        context: {
          id: "failed-run",
          origin: { kind: "test" },
          actor: { type: "test", id: "test" },
        },
        dependencies: testDependencies("failed"),
        execute: async () => {
          const requestId = adapter.recordTrajectoryModelStarted({
            providerId: "provider",
            modelId: "model",
          });
          adapter.recordTrajectoryModelFailed({ requestStepId: requestId, error: original });
          throw original;
        },
      })
    ).rejects.toBe(original);

    const captured = storeModule.getTrajectory("failed-run")!;
    expect(captured.status).toBe("failed");
    expect(captured.error).toEqual(
      expect.objectContaining({ code: "provider_failure", message: "provider secret=[REDACTED]" })
    );
    expect(captured.steps.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: "trajectory.started", status: "completed" },
      { kind: "model.request", status: "completed" },
      { kind: "model.response", status: "failed" },
      { kind: "trajectory.failed", status: "failed" },
    ]);
    expect(allTrajectoryRows()).not.toContain(SECRET);
  });

  it("classifies AbortError and an aborted signal as aborted without replacing the error", async () => {
    const controller = new AbortController();
    const original = Object.assign(new Error("stopped"), { name: "AbortError" });

    const promise = adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: () => undefined,
      context: {
        id: "aborted-run",
        origin: { kind: "web-chat" },
        actor: { type: "user", id: "user" },
      },
      abortSignal: controller.signal,
      dependencies: testDependencies("aborted"),
      execute: async () => {
        controller.abort();
        throw original;
      },
    });

    await expect(promise).rejects.toBe(original);
    const captured = storeModule.getTrajectory("aborted-run")!;
    expect(captured.status).toBe("aborted");
    expect(captured.steps.at(-1)).toEqual(
      expect.objectContaining({ kind: "trajectory.failed", status: "aborted" })
    );
  });

  it("does not start execution when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let executed = false;

    await expect(
      adapter.runWithTrajectoryCapture({
        messages: [message()],
        emit: () => undefined,
        context: {
          id: "pre-aborted-run",
          origin: { kind: "test" },
          actor: { type: "test", id: "test" },
        },
        abortSignal: controller.signal,
        dependencies: testDependencies("pre-aborted"),
        execute: async () => {
          executed = true;
          return { text: "unreachable" };
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(executed).toBe(false);
    expect(storeModule.getTrajectory("pre-aborted-run")?.status).toBe("aborted");
  });

  it("finalizes hitRoundLimit results as round-limited while preserving identity", async () => {
    const result = { text: "continue", hitRoundLimit: true };
    const returned = await adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: () => undefined,
      context: {
        id: "round-limited-run",
        origin: { kind: "channel", channelType: "slack" },
        actor: { type: "channel", id: "slack-channel" },
      },
      dependencies: testDependencies("round-limited"),
      execute: async () => result,
    });

    expect(returned).toBe(result);
    const captured = storeModule.getTrajectory("round-limited-run")!;
    expect(captured.status).toBe("round-limited");
    expect(captured.steps.at(-1)?.attributes).toEqual({ outcome: "round-limited" });
  });

  it("persists the actual approval identity, waits mid-flight, and resumes before completion", async () => {
    const requested = deferred<void>();
    const decide = deferred<void>();
    const resumed = deferred<void>();
    const finish = deferred<void>();
    const pending = pendingApproval();
    const resolved = pendingApproval({
      status: "allowed",
      decision: "allow-once",
      decidedAt: BASE_TIME + 1_000,
      decidedBy: "user-1",
    });

    const promise = adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: () => undefined,
      context: {
        id: "approval-run",
        origin: { kind: "web-chat", sessionId: "session-1" },
        actor: { type: "user", id: "user-1" },
      },
      dependencies: testDependencies("approval"),
      execute: async () => {
        adapter.recordTrajectoryToolStarted({
          round: 1,
          call: {
            toolCallId: "tool-call-1",
            toolName: pending.toolName,
            toolKind: "native",
            args: pending.args,
          },
        });
        adapter.recordTrajectoryApprovalRequested(pending, "tool-call-1");
        requested.resolve();
        await decide.promise;
        adapter.recordTrajectoryApprovalResolved(resolved, "tool-call-1");
        resumed.resolve();
        await finish.promise;
        adapter.recordTrajectoryToolRound({
          round: 1,
          calls: [
            {
              toolCallId: "tool-call-1",
              toolName: pending.toolName,
              toolKind: "native",
              args: pending.args,
            },
          ],
          results: [
            {
              toolCallId: "tool-call-1",
              toolName: pending.toolName,
              result: { password: SECRET },
              success: true,
            },
          ],
        });
        return { text: "approved" };
      },
    });

    await requested.promise;
    let captured = storeModule.getTrajectory("approval-run")!;
    expect(captured.status).toBe("waiting");
    const toolCallStep = captured.steps.find((step) => step.kind === "tool.call")!;
    expect(captured.steps.at(-1)).toEqual(
      expect.objectContaining({
        kind: "approval.requested",
        status: "waiting",
        parentStepId: toolCallStep.id,
        approval: expect.objectContaining({
          approvalId: "approval-1",
          requestedAt: new Date(BASE_TIME + 100).toISOString(),
          status: "pending",
        }),
      })
    );

    decide.resolve();
    await resumed.promise;
    captured = storeModule.getTrajectory("approval-run")!;
    expect(captured.status).toBe("running");
    expect(captured.steps.at(-1)?.approval).toEqual(
      expect.objectContaining({
        approvalId: "approval-1",
        status: "allowed",
        decision: "allow-once",
        resolvedAt: new Date(BASE_TIME + 1_000).toISOString(),
      })
    );
    expect(captured.steps.at(-1)?.parentStepId).toBe(toolCallStep.id);

    finish.resolve();
    await expect(promise).resolves.toEqual({ text: "approved" });
    captured = storeModule.getTrajectory("approval-run")!;
    expect(captured.status).toBe("completed");
    expect(
      captured.steps
        .filter((step) =>
          ["tool.call", "approval.requested", "approval.resolved", "tool.result"].includes(
            step.kind
          )
        )
        .map((step) => step.kind)
    ).toEqual(["tool.call", "approval.requested", "approval.resolved", "tool.result"]);
    expect(captured.steps.filter((step) => step.kind === "tool.call")).toHaveLength(1);
    expect(captured.steps.find((step) => step.kind === "tool.result")?.parentStepId).toBe(
      toolCallStep.id
    );
    expect(
      Date.parse(captured.steps.find((step) => step.kind === "tool.result")!.completedAt!)
    ).toBeGreaterThanOrEqual(
      Date.parse(captured.steps.find((step) => step.kind === "approval.resolved")!.completedAt!)
    );
    expect(allTrajectoryRows()).not.toContain(SECRET);
  });

  it.each([
    {
      name: "chat",
      fallback: { sessionId: "web:one:default", channelType: "web", channelId: "one" },
      origin: { kind: "web-chat", sessionId: "web:one:default", channelType: "web" },
      actor: { type: "session", id: "web:one:default" },
    },
    {
      name: "schedule",
      fallback: { sessionId: "sched-schedule-1", channelType: "scheduler" },
      origin: { kind: "schedule", scheduleId: "schedule-1", channelType: "scheduler" },
      actor: { type: "schedule", id: "schedule-1" },
    },
    {
      name: "webhook",
      fallback: {
        sessionId: "webhook-hook-1",
        channelType: "webhook",
        auditActor: { type: "webhook" as const, id: "hook-1" },
      },
      origin: { kind: "webhook", webhookId: "hook-1", channelType: "webhook" },
      actor: { type: "webhook", id: "hook-1" },
    },
    {
      name: "daemon",
      fallback: {
        channelType: "daemon",
        auditActor: { type: "daemon" as const, id: "task-1" },
      },
      origin: { kind: "daemon", channelType: "daemon" },
      actor: { type: "daemon", id: "task-1" },
    },
    {
      name: "cognitive loop",
      fallback: {
        channelType: "daemon",
        loopId: "loop-1",
        auditActor: { type: "daemon" as const, id: "task-2" },
      },
      origin: { kind: "cognitive-loop", loopId: "loop-1", channelType: "daemon" },
      actor: { type: "daemon", id: "task-2" },
    },
  ])("derives $name origin and actor context", async ({ name, fallback, origin, actor }) => {
    const deps = testDependencies(`origin-${name.replaceAll(" ", "-")}`);
    const id = await adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: () => undefined,
      ...fallback,
      dependencies: deps,
      execute: async () => adapter.getActiveTrajectoryId()!,
    });

    const captured = storeModule.getTrajectory(id)!;
    expect(captured.origin).toEqual(expect.objectContaining(origin));
    expect(captured.actor).toEqual(actor);
    expect(captured.attributes).toEqual({ contextDerived: true });
  });

  it("scopes nested active trajectory IDs and restores the outer ID", async () => {
    const seen: Array<string | null> = [];
    const origins: Array<unknown> = [];
    await adapter.runWithTrajectoryCapture({
      messages: [message("outer-message")],
      emit: () => undefined,
      context: {
        id: "outer-run",
        origin: { kind: "test", sessionId: "outer-session" },
        actor: { type: "test", id: "outer" },
      },
      dependencies: testDependencies("nested"),
      execute: async () => {
        seen.push(adapter.getActiveTrajectoryId());
        origins.push(adapter.getActiveTrajectoryOrigin());
        await adapter.runWithTrajectoryCapture({
          messages: [message("inner-message")],
          emit: () => undefined,
          context: {
            id: "inner-run",
            origin: { kind: "test", sessionId: "inner-session" },
            actor: { type: "test", id: "inner" },
          },
          dependencies: testDependencies("inner"),
          execute: async () => {
            seen.push(adapter.getActiveTrajectoryId());
            origins.push(adapter.getActiveTrajectoryOrigin());
            return "inner";
          },
        });
        seen.push(adapter.getActiveTrajectoryId());
        origins.push(adapter.getActiveTrajectoryOrigin());
        return "outer";
      },
    });

    seen.push(adapter.getActiveTrajectoryId());
    origins.push(adapter.getActiveTrajectoryOrigin());
    expect(seen).toEqual(["outer-run", "inner-run", "outer-run", null]);
    expect(origins).toEqual([
      { kind: "test", sessionId: "outer-session" },
      { kind: "test", sessionId: "inner-session" },
      { kind: "test", sessionId: "outer-session" },
      null,
    ]);
    expect(storeModule.getTrajectory("outer-run")?.status).toBe("completed");
    expect(storeModule.getTrajectory("inner-run")?.status).toBe("completed");
  });

  it("propagates nested credential taints to ancestor trajectories", async () => {
    const parentSecret = "parent-opaque-credential";
    const childSecret = "child-opaque-credential";
    await adapter.runWithTrajectoryCapture({
      messages: [message("outer-secret-message")],
      emit: () => undefined,
      context: {
        id: "secret-parent-run",
        origin: { kind: "test" },
        actor: { type: "test", id: "parent" },
      },
      dependencies: testDependencies("secret-parent"),
      execute: async () => {
        await withSecretSeal([parentSecret], async () => undefined);
        const childResult = await adapter.runWithTrajectoryCapture({
          messages: [{ ...message("child-secret-message"), content: parentSecret }],
          emit: () => undefined,
          context: {
            id: "secret-child-run",
            origin: { kind: "test" },
            actor: { type: "test", id: "child" },
          },
          dependencies: testDependencies("secret-child"),
          execute: async () => {
            await withSecretSeal([childSecret], async () => undefined);
            return { text: `${parentSecret} ${childSecret}` };
          },
        });
        return { childResult };
      },
    });

    expect(allTrajectoryRows()).not.toContain(parentSecret);
    expect(allTrajectoryRows()).not.toContain(childSecret);
    expect(storeModule.getTrajectory("secret-parent-run")?.output).toEqual({
      childResult: { text: "[REDACTED] [REDACTED]" },
    });
  });

  it("redacts overlapping exact secrets longest-first", async () => {
    const shorterSecret = "overlap-secret";
    const longerSecret = `${shorterSecret}-extended`;
    adapter.registerTrajectorySecrets([shorterSecret, longerSecret]);

    await adapter.runWithTrajectoryCapture({
      messages: [{ ...message(), content: longerSecret }],
      emit: () => undefined,
      context: {
        id: "overlapping-secret-run",
        origin: { kind: "test" },
        actor: { type: "test", id: "test" },
      },
      dependencies: testDependencies("overlapping-secret"),
      execute: async () => ({ text: longerSecret }),
    });

    const captured = storeModule.getTrajectory("overlapping-secret-run")!;
    expect((captured.input as unknown as ChatMessage[])[0].content).toBe("[REDACTED]");
    expect(captured.output).toEqual({ text: "[REDACTED]" });
    expect(allTrajectoryRows()).not.toContain(longerSecret);
    expect(allTrajectoryRows()).not.toContain("[REDACTED]-extended");
  });

  it("redacts cached MCP secrets on later runs while bounding and expiring retention", async () => {
    const cachedMcpSecret = "cached-mcp-credential-value";
    adapter.registerTrajectorySecrets([cachedMcpSecret]);

    await adapter.runWithTrajectoryCapture({
      messages: [{ ...message(), content: cachedMcpSecret }],
      emit: () => undefined,
      context: {
        id: "cached-mcp-secret-run",
        origin: { kind: "test" },
        actor: { type: "test", id: "test" },
      },
      dependencies: testDependencies("cached-mcp-secret"),
      execute: async () => "done",
    });

    expect(allTrajectoryRows()).not.toContain(cachedMcpSecret);
    expect(
      (storeModule.getTrajectory("cached-mcp-secret-run")!.input as unknown as ChatMessage[])[0]
        .content
    ).toBe("[REDACTED]");

    vi.useFakeTimers();
    try {
      adapter.clearTrajectorySecrets();
      const secrets = Array.from(
        { length: adapter.TRAJECTORY_SECRET_RETENTION_LIMIT + 25 },
        (_, index) => `bounded-secret-${index}`
      );
      adapter.registerTrajectorySecrets(secrets);
      expect(adapter.getTrajectorySecretRetentionStats()).toEqual({
        size: adapter.TRAJECTORY_SECRET_RETENTION_LIMIT,
        limit: adapter.TRAJECTORY_SECRET_RETENTION_LIMIT,
        retentionMs: adapter.TRAJECTORY_SECRET_RETENTION_MS,
      });

      vi.advanceTimersByTime(adapter.TRAJECTORY_SECRET_RETENTION_MS + 1);
      expect(adapter.getTrajectorySecretRetentionStats().size).toBe(0);
    } finally {
      adapter.clearTrajectorySecrets();
      vi.useRealTimers();
    }
  });

  it("redacts caller-seeded cached secrets after retained entries expire", async () => {
    const expiredCachedSecret = "expired-but-still-cached-mcp-secret";
    adapter.clearTrajectorySecrets();

    await adapter.runWithTrajectoryCapture({
      messages: [{ ...message(), content: expiredCachedSecret }],
      emit: () => undefined,
      initialSecrets: [expiredCachedSecret],
      context: {
        id: "caller-seeded-secret-run",
        origin: { kind: "test" },
        actor: { type: "test", id: "test" },
      },
      dependencies: testDependencies("caller-seeded-secret"),
      execute: async () => "done",
    });

    expect(allTrajectoryRows()).not.toContain(expiredCachedSecret);
    expect(
      (storeModule.getTrajectory("caller-seeded-secret-run")!.input as unknown as ChatMessage[])[0]
        .content
    ).toBe("[REDACTED]");
  });

});
