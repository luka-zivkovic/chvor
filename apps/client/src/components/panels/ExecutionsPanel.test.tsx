import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVALUATION_CASE_DOCUMENT_MAX_BYTES } from "@chvor/shared";
import type { TrajectoryDetail, TrajectoryListResponse } from "../../lib/api";

const { listTrajectories, getTrajectory, importEvaluationCase } = vi.hoisted(() => ({
  listTrajectories: vi.fn(),
  getTrajectory: vi.fn(),
  importEvaluationCase: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  api: {
    trajectories: {
      list: listTrajectories,
      get: getTrajectory,
    },
    evaluationCases: {
      import: importEvaluationCase,
    },
  },
}));

import { ExecutionsPanel } from "./ExecutionsPanel";

const startedAt = "2026-07-11T10:00:00.000Z";

function listPage(): TrajectoryListResponse {
  return {
    records: [
      {
        id: "run-mixed",
        origin: { kind: "web-chat", sessionId: "session-1" },
        actor: { type: "user", id: "user-1" },
        status: "completed",
        title: "Mixed approval run",
        startedAt,
        completedAt: "2026-07-11T10:00:03.000Z",
        durationMs: 3_000,
        modelUsage: [],
        stepCount: 5,
        artifactCount: 0,
      },
    ],
    nextCursor: null,
  };
}

