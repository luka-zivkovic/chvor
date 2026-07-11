import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  approvalEvents: [] as Array<{ data: { requestId: string } }>,
  approvalRequested: [] as Array<{ kind: string; status: string }>,
  approvalResolved: [] as Array<{ kind: string; status: string }>,
  beforePcSideEffect: null as (() => void) | null,
  executeAction: vi.fn(async () => ({ success: true })),
  executePcTask: vi.fn(),
  executeShell: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  routedActions: [{ action: "left_click", coordinate: [10, 10] }] as unknown[] | null,
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

vi.mock("../../db/config-store.ts", () => ({
  addTrustedCommand: vi.fn(),
  getPcControlEnabled: () => true,
  getShellConfig: () => ({ approvalMode: "moderate_plus" }),
  isTrustedCommand: () => false,
}));

vi.mock("../shell-audit.ts", () => ({ logShellExecution: vi.fn() }));
vi.mock("../../db/activity-store.ts", () => ({ insertActivity: vi.fn() }));
vi.mock("../orchestrator/trajectory-adapter.ts", () => ({
  recordTrajectoryApprovalRequested: (
    record: { kind: string; status: string },
    toolCallId?: string
  ) => mocks.approvalRequested.push({ ...record, toolCallId } as never),
  recordTrajectoryApprovalResolved: (
    record: { kind: string; status: string },
    toolCallId?: string
  ) => mocks.approvalResolved.push({ ...record, toolCallId } as never),
}));

vi.mock("../../gateway/ws-instance.ts", () => ({
  getWSInstance: () => ({
    broadcast: (event: { data: { requestId: string } }) => mocks.approvalEvents.push(event),
    sendTo: (_clientId: string, event: { data: { requestId: string } }) => {
      mocks.approvalEvents.push(event);
      return true;
    },
  }),
}));

vi.mock("../pc-control.ts", () => ({
  getPcSafetyLevel: () => "supervised",
  hasConnectedAgents: () => true,
  localBackendAvailable: () => false,
  getBackend: () => ({
    mode: "remote",
    id: "pc-1",
    hostname: "test-pc",
    os: "test",
    screenSize: { width: 100, height: 100 },
    coordinateSize: { width: 100, height: 100 },
    captureScreen: vi.fn(),
    executeAction: mocks.executeAction,
    executeShell: mocks.executeShell,
    queryA11yTree: vi.fn(),
  }),
}));

vi.mock("../action-patterns.ts", () => ({
  tryActionRouter: () => mocks.routedActions,
}));

vi.mock("../pc-safety.ts", () => ({
  assessPcTaskSafety: () => ({
    tier: "moderate",
    reasons: ["test approval"],
    reasonDetails: [{ reason: "test approval", tier: "moderate" }],
    autoApprovableInSemiAutonomous: false,
  }),
}));

vi.mock("../pc-pipeline.ts", () => ({
  executePcTask: (...args: unknown[]) => mocks.executePcTask(...args),
}));

import { pcControlModule } from "../native-tools/pc-control.ts";
import { resolveApproval, shellModule } from "../native-tools/shell.ts";
import { waitForAbortSideEffectSettlement } from "../orchestrator/abort.ts";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  pid: number | undefined;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

