import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CognitiveLoopRun, CognitiveLoopWithEvents } from "@chvor/shared";

const { mockListCognitiveLoops, mockGetCognitiveLoop } = vi.hoisted(() => ({
  mockListCognitiveLoops: vi.fn(),
  mockGetCognitiveLoop: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    cognitiveLoops: {
      list: mockListCognitiveLoops,
      get: mockGetCognitiveLoop,
    },
  },
}));

import { useRuntimeStore } from "./runtime-store";

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
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T10:00:00.000Z",
    completedAt: "2026-05-01T10:05:00.000Z",
    ...rest,
  };
}

function makeLoopDetail(run: CognitiveLoopRun): CognitiveLoopWithEvents {
  return {
    run,
    events: [
      {
        id: `${run.id}-event-1`,
        loopId: run.id,
        stage: "loop.completed",
        title: `${run.title} event`,
        body: `${run.title} body`,
        metadata: null,
        ts: "2026-05-01T10:01:00.000Z",
      },
    ],
  };
}

beforeEach(() => {
  mockListCognitiveLoops.mockReset();
  mockGetCognitiveLoop.mockReset();
  useRuntimeStore.getState().resetAll();
});

describe("a2ui-store", () => {
  describe("handleSurfaceUpdate", () => {
    it("creates a new surface", () => {
      useRuntimeStore.getState().handleSurfaceUpdate({
        surfaceId: "s1",
        components: [{ id: "t1", component: { Text: { text: { literalString: "hi" } } } }],
      });

      const { surfaces, surfaceList } = useRuntimeStore.getState();
      expect(surfaces["s1"]).toBeDefined();
      expect(surfaces["s1"].components["t1"]).toBeDefined();
      expect(surfaces["s1"].title).toBe("s1");
      expect(surfaceList).toHaveLength(1);
      expect(surfaceList[0].id).toBe("s1");
    });

    it("uses title from surfaceUpdate if provided", () => {
      useRuntimeStore.getState().handleSurfaceUpdate({
        surfaceId: "s1",
        title: "My Dashboard",
        components: [{ id: "t1", component: { Text: { text: { literalString: "hi" } } } }],
      });

      const { surfaces, surfaceList } = useRuntimeStore.getState();
      expect(surfaces["s1"].title).toBe("My Dashboard");
      expect(surfaceList[0].title).toBe("My Dashboard");
    });

    it("merges components into existing surface", () => {
      const store = useRuntimeStore.getState();
      store.handleSurfaceUpdate({
        surfaceId: "s1",
        components: [{ id: "a", component: { Text: { text: { literalString: "a" } } } }],
      });
      store.handleSurfaceUpdate({
        surfaceId: "s1",
        components: [{ id: "b", component: { Text: { text: { literalString: "b" } } } }],
      });

      const { surfaces } = useRuntimeStore.getState();
      expect(surfaces["s1"].components["a"]).toBeDefined();
      expect(surfaces["s1"].components["b"]).toBeDefined();
    });

    it("enables rendering only when root is valid", () => {
      useRuntimeStore.getState().handleSurfaceUpdate({
        surfaceId: "s1",
        root: "root1",
        components: [{ id: "root1", component: { Text: { text: { literalString: "hi" } } } }],
      });

      expect(useRuntimeStore.getState().surfaces["s1"].rendering).toBe(true);
    });

    it("does not enable rendering for missing root", () => {
      useRuntimeStore.getState().handleSurfaceUpdate({
        surfaceId: "s1",
        root: "missing",
        components: [{ id: "t1", component: { Text: { text: { literalString: "hi" } } } }],
      });

      expect(useRuntimeStore.getState().surfaces["s1"].rendering).toBe(false);
    });

    it("does not duplicate surface in list on update", () => {
      const store = useRuntimeStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });

      expect(useRuntimeStore.getState().surfaceList).toHaveLength(1);
    });

    it("updates activeSurface when active surface receives update", () => {
      const store = useRuntimeStore.getState();
      store.handleSurfaceUpdate({
        surfaceId: "s1",
        root: "r",
        components: [{ id: "r", component: { Text: { text: { literalString: "v1" } } } }],
      });
      store.setActiveSurface("s1");

      store.handleSurfaceUpdate({
        surfaceId: "s1",
        components: [{ id: "extra", component: { Text: { text: { literalString: "v2" } } } }],
      });

      const { activeSurface } = useRuntimeStore.getState();
      expect(activeSurface).not.toBeNull();
      expect(activeSurface!.components["extra"]).toBeDefined();
    });
  });

  describe("handleDataUpdate", () => {
    it("merges bindings into existing surface", () => {
      const store = useRuntimeStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.handleDataUpdate({ surfaceId: "s1", bindings: { cpu: 42 } });

      expect(useRuntimeStore.getState().surfaces["s1"].bindings).toEqual({ cpu: 42 });
    });

    it("ignores updates for nonexistent surface", () => {
      useRuntimeStore.getState().handleDataUpdate({ surfaceId: "nope", bindings: { x: 1 } });
      expect(useRuntimeStore.getState().surfaces["nope"]).toBeUndefined();
    });

    it("updates activeSurface when active surface data changes", () => {
      const store = useRuntimeStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.setActiveSurface("s1");
      store.handleDataUpdate({ surfaceId: "s1", bindings: { metric: 99 } });

      const { activeSurface } = useRuntimeStore.getState();
      expect(activeSurface!.bindings).toEqual({ metric: 99 });
    });
  });

  describe("handleDelete", () => {
    it("removes a specific surface", () => {
      const store = useRuntimeStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.handleSurfaceUpdate({ surfaceId: "s2", components: [] });
      store.handleDelete({ surfaceId: "s1" });

      const { surfaces, surfaceList } = useRuntimeStore.getState();
      expect(surfaces["s1"]).toBeUndefined();
      expect(surfaces["s2"]).toBeDefined();
      expect(surfaceList.find((s) => s.id === "s1")).toBeUndefined();
    });

    it("clears activeSurface when deleting the active surface", () => {
      const store = useRuntimeStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.setActiveSurface("s1");
      store.handleDelete({ surfaceId: "s1" });

      const { activeSurfaceId, activeSurface } = useRuntimeStore.getState();
      expect(activeSurfaceId).toBeNull();
      expect(activeSurface).toBeNull();
    });
  });

  describe("handleDeleteAll", () => {
    it("clears all surfaces", () => {
      const store = useRuntimeStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.handleSurfaceUpdate({ surfaceId: "s2", components: [] });
      store.handleDeleteAll();

      const { surfaces, surfaceList } = useRuntimeStore.getState();
      expect(Object.keys(surfaces)).toHaveLength(0);
      expect(surfaceList).toHaveLength(0);
    });
  });

  describe("setActiveSurface", () => {
    it("sets active surface from store", () => {
      const store = useRuntimeStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.setActiveSurface("s1");

      const { activeSurfaceId, activeSurface } = useRuntimeStore.getState();
      expect(activeSurfaceId).toBe("s1");
      expect(activeSurface).not.toBeNull();
    });

    it("returns null for unknown surface id", () => {
      useRuntimeStore.getState().setActiveSurface("nonexistent");

      const { activeSurfaceId, activeSurface } = useRuntimeStore.getState();
      expect(activeSurfaceId).toBe("nonexistent");
      expect(activeSurface).toBeNull();
    });

    it("clears active surface when set to null", () => {
      const store = useRuntimeStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.setActiveSurface("s1");
      store.setActiveSurface(null);

      const { activeSurfaceId, activeSurface } = useRuntimeStore.getState();
      expect(activeSurfaceId).toBeNull();
      expect(activeSurface).toBeNull();
    });
  });
});