function mixedTrajectory(): TrajectoryDetail {
  return {
    schemaVersion: 1,
    id: "run-mixed",
    origin: { kind: "web-chat", sessionId: "session-1" },
    actor: { type: "user", id: "user-1" },
    status: "completed",
    title: "Mixed approval run",
    startedAt,
    completedAt: "2026-07-11T10:00:03.000Z",
    durationMs: 3_000,
    input: { prompt: "Deploy with token [REDACTED]" },
    output: { result: "deployed" },
    modelUsage: [],
    artifacts: [{ artifactId: "trace-1", kind: "trace", locator: "trace://run-mixed" }],
    labels: [],
    attributes: { attempt: 2, maxAttempts: 3 },
    steps: [
      {
        id: "response-2",
        trajectoryId: "run-mixed",
        sequence: 4,
        kind: "model.response",
        status: "completed",
        name: "provider/model",
        startedAt: "2026-07-11T10:00:02.000Z",
        completedAt: "2026-07-11T10:00:03.000Z",
        durationMs: 1_000,
        modelUsage: {
          providerId: "provider",
          modelId: "model",
          wasFallback: true,
          inputTokens: 20,
          outputTokens: 10,
        },
        artifacts: [],
        attributes: {},
      },
      {
        id: "response-1",
        trajectoryId: "run-mixed",
        sequence: 0,
        kind: "model.response",
        status: "failed",
        name: "provider/model",
        startedAt,
        completedAt: "2026-07-11T10:00:00.500Z",
        durationMs: 500,
        modelUsage: {
          providerId: "provider",
          modelId: "model",
          wasFallback: false,
          inputTokens: 10,
          outputTokens: 0,
          totalTokens: 15,
        },
        error: {
          code: "RATE_LIMITED",
          category: "model",
          message: "try again",
          retryable: true,
        },
        artifacts: [],
        attributes: {},
      },
      {
        id: "tool-call",
        trajectoryId: "run-mixed",
        sequence: 1,
        kind: "tool.call",
        status: "completed",
        name: "native__deploy",
        startedAt: "2026-07-11T10:00:00.500Z",
        completedAt: "2026-07-11T10:00:00.500Z",
        durationMs: 0,
        input: { environment: "staging" },
        toolCall: {
          toolCallId: "call-1",
          toolName: "native__deploy",
          toolKind: "native",
          credentialRefs: [{ credentialId: "credential-1", credentialType: "deploy-token" }],
          args: { token: "[REDACTED]", environment: "staging" },
        },
        artifacts: [],
        attributes: { round: 1 },
      },
      {
        id: "approval",
        trajectoryId: "run-mixed",
        sequence: 2,
        kind: "approval.requested",
        status: "waiting",
        name: "Deploy staging",
        startedAt: "2026-07-11T10:00:01.000Z",
        approval: {
          approvalId: "approval-1",
          kind: "deploy",
          risk: "high",
          status: "allowed",
          decision: "allow-once",
        },
        artifacts: [],
        attributes: {},
      },
      {
        id: "tool-result",
        trajectoryId: "run-mixed",
        sequence: 3,
        kind: "tool.result",
        status: "completed",
        name: "native__deploy",
        startedAt: "2026-07-11T10:00:01.500Z",
        completedAt: "2026-07-11T10:00:02.000Z",
        durationMs: 500,
        output: { ok: true },
        toolCall: {
          toolCallId: "call-1",
          toolName: "native__deploy",
          toolKind: "native",
          credentialRefs: [],
        },
        artifacts: [],
        attributes: {},
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ExecutionsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    listTrajectories.mockReset();
    getTrajectory.mockReset();
    importEvaluationCase.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders a mixed model, tool, approval, retry, timing, and redaction trajectory", async () => {
    listTrajectories.mockResolvedValue(listPage());
    getTrajectory.mockResolvedValue(mixedTrajectory());

    await act(async () => root.render(<ExecutionsPanel />));
    await flushEffects();

    expect(listTrajectories).toHaveBeenCalledWith({ limit: 25 });
    expect(getTrajectory).toHaveBeenCalledWith("run-mixed");
    expect(container.textContent).toContain("Mixed approval run");
    expect(container.textContent).toContain("native__deploy");
    expect(container.textContent).toContain("approval · deploy · high risk · allowed · allow-once");
    expect(container.textContent).toContain("RATE_LIMITED · try again");
    expect(container.textContent).toContain("attempt 2 of 3");
    expect(container.textContent).toContain("retryable");
    expect(container.textContent).toContain("fallback");
    expect(container.textContent).toContain("[REDACTED]");
    expect(container.textContent).toContain("duration · 500 ms");
    expect(container.textContent).toContain("tokens · 15");
    expect(container.textContent).toContain("trace://run-mixed");

    const stepLabels = Array.from(container.querySelectorAll("article")).map(
      (node) => node.textContent
    );
    expect(stepLabels[0]).toContain("#0");
    expect(stepLabels.at(-1)).toContain("#4");
  });

  it("shows loading and empty states", async () => {
    const pending = deferred<TrajectoryListResponse>();
    listTrajectories.mockReturnValue(pending.promise);

    await act(async () => root.render(<ExecutionsPanel />));
    expect(container.textContent).toContain("Loading executions…");

    await act(async () => pending.resolve({ records: [], nextCursor: null }));
    await flushEffects();
    expect(container.textContent).toContain("No executions yet");
  });

  it("surfaces a pagination failure without discarding loaded executions", async () => {
    listTrajectories
      .mockResolvedValueOnce({ ...listPage(), nextCursor: "page-2" })
      .mockRejectedValueOnce(new Error("page request failed"));
    getTrajectory.mockResolvedValue(mixedTrajectory());

    await act(async () => root.render(<ExecutionsPanel />));
    await flushEffects();
    const loadMore = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Load more"
    );
    expect(loadMore).toBeTruthy();

    await act(async () => loadMore!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushEffects();

    expect(listTrajectories).toHaveBeenLastCalledWith({ limit: 25, cursor: "page-2" });
    expect(container.textContent).toContain("Could not load more · page request failed");
    expect(container.textContent).toContain("Mixed approval run");
  });

  it("preserves the selected execution and clears the old cursor during refresh", async () => {
    const firstPage = listPage();
    firstPage.records.push({
      ...firstPage.records[0],
      id: "run-second",
      title: "Second execution",
    });
    firstPage.nextCursor = "old-cursor";
    const refreshed = deferred<TrajectoryListResponse>();
    listTrajectories.mockResolvedValueOnce(firstPage).mockReturnValueOnce(refreshed.promise);
    getTrajectory.mockImplementation(async (id: string) => ({
      ...mixedTrajectory(),
      id,
      title: id === "run-second" ? "Second execution" : "Mixed approval run",
    }));

    await act(async () => root.render(<ExecutionsPanel />));
    await flushEffects();
    const second = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Second execution")
    );
    await act(async () => second!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushEffects();

    const refresh = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Refresh"
    );
    await act(async () => refresh!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.textContent).not.toContain("Load more");

    await act(async () => refreshed.resolve({ ...firstPage, nextCursor: null }));
    await flushEffects();
    expect(getTrajectory).toHaveBeenLastCalledWith("run-second");
    expect(getTrajectory).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("Second execution");
  });

  it("preserves loaded executions when a refresh fails", async () => {
    listTrajectories.mockResolvedValueOnce(listPage()).mockRejectedValueOnce(new Error("offline"));
    getTrajectory.mockResolvedValue(mixedTrajectory());

    await act(async () => root.render(<ExecutionsPanel />));
    await flushEffects();
    const refresh = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Refresh"
    );
    await act(async () => refresh!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushEffects();

    expect(container.textContent).toContain("Mixed approval run");
    expect(container.textContent).toContain("Could not refresh · offline");
  });

  it("does not overwrite a newer selection when refresh completes", async () => {
    const firstPage = listPage();
    firstPage.records.push({
      ...firstPage.records[0],
      id: "run-second",
      title: "Second execution",
    });
    const refreshed = deferred<TrajectoryListResponse>();
    listTrajectories.mockResolvedValueOnce(firstPage).mockReturnValueOnce(refreshed.promise);
    getTrajectory.mockImplementation(async (id: string) => ({ ...mixedTrajectory(), id }));

    await act(async () => root.render(<ExecutionsPanel />));
    await flushEffects();
    const refresh = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Refresh"
    );
    await act(async () => refresh!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const second = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Second execution")
    );
    await act(async () => second!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushEffects();

    await act(async () => refreshed.resolve(firstPage));
    await flushEffects();
    expect(getTrajectory).toHaveBeenLastCalledWith("run-second");
  });

  it("imports portable evaluation JSON and surfaces API errors", async () => {
    listTrajectories.mockResolvedValue({ records: [], nextCursor: null });
    const document = {
      schemaVersion: 1 as const,
      name: "Imported case",
      input: { prompt: "hello" },
      expected: { status: "completed" as const, outputContains: [] },
      requiredTools: [],
      forbiddenTools: [],
      safetyAssertions: [],
    };
    importEvaluationCase
      .mockResolvedValueOnce({
        id: "case-1",
        revision: 1,
        document,
        createdAt: startedAt,
        updatedAt: startedAt,
      })
      .mockRejectedValueOnce(new Error("schemaVersion must be 1"));

    await act(async () => root.render(<ExecutionsPanel />));
    await flushEffects();
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const selectFile = async (contents: string, name: string) => {
      const file = new File([contents], name, { type: "application/json" });
      const readText = vi.fn().mockResolvedValue(contents);
      Object.defineProperty(file, "text", { value: readText });
      Object.defineProperty(picker, "files", { value: [file], configurable: true });
      await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
      await flushEffects();
      return readText;
    };

    await selectFile(JSON.stringify(document), "case.json");
    expect(importEvaluationCase).toHaveBeenCalledWith(document);
    expect(container.textContent).toContain("Imported “Imported case” at revision 1.");

    await selectFile(JSON.stringify(document), "invalid-case.json");
    expect(container.textContent).toContain("Import failed · schemaVersion must be 1");

    const oversizedRead = await selectFile(
      "x".repeat(EVALUATION_CASE_DOCUMENT_MAX_BYTES + 2),
      "oversized.json"
    );
    expect(oversizedRead).not.toHaveBeenCalled();
    expect(importEvaluationCase).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("File exceeds the 512000-byte evaluation limit.");
  });
});