async function waitForApproval(): Promise<string> {
  for (let attempt = 0; attempt < 20 && mocks.approvalEvents.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const requestId = mocks.approvalEvents.at(-1)?.data.requestId;
  expect(requestId).toBeTypeOf("string");
  return requestId!;
}

beforeEach(() => {
  mocks.approvalEvents.length = 0;
  mocks.approvalRequested.length = 0;
  mocks.approvalResolved.length = 0;
  mocks.beforePcSideEffect = null;
  mocks.executeAction.mockClear();
  mocks.executePcTask.mockReset();
  mocks.executeShell.mockClear();
  mocks.routedActions = [{ action: "left_click", coordinate: [10, 10] }];
  mocks.spawn.mockClear();
});

describe("native tool abort safety", () => {
  it("does not execute a shell command when a stale approval arrives after abort", async () => {
    const controller = new AbortController();
    const execution = shellModule.handlers.native__shell_execute(
      { command: "mkdir abort-regression", workingDir: process.cwd() },
      { abortSignal: controller.signal, toolCallId: "shell-call" }
    );
    const requestId = await waitForApproval();

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(resolveApproval(requestId, true)).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.approvalRequested).toEqual([
      expect.objectContaining({ kind: "shell", toolCallId: "shell-call" }),
    ]);
    expect(mocks.approvalResolved).toEqual([
      expect.objectContaining({ kind: "shell", status: "expired", toolCallId: "shell-call" }),
    ]);
  });

  it("keeps an aborted shell side effect fenced until the process closes", async () => {
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child as never);
    const controller = new AbortController();
    const execution = shellModule.handlers.native__shell_execute(
      { command: "mkdir fence-regression", workingDir: process.cwd() },
      { abortSignal: controller.signal, toolCallId: "shell-fence-call" }
    );
    const requestId = await waitForApproval();
    expect(resolveApproval(requestId, true)).toBe(true);
    for (let attempt = 0; attempt < 20 && mocks.spawn.mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    let released = false;
    const fence = waitForAbortSideEffectSettlement(controller.signal).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    child.emit("close", null, "SIGKILL");
    await fence;
    expect(released).toBe(true);
  });

  it("does not execute a routed PC action after its approval wait is aborted", async () => {
    const controller = new AbortController();
    const execution = pcControlModule.handlers.native__pc_do(
      { task: "click the test button" },
      { abortSignal: controller.signal, toolCallId: "pc-call" }
    );
    const requestId = await waitForApproval();

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(resolveApproval(requestId, true)).toBe(false);
    expect(mocks.executePcTask).not.toHaveBeenCalled();
    expect(mocks.executeAction).not.toHaveBeenCalled();
    expect(mocks.approvalRequested).toEqual([
      expect.objectContaining({ kind: "pc_control", toolCallId: "pc-call" }),
    ]);
    expect(mocks.approvalResolved).toEqual([
      expect.objectContaining({ kind: "pc_control", status: "expired", toolCallId: "pc-call" }),
    ]);
  });

  it("does not execute planned PC actions when their approval becomes stale", async () => {
    mocks.routedActions = null;
    mocks.executePcTask.mockImplementation(async (_task, backend, context) => {
      const authorization = await context.authorizeActions(
        [{ action: "left_click", coordinate: [10, 10] }],
        "vision"
      );
      mocks.beforePcSideEffect?.();
      if (authorization.allowed) await backend.executeAction({ action: "left_click" });
      return { success: authorization.allowed, layerUsed: "vision", summary: "test" };
    });
    const controller = new AbortController();
    const execution = pcControlModule.handlers.native__pc_do(
      { task: "perform a planned click" },
      { abortSignal: controller.signal }
    );
    const requestId = await waitForApproval();

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(resolveApproval(requestId, true)).toBe(false);
    expect(mocks.executeAction).not.toHaveBeenCalled();
  });

  it("rechecks abort immediately before a previously authorized PC action", async () => {
    mocks.routedActions = null;
    const controller = new AbortController();
    mocks.beforePcSideEffect = () => controller.abort();
    mocks.executePcTask.mockImplementation(async (_task, backend, context) => {
      const authorization = await context.authorizeActions(
        [{ action: "left_click", coordinate: [10, 10] }],
        "vision"
      );
      mocks.beforePcSideEffect?.();
      if (authorization.allowed) await backend.executeAction({ action: "left_click" });
      return { success: authorization.allowed, layerUsed: "vision", summary: "test" };
    });
    const execution = pcControlModule.handlers.native__pc_do(
      { task: "perform an authorized click" },
      { abortSignal: controller.signal }
    );
    const requestId = await waitForApproval();

    expect(resolveApproval(requestId, true)).toBe(true);

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.executeAction).not.toHaveBeenCalled();
  });

  it("does not execute a PC shell command after its approval wait is aborted", async () => {
    const controller = new AbortController();
    const execution = pcControlModule.handlers.native__pc_shell(
      { command: "echo stale" },
      { abortSignal: controller.signal }
    );
    const requestId = await waitForApproval();

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(resolveApproval(requestId, true)).toBe(false);
    expect(mocks.executeShell).not.toHaveBeenCalled();
  });
});