describe("cognitive-loop-store", () => {
  it("keeps a manually selected history loop active when running loop updates arrive", async () => {
    const runningLoop = makeLoop({
      id: "loop-live",
      title: "Live loop",
      status: "running",
      completedAt: null,
    });
    const historyLoop = makeLoop({ id: "loop-history", title: "History loop" });

    const store = useRuntimeStore.getState();
    store.handleCognitiveLoopRun(runningLoop);
    store.handleCognitiveLoopRun(historyLoop);

    mockGetCognitiveLoop.mockResolvedValue(makeLoopDetail(historyLoop));
    await store.selectCognitiveLoop(historyLoop.id);

    store.handleCognitiveLoopRun({
      ...runningLoop,
      summary: "Live loop updated",
      updatedAt: "2026-05-01T10:02:00.000Z",
    });

    const state = useRuntimeStore.getState();
    expect(state.selectedCognitiveLoopId).toBe(historyLoop.id);
    expect(state.activeCognitiveLoop?.id).toBe(historyLoop.id);
  });

  it("fetchCognitiveLoops preserves a manual history selection and fetches its timeline", async () => {
    const runningLoop = makeLoop({
      id: "loop-live",
      title: "Live loop",
      status: "running",
      completedAt: null,
    });
    const historyLoop = makeLoop({ id: "loop-history", title: "History loop" });

    useRuntimeStore.setState({
      cognitiveLoops: [runningLoop, historyLoop],
      activeCognitiveLoop: historyLoop,
      selectedCognitiveLoopId: historyLoop.id,
      cognitiveLoopSelectionLoading: false,
      cognitiveLoopEvents: {},
    });

    mockListCognitiveLoops.mockResolvedValue([runningLoop, historyLoop]);
    mockGetCognitiveLoop.mockResolvedValue(makeLoopDetail(historyLoop));

    await useRuntimeStore.getState().fetchCognitiveLoops();

    const state = useRuntimeStore.getState();
    expect(mockGetCognitiveLoop).toHaveBeenCalledWith(historyLoop.id);
    expect(state.selectedCognitiveLoopId).toBe(historyLoop.id);
    expect(state.activeCognitiveLoop?.id).toBe(historyLoop.id);
    expect(state.cognitiveLoopEvents[historyLoop.id]).toHaveLength(1);
  });

  it("ignores stale select responses when a newer selection finishes first", async () => {
    const firstLoop = makeLoop({ id: "loop-a", title: "Loop A" });
    const secondLoop = makeLoop({
      id: "loop-b",
      title: "Loop B",
      status: "running",
      completedAt: null,
    });

    useRuntimeStore.setState({
      cognitiveLoops: [secondLoop, firstLoop],
      activeCognitiveLoop: secondLoop,
      selectedCognitiveLoopId: secondLoop.id,
      cognitiveLoopSelectionLoading: false,
      cognitiveLoopEvents: {},
    });

    let resolveFirst: ((value: CognitiveLoopWithEvents) => void) | null = null;
    let resolveSecond: ((value: CognitiveLoopWithEvents) => void) | null = null;
    const firstPromise = new Promise<CognitiveLoopWithEvents>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise<CognitiveLoopWithEvents>((resolve) => {
      resolveSecond = resolve;
    });

    mockGetCognitiveLoop.mockReturnValueOnce(firstPromise).mockReturnValueOnce(secondPromise);

    const firstSelection = useRuntimeStore.getState().selectCognitiveLoop(firstLoop.id);
    const secondSelection = useRuntimeStore.getState().selectCognitiveLoop(secondLoop.id);

    expect(resolveSecond).not.toBeNull();
    resolveSecond!(makeLoopDetail(secondLoop));
    await secondSelection;
    expect(resolveFirst).not.toBeNull();
    resolveFirst!(makeLoopDetail(firstLoop));
    await firstSelection;

    const state = useRuntimeStore.getState();
    expect(state.selectedCognitiveLoopId).toBe(secondLoop.id);
    expect(state.activeCognitiveLoop?.id).toBe(secondLoop.id);
    expect(state.cognitiveLoopSelectionLoading).toBe(false);
  });
});
