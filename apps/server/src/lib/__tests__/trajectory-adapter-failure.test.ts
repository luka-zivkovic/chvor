import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_LAYER_ORDER,
  CONTEXT_LAYER_POLICIES,
  parseContextAssembly,
  projectContextAssemblyTrace,
  type ApprovalRecord,
  type ChatMessage,
  type ExecutionEvent,
} from "@chvor/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  TrajectoryCaptureDependencies,
  TrajectoryCaptureStore,
} from "../orchestrator/trajectory-adapter.ts";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-trajectory-adapter-failure-"));
process.env.CHVOR_DATA_DIR = dataDir;
const BASE_TIME = Date.parse("2026-07-10T12:00:00.000Z");
const PRIVATE_CONTEXT_BODY = "PRIVATE_CONTEXT_BODY_adapter_1d6f82";

let adapter: typeof import("../orchestrator/trajectory-adapter.ts");
let storeModule: typeof import("../../db/trajectory-store.ts");
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;

function message(): ChatMessage {
  return {
    id: "failure-message",
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

function runtimeContextAssembly(content: string = PRIVATE_CONTEXT_BODY) {
  const layers = CONTEXT_LAYER_ORDER.map((layer, index) => {
    const policy = structuredClone(CONTEXT_LAYER_POLICIES[index]);
    const included = index === 0 ? 5 : 0;
    return {
      layer,
      policy,
      tokenBudget: index === 0 ? 20 : 0,
      items:
        index === 0
          ? [
              {
                id: "context-item-identity",
                owner: "system",
                mutability: "immutable",
                modelVisibility: "always",
                authority: "system",
                reference: { namespace: "context", id: "identity-1", revision: "1" },
                source: { kind: "block", id: "block-1", revision: "1" },
                representation: { kind: "full", id: "identity.full", version: "1" },
                ordering: { canonicalRank: 1, declaredOrder: 0 },
                inclusionReasons: [{ kind: "required", code: "contract-required" }],
                accounting: {
                  sourceTokens: included,
                  includedTokens: included,
                  truncatedTokens: 0,
                },
                content,
              },
            ]
          : [],
      accounting: {
        sourceTokens: included,
        includedTokens: included,
        truncatedTokens: 0,
        overflowTokens: 0,
      },
    };
  });
  return parseContextAssembly({
    schemaVersion: 1,
    id: "assembly-adapter",
    createdAt: new Date(BASE_TIME).toISOString(),
    configuration: {
      tokenizer: { id: "test-tokenizer", version: "1" },
      retrievalScoring: { id: "test-scoring", version: "1" },
      contextWindowTokens: 100,
      systemInstructionTokens: 20,
      developerInstructionTokens: 10,
      currentRequestTokens: 10,
      otherPromptTokens: 10,
      responseReserveTokens: 20,
      toolDefinitionTokens: 10,
      hierarchyBudgetTokens: 20,
    },
    layers,
    accounting: {
      sourceTokens: 5,
      includedTokens: 5,
      truncatedTokens: 0,
      overflowTokens: 0,
    },
  });
}

function productionStore(): TrajectoryCaptureStore {
  return {
    createTrajectory: storeModule.createTrajectory,
    appendTrajectoryStep: storeModule.appendTrajectoryStep,
    updateTrajectoryMetadata: storeModule.updateTrajectoryMetadata,
    markTrajectoryInterrupted: storeModule.markTrajectoryInterrupted,
  };
}

function allTrajectoryRows(): string {
  const db = getDb();
  return JSON.stringify({
    trajectories: db.prepare("SELECT * FROM trajectories").all(),
    steps: db.prepare("SELECT * FROM trajectory_steps").all(),
  });
}

function pendingApproval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    sessionId: "web:channel-1:default",
    actionId: "action-1",
    toolName: "native__shell_execute",
    kind: "native",
    args: { command: "echo safe" },
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

beforeAll(async () => {
  adapter = await import("../orchestrator/trajectory-adapter.ts");
  storeModule = await import("../../db/trajectory-store.ts");
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

describe("context assembly trajectory capture", () => {
  it("records exactly one completed content-free trace from a runtime assembly", async () => {
    const assembly = runtimeContextAssembly();
    const expectedTrace = projectContextAssemblyTrace(assembly);

    expect(adapter.recordTrajectoryContextAssembled(assembly)).toBeNull();
    await adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: () => undefined,
      context: {
        id: "context-assembly-run",
        origin: { kind: "test" },
        actor: { type: "test", id: "test" },
      },
      dependencies: testDependencies("context-assembly"),
      execute: async () => {
        expect(adapter.recordTrajectoryContextAssembled(assembly)).not.toBeNull();
        return { text: "context assembled" };
      },
    });

    const captured = storeModule.getTrajectory("context-assembly-run")!;
    const contextSteps = captured.steps.filter((step) => step.kind === "context.assembled");
    expect(contextSteps).toHaveLength(1);
    expect(contextSteps[0]).toEqual(
      expect.objectContaining({
        status: "completed",
        durationMs: 0,
        contextAssembly: expectedTrace,
      })
    );
    expect(contextSteps[0].completedAt).toBe(contextSteps[0].startedAt);
    expect(JSON.stringify(contextSteps[0])).not.toContain('"content"');
    expect(JSON.stringify(captured)).not.toContain(PRIVATE_CONTEXT_BODY);
    expect(allTrajectoryRows()).not.toContain(PRIVATE_CONTEXT_BODY);
  });

  it("accepts an already projected trace without duplicating the step", async () => {
    const trace = projectContextAssemblyTrace(runtimeContextAssembly("another-private-body"));
    await adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: () => undefined,
      context: {
        id: "context-trace-run",
        origin: { kind: "test" },
        actor: { type: "test", id: "test" },
      },
      dependencies: testDependencies("context-trace"),
      execute: async () => {
        adapter.recordTrajectoryContextAssembled(trace);
        return { text: "trace recorded" };
      },
    });

    const contextSteps = storeModule
      .getTrajectory("context-trace-run")!
      .steps.filter((step) => step.kind === "context.assembled");
    expect(contextSteps).toHaveLength(1);
    expect(contextSteps[0].contextAssembly).toEqual(trace);
  });
});

