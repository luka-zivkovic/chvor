import { describe, it, expect, beforeEach } from "vitest";
import { useA2UIStore } from "./a2ui-store";

beforeEach(() => {
  useA2UIStore.getState().resetAll();
});

describe("a2ui-store", () => {
  describe("handleSurfaceUpdate", () => {
    it("creates a new surface", () => {
      useA2UIStore.getState().handleSurfaceUpdate({
        surfaceId: "s1",
        components: [{ id: "t1", component: { Text: { text: { literalString: "hi" } } } }],
      });

      const { surfaces, surfaceList } = useA2UIStore.getState();
      expect(surfaces["s1"]).toBeDefined();
      expect(surfaces["s1"].components["t1"]).toBeDefined();
      expect(surfaces["s1"].title).toBe("s1");
      expect(surfaceList).toHaveLength(1);
      expect(surfaceList[0].id).toBe("s1");
    });

    it("merges components into existing surface", () => {
      const store = useA2UIStore.getState();
      store.handleSurfaceUpdate({
        surfaceId: "s1",
        components: [{ id: "a", component: { Text: { text: { literalString: "a" } } } }],
      });
      store.handleSurfaceUpdate({
        surfaceId: "s1",
        components: [{ id: "b", component: { Text: { text: { literalString: "b" } } } }],
      });

      const { surfaces } = useA2UIStore.getState();
      expect(surfaces["s1"].components["a"]).toBeDefined();
      expect(surfaces["s1"].components["b"]).toBeDefined();
    });

    it("enables rendering only when root is valid", () => {
      useA2UIStore.getState().handleSurfaceUpdate({
        surfaceId: "s1",
        root: "root1",
        components: [{ id: "root1", component: { Text: { text: { literalString: "hi" } } } }],
      });

      expect(useA2UIStore.getState().surfaces["s1"].rendering).toBe(true);
    });

    it("does not enable rendering for missing root", () => {
      useA2UIStore.getState().handleSurfaceUpdate({
        surfaceId: "s1",
        root: "missing",
        components: [{ id: "t1", component: { Text: { text: { literalString: "hi" } } } }],
      });

      expect(useA2UIStore.getState().surfaces["s1"].rendering).toBe(false);
    });

    it("does not duplicate surface in list on update", () => {
      const store = useA2UIStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });

      expect(useA2UIStore.getState().surfaceList).toHaveLength(1);
    });
  });

  describe("handleDataUpdate", () => {
    it("merges bindings into existing surface", () => {
      const store = useA2UIStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.handleDataUpdate({ surfaceId: "s1", bindings: { cpu: 42 } });

      expect(useA2UIStore.getState().surfaces["s1"].bindings).toEqual({ cpu: 42 });
    });

    it("ignores updates for nonexistent surface", () => {
      useA2UIStore.getState().handleDataUpdate({ surfaceId: "nope", bindings: { x: 1 } });
      expect(useA2UIStore.getState().surfaces["nope"]).toBeUndefined();
    });
  });

  describe("handleDelete", () => {
    it("removes a specific surface", () => {
      const store = useA2UIStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.handleSurfaceUpdate({ surfaceId: "s2", components: [] });
      store.handleDelete({ surfaceId: "s1" });

      const { surfaces, surfaceList } = useA2UIStore.getState();
      expect(surfaces["s1"]).toBeUndefined();
      expect(surfaces["s2"]).toBeDefined();
      expect(surfaceList.find((s) => s.id === "s1")).toBeUndefined();
    });

    it("clears all surfaces with __all__", () => {
      const store = useA2UIStore.getState();
      store.handleSurfaceUpdate({ surfaceId: "s1", components: [] });
      store.handleSurfaceUpdate({ surfaceId: "s2", components: [] });
      store.handleDelete({ surfaceId: "__all__" });

      const { surfaces, surfaceList } = useA2UIStore.getState();
      expect(Object.keys(surfaces)).toHaveLength(0);
      expect(surfaceList).toHaveLength(0);
    });
  });
});
