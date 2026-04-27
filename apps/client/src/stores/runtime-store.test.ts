import { describe, it, expect, beforeEach } from "vitest";
import { useRuntimeStore } from "./runtime-store";

beforeEach(() => {
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
