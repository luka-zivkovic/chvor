import { create } from "zustand";
import type { A2UISurface, A2UISurfaceUpdate, A2UIDataModelUpdate, A2UIDeleteSurface, A2UIComponentEntry, A2UISurfaceListItem } from "@chvor/shared";
import { api } from "../lib/api";

interface A2UIState {
  /** Lightweight list for sidebar (fetched from REST) */
  surfaceList: A2UISurfaceListItem[];
  /** Currently loaded full surface (for rendering) */
  activeSurface: A2UISurface | null;
  activeSurfaceId: string | null;

  /** In-memory surfaces for real-time WebSocket updates */
  surfaces: Record<string, A2UISurface>;

  /** REST API actions */
  fetchSurfaces: () => Promise<void>;
  fetchSurface: (id: string) => Promise<void>;
  deleteSurfaceFromServer: (id: string) => Promise<void>;

  /** WebSocket event handlers (real-time updates from agent) */
  handleSurfaceUpdate: (data: A2UISurfaceUpdate & { root?: string }) => void;
  handleDataUpdate: (data: A2UIDataModelUpdate) => void;
  handleDelete: (data: A2UIDeleteSurface) => void;
  handleDeleteAll: () => void;

  setActiveSurface: (id: string | null) => void;
  resetAll: () => void;
}

const MAX_COMPONENTS_PER_SURFACE = 500;

function toComponentMap(entries: A2UIComponentEntry[]): Record<string, A2UIComponentEntry> {
  const map: Record<string, A2UIComponentEntry> = {};
  for (const e of entries) map[e.id] = e;
  return map;
}

export const useA2UIStore = create<A2UIState>((set, get) => ({
  surfaceList: [],
  activeSurface: null,
  activeSurfaceId: null,
  surfaces: {},

  fetchSurfaces: async () => {
    try {
      const list = await api.a2ui.listSurfaces();
      set({ surfaceList: list });
    } catch (err) {
      console.error("[a2ui] failed to fetch surfaces:", err);
    }
  },

  fetchSurface: async (id: string) => {
    try {
      const surface = await api.a2ui.getSurface(id);
      set({
        activeSurface: surface,
        activeSurfaceId: id,
        surfaces: { ...get().surfaces, [id]: surface },
      });
    } catch (err) {
      console.error("[a2ui] failed to fetch surface:", err);
    }
  },

  deleteSurfaceFromServer: async (id: string) => {
    try {
      await api.a2ui.deleteSurface(id);
      const { surfaces, activeSurfaceId, surfaceList } = get();
      const { [id]: _, ...rest } = surfaces;
      const newList = surfaceList.filter((s) => s.id !== id);
      const newActive = activeSurfaceId === id ? null : activeSurfaceId;
      set({
        surfaces: rest,
        surfaceList: newList,
        activeSurfaceId: newActive,
        activeSurface: newActive && rest[newActive] ? rest[newActive] : null,
      });
    } catch (err) {
      console.error("[a2ui] failed to delete surface:", err);
    }
  },

  handleSurfaceUpdate: (data) => {
    const { surfaces, surfaceList, activeSurfaceId, activeSurface } = get();
    const existing = surfaces[data.surfaceId];

    const incoming = toComponentMap(data.components);

    // Merge: spread existing first, then incoming on top — incoming keys move to end of insertion order
    const merged_raw = existing
      ? (() => {
          const result: Record<string, A2UIComponentEntry> = {};
          // Add existing keys that are NOT being updated (preserve order)
          for (const k of Object.keys(existing.components)) {
            if (!(k in incoming)) result[k] = existing.components[k];
          }
          // Add all incoming keys at the end (most recent)
          for (const k of Object.keys(incoming)) {
            result[k] = incoming[k];
          }
          return result;
        })()
      : incoming;

    const effectiveRoot = data.root ?? existing?.root ?? null;

    const keys = Object.keys(merged_raw);
    let newComponents = merged_raw;
    if (keys.length > MAX_COMPONENTS_PER_SURFACE) {
      // Prune oldest components (front of insertion order) but always preserve the root
      const withoutRoot = effectiveRoot ? keys.filter((k) => k !== effectiveRoot) : keys;
      const kept = withoutRoot.slice(-(MAX_COMPONENTS_PER_SURFACE - (effectiveRoot ? 1 : 0)));
      if (effectiveRoot) kept.unshift(effectiveRoot);
      newComponents = Object.fromEntries(kept.map((k) => [k, merged_raw[k]]));
    }

    const rootValid = effectiveRoot ? effectiveRoot in newComponents : false;

    const effectiveTitle = data.title ?? existing?.title ?? data.surfaceId;

    const merged: A2UISurface = existing
      ? {
          ...existing,
          title: data.title ?? existing.title,
          components: newComponents,
          rendering: rootValid,
          ...(data.root ? { root: data.root } : {}),
        }
      : {
          surfaceId: data.surfaceId,
          title: effectiveTitle,
          root: data.root ?? null,
          components: newComponents,
          bindings: {},
          rendering: rootValid,
        };

    const newSurfaces = { ...surfaces, [data.surfaceId]: merged };

    // Update sidebar list if this surface isn't already there
    const exists = surfaceList.some((s) => s.id === data.surfaceId);
    const newList = exists
      ? surfaceList.map((s) =>
          s.id === data.surfaceId ? { ...s, title: effectiveTitle, updatedAt: new Date().toISOString() } : s
        )
      : [
          { id: data.surfaceId, title: effectiveTitle, rendering: rootValid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          ...surfaceList,
        ];

    // Auto-select if this is the active surface — compute before set()
    const newActiveSurface = activeSurfaceId === data.surfaceId ? merged : activeSurface;

    set({
      surfaces: newSurfaces,
      surfaceList: newList,
      activeSurface: newActiveSurface,
    });
  },

  handleDataUpdate: (data) => {
    const { surfaces, activeSurfaceId, activeSurface } = get();
    const existing = surfaces[data.surfaceId];
    if (!existing) return;

    const updated = {
      ...existing,
      bindings: { ...existing.bindings, ...data.bindings },
    };

    // Compute derived values before set() — avoid get() inside set()
    const newActiveSurface = activeSurfaceId === data.surfaceId ? updated : activeSurface;

    set({
      surfaces: { ...surfaces, [data.surfaceId]: updated },
      activeSurface: newActiveSurface,
    });
  },

  handleDelete: (data) => {
    const { surfaces, activeSurfaceId, surfaceList } = get();
    const { [data.surfaceId]: _, ...rest } = surfaces;
    const newList = surfaceList.filter((s) => s.id !== data.surfaceId);
    const newActive = activeSurfaceId === data.surfaceId ? null : activeSurfaceId;

    set({
      surfaces: rest,
      surfaceList: newList,
      activeSurfaceId: newActive,
      activeSurface: newActive && rest[newActive] ? rest[newActive] : null,
    });
  },

  handleDeleteAll: () => {
    set({ surfaces: {}, surfaceList: [], activeSurfaceId: null, activeSurface: null });
  },

  setActiveSurface: (id) => {
    const surface = id ? get().surfaces[id] ?? null : null;
    set({ activeSurfaceId: id, activeSurface: surface });
  },

  resetAll: () => set({ surfaces: {}, surfaceList: [], activeSurfaceId: null, activeSurface: null }),
}));