describe("trajectory instrumentation failure isolation", () => {
  it("preserves execution when context trace projection fails", async () => {
    const warnings: unknown[][] = [];
    const result = { text: "invalid context instrumentation survived" };

    const returned = await adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: () => undefined,
      context: {
        id: "context-projection-fault-run",
        origin: { kind: "test" },
        actor: { type: "test", id: "fault" },
      },
      dependencies: {
        ...testDependencies("context-projection-fault"),
        logger: { warn: (...args) => warnings.push(args) },
      },
      execute: async () => {
        expect(adapter.recordTrajectoryContextAssembled({} as never)).toBeNull();
        return result;
      },
    });

    expect(returned).toBe(result);
    expect(warnings).toHaveLength(1);
    const captured = storeModule.getTrajectory("context-projection-fault-run")!;
    expect(captured.status).toBe("completed");
    expect(captured.steps.map((step) => step.kind)).toEqual(["trajectory.started"]);
  });

  it.each(["create", "append"] as const)(
    "opens the circuit on %s failure while preserving result and public events",
    async (failure) => {
      const warnings: unknown[][] = [];
      const base = productionStore();
      const broken: TrajectoryCaptureStore = {
        ...base,
        ...(failure === "create"
          ? { createTrajectory: () => { throw new Error("create unavailable"); } }
          : { appendTrajectoryStep: () => { throw new Error("append unavailable"); } }),
      };
      const event: ExecutionEvent = { type: "brain.thinking", data: { thought: failure } };
      const emitted: ExecutionEvent[] = [];
      const result = { text: `${failure} survived` };

      const returned = await adapter.runWithTrajectoryCapture({
        messages: [message()],
        emit: (value) => emitted.push(value),
        context: {
          id: `${failure}-fault-run`,
          origin: { kind: "test" },
          actor: { type: "test", id: "fault" },
        },
        dependencies: {
          ...testDependencies(`${failure}-fault`),
          store: broken,
          logger: { warn: (...args) => warnings.push(args) },
        },
        execute: async (emit) => {
          emit(event);
          adapter.recordTrajectoryModelStarted({ providerId: "p", modelId: "m" });
          return result;
        },
      });

      expect(returned).toBe(result);
      expect(emitted).toEqual([event]);
      expect(emitted[0]).toBe(event);
      expect(warnings).toHaveLength(1);
    }
  );

  it("terminalizes after an approval state capture failure", async () => {
    const warnings: unknown[][] = [];
    const base = productionStore();
    const broken: TrajectoryCaptureStore = {
      ...base,
      updateTrajectoryMetadata: (id, update) => {
        if (update.status === "waiting") throw new Error("state unavailable");
        return base.updateTrajectoryMetadata(id, update);
      },
    };
    const result = { text: "state failure survived" };

    const returned = await adapter.runWithTrajectoryCapture({
      messages: [message()],
      emit: () => undefined,
      context: {
        id: "state-fault-run",
        origin: { kind: "test" },
        actor: { type: "test", id: "fault" },
      },
      dependencies: {
        ...testDependencies("state-fault"),
        store: broken,
        logger: { warn: (...args) => warnings.push(args) },
      },
      execute: async () => {
        adapter.recordTrajectoryApprovalRequested(pendingApproval());
        adapter.recordTrajectoryApprovalResolved(
          pendingApproval({
            status: "denied",
            decision: "deny",
            decidedAt: BASE_TIME + 1_000,
            decidedBy: "user",
          })
        );
        return result;
      },
    });

    expect(returned).toBe(result);
    expect(warnings).toHaveLength(1);
    const captured = storeModule.getTrajectory("state-fault-run")!;
    expect(captured.status).toBe("completed");
    expect(captured.steps.map(({ kind }) => kind)).toEqual([
      "trajectory.started",
      "approval.requested",
    ]);
  });

  it("preserves engine results and errors when terminal persistence fails", async () => {
    const warnings: unknown[][] = [];
    const base = productionStore();
    const broken: TrajectoryCaptureStore = {
      ...base,
      updateTrajectoryMetadata: (id, update) => {
        if (update.status === "completed") throw new Error("finalization unavailable");
        return base.updateTrajectoryMetadata(id, update);
      },
      markTrajectoryInterrupted: () => {
        throw new Error("interruption finalization unavailable");
      },
    };
    const result = { text: "finalization survived" };
    const common = {
      messages: [message()],
      emit: () => undefined,
      dependencies: {
        ...testDependencies("finalization-fault"),
        store: broken,
        logger: { warn: (...args: unknown[]) => warnings.push(args) },
      },
    };

    const returned = await adapter.runWithTrajectoryCapture({
      ...common,
      context: {
        id: "finalization-result-run",
        origin: { kind: "test" },
        actor: { type: "test", id: "fault" },
      },
      execute: async () => result,
    });
    expect(returned).toBe(result);

    const original = new Error("engine failure remains exact");
    await expect(
      adapter.runWithTrajectoryCapture({
        ...common,
        context: {
          id: "finalization-error-run",
          origin: { kind: "test" },
          actor: { type: "test", id: "fault" },
        },
        execute: async () => { throw original; },
      })
    ).rejects.toBe(original);

    expect(storeModule.getTrajectory("finalization-result-run")?.status).toBe("running");
    expect(storeModule.getTrajectory("finalization-error-run")?.status).toBe("running");
    expect(warnings).toHaveLength(2);
  });
});
