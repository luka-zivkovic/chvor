import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CognitiveLoopRun } from "@chvor/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { mockBranches } = vi.hoisted(() => ({
  mockBranches: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  api: {
    cognitiveLoops: {
      branches: mockBranches,
      diff: vi.fn(),
    },
  },
}));

import { CognitiveLoopRail } from "./CognitiveLoopRail";
import { useRuntimeStore } from "../../stores/runtime-store";

function makeLoop(
  overrides: Partial<CognitiveLoopRun> & Pick<CognitiveLoopRun, "id" | "title">
): CognitiveLoopRun {
  const { id, title, ...rest } = overrides;
  return {
    id,
    title,
    status: "completed",
    severity: "info",
    trigger: "manual",
    summary: `${title} summary`,
    currentStage: null,
    surfaceId: null,
    parentLoopId: null,
    parentEventId: null,
    branchReason: null,
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T10:00:00.000Z",
    completedAt: "2026-05-01T10:05:00.000Z",
    ...rest,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("CognitiveLoopRail", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockBranches.mockReset();
    useRuntimeStore.getState().resetAll();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("loads child branches and selects one on click", async () => {
    const sourceLoop = makeLoop({ id: "loop-source", title: "Source loop" });
    const childLoop = makeLoop({
      id: "loop-child",
      title: "Child loop",
      branchReason: "Try a different path",
      parentLoopId: sourceLoop.id,
      status: "running",
    });
    const selectCognitiveLoop = vi.fn().mockResolvedValue(undefined);

    mockBranches.mockResolvedValue({ sourceLoop, branches: [childLoop] });
    useRuntimeStore.setState({
      cognitiveLoops: [sourceLoop],
      activeCognitiveLoop: sourceLoop,
      selectedCognitiveLoopId: sourceLoop.id,
      cognitiveLoopSelectionLoading: false,
      cognitiveLoopEvents: { [sourceLoop.id]: [] },
      selectCognitiveLoop,
    });

    await act(async () => {
      root.render(<CognitiveLoopRail />);
    });
    await flushEffects();

    expect(mockBranches).toHaveBeenCalledWith(sourceLoop.id, 8);
    const button = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("Child loop")
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(selectCognitiveLoop).toHaveBeenCalledWith(childLoop.id);
  });

  it("clears stale child branches immediately when switching loops", async () => {
    const firstLoop = makeLoop({ id: "loop-a", title: "Loop A" });
    const secondLoop = makeLoop({ id: "loop-b", title: "Loop B" });
    const firstChild = makeLoop({
      id: "loop-a-child",
      title: "Loop A child",
      parentLoopId: firstLoop.id,
    });
    const secondChild = makeLoop({
      id: "loop-b-child",
      title: "Loop B child",
      parentLoopId: secondLoop.id,
    });
    const firstReq = deferred<{ sourceLoop: CognitiveLoopRun; branches: CognitiveLoopRun[] }>();
    const secondReq = deferred<{ sourceLoop: CognitiveLoopRun; branches: CognitiveLoopRun[] }>();

    mockBranches.mockReturnValueOnce(firstReq.promise).mockReturnValueOnce(secondReq.promise);
    useRuntimeStore.setState({
      cognitiveLoops: [firstLoop, secondLoop],
      activeCognitiveLoop: firstLoop,
      selectedCognitiveLoopId: firstLoop.id,
      cognitiveLoopSelectionLoading: false,
      cognitiveLoopEvents: { [firstLoop.id]: [], [secondLoop.id]: [] },
    });

    await act(async () => {
      root.render(<CognitiveLoopRail />);
    });

    await act(async () => {
      firstReq.resolve({ sourceLoop: firstLoop, branches: [firstChild] });
    });
    await flushEffects();
    expect(container.textContent).toContain("Loop A child");

    await act(async () => {
      useRuntimeStore.setState({
        activeCognitiveLoop: secondLoop,
        selectedCognitiveLoopId: secondLoop.id,
      });
    });
    await flushEffects();

    expect(mockBranches).toHaveBeenNthCalledWith(2, secondLoop.id, 8);
    expect(container.textContent).not.toContain("Loop A child");
    expect(container.textContent).toContain("loading…");

    await act(async () => {
      secondReq.resolve({ sourceLoop: secondLoop, branches: [secondChild] });
    });
    await flushEffects();

    expect(container.textContent).toContain("Loop B child");
    expect(container.textContent).not.toContain("Loop A child");
  });
});
