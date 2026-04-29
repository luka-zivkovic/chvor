// Consolidated runtime-store.
// Merges activity-store + emotion-store + a2ui-store into a single Zustand store.
//
// PROPERTY/ACTION RENAMES (collision resolution):
//   • activity-store     loading                  → activitiesLoading
//
// All other property/action names are preserved verbatim from their source store.
// a2ui-store internals are preserved exactly as written.

import { create } from "zustand";
import type {
  ActivityEntry,
  EmotionSnapshot,
  EmotionState,
  VADState,
  A2UISurface,
  A2UISurfaceUpdate,
  A2UIDataModelUpdate,
  A2UIDeleteSurface,
  A2UIComponentEntry,
  A2UISurfaceListItem,
  CognitiveLoopRun,
  CognitiveLoopEvent,
} from "@chvor/shared";
import {
  upgradeLegacyEmotion,
  PERSONALITY_GRAVITIES,
  vadDistance,
  SIGNIFICANT_SHIFT_THRESHOLD,
} from "@chvor/shared";
import { api } from "../lib/api";

// ── emotion-store module-scoped state ──────────────────────────────────────
const SIGNIFICANT_SHIFT_DURATION = 1200; // ms
const MAX_SESSION_HISTORY = 200;

let shiftTimeoutId: ReturnType<typeof setTimeout> | null = null;

// ── a2ui-store module-scoped helpers ───────────────────────────────────────
const MAX_COMPONENTS_PER_SURFACE = 500;

function toComponentMap(entries: A2UIComponentEntry[]): Record<string, A2UIComponentEntry> {
  const map: Record<string, A2UIComponentEntry> = {};
  for (const e of entries) map[e.id] = e;
  return map;
}

interface RuntimeState {
  // ── activity-store ───────────────────────────────────────────────────────
  activities: ActivityEntry[];
  unreadCount: number;
  activitiesLoading: boolean;

  fetchActivities: () => Promise<void>;
  fetchUnread: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  handleActivityEvent: (entry: ActivityEntry) => void;

  // ── cognitive-loop-store ────────────────────────────────────────────────
  cognitiveLoops: CognitiveLoopRun[];
  activeCognitiveLoop: CognitiveLoopRun | null;
  cognitiveLoopEvents: Record<string, CognitiveLoopEvent[]>;
  fetchCognitiveLoops: () => Promise<void>;
  handleCognitiveLoopRun: (run: CognitiveLoopRun) => void;
  handleCognitiveLoopEvent: (event: CognitiveLoopEvent) => void;

  // ── emotion-store ────────────────────────────────────────────────────────
  currentSnapshot: EmotionSnapshot | null;
  previousSnapshot: EmotionSnapshot | null;
  sessionHistory: EmotionSnapshot[];
  homePosition: VADState | null;
  presetId: string | null;

  // Derived display
  displayColor: string | null;
  displayLabel: string;
  secondaryLabel: string | null;
  blendIntensity: number;
  distanceFromHome: number;
  isSignificantShift: boolean;

  // Actions
  handleEmotionEvent: (data: unknown) => void;
  setPreset: (presetId: string) => void;
  loadSessionHistory: (sessionId: string) => Promise<void>;
  clearSession: () => void;

  // ── a2ui-store ───────────────────────────────────────────────────────────
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

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  // ── activity-store ───────────────────────────────────────────────────────
  activities: [],
  unreadCount: 0,
  activitiesLoading: false,

  fetchActivities: async () => {
    set({ activitiesLoading: true });
    try {
      const activities = await api.activity.list();
      set({ activities, activitiesLoading: false });
    } catch {
      set({ activitiesLoading: false });
    }
  },

  fetchUnread: async () => {
    try {
      const { count } = await api.activity.unread();
      set({ unreadCount: count });
    } catch {
      /* non-critical */
    }
  },

  markRead: async (id: string) => {
    try {
      await api.activity.markRead(id);
      set((s) => ({
        activities: s.activities.map((a) => (a.id === id ? { ...a, read: true } : a)),
        unreadCount: Math.max(0, s.unreadCount - 1),
      }));
    } catch {
      /* non-critical */
    }
  },

  markAllRead: async () => {
    try {
      await api.activity.markAllRead();
      set((s) => ({
        activities: s.activities.map((a) => ({ ...a, read: true })),
        unreadCount: 0,
      }));
    } catch {
      /* non-critical */
    }
  },

  handleActivityEvent: (entry: ActivityEntry) => {
    set((s) => {
      if (s.activities.some((a) => a.id === entry.id)) return s;
      return {
        activities: [entry, ...s.activities].slice(0, 200),
        unreadCount: s.unreadCount + 1,
      };
    });
  },

  // ── cognitive-loop-store ────────────────────────────────────────────────
  cognitiveLoops: [],
  activeCognitiveLoop: null,
  cognitiveLoopEvents: {},

  fetchCognitiveLoops: async () => {
    try {
      const loops = await api.cognitiveLoops.list(20);
      set((s) => ({
        cognitiveLoops: loops,
        activeCognitiveLoop: loops.find((loop) => loop.status === "running") ?? s.activeCognitiveLoop ?? loops[0] ?? null,
      }));
      const active = loops.find((loop) => loop.status === "running") ?? loops[0];
      if (active) {
        const detail = await api.cognitiveLoops.get(active.id);
        set((s) => ({
          cognitiveLoopEvents: { ...s.cognitiveLoopEvents, [detail.run.id]: detail.events },
          activeCognitiveLoop: detail.run,
        }));
      }
    } catch (err) {
      console.warn("[cognitive-loop] failed to fetch loops:", err);
    }
  },

  handleCognitiveLoopRun: (run) => {
    set((s) => {
      const existing = s.cognitiveLoops.some((loop) => loop.id === run.id);
      const loops = existing
        ? s.cognitiveLoops.map((loop) => (loop.id === run.id ? run : loop))
        : [run, ...s.cognitiveLoops];
      const active = run.status === "running" || s.activeCognitiveLoop?.id === run.id
        ? run
        : s.activeCognitiveLoop ?? run;
      return {
        cognitiveLoops: loops.slice(0, 50),
        activeCognitiveLoop: active,
      };
    });
  },

  handleCognitiveLoopEvent: (event) => {
    set((s) => {
      const current = s.cognitiveLoopEvents[event.loopId] ?? [];
      if (current.some((e) => e.id === event.id)) return s;
      return {
        cognitiveLoopEvents: {
          ...s.cognitiveLoopEvents,
          [event.loopId]: [...current, event].slice(-100),
        },
      };
    });
  },

  // ── emotion-store ────────────────────────────────────────────────────────
  currentSnapshot: null,
  previousSnapshot: null,
  sessionHistory: [],
  homePosition: null,
  presetId: null,

  displayColor: null,
  displayLabel: "",
  secondaryLabel: null,
  blendIntensity: 0,
  distanceFromHome: 0,
  isSignificantShift: false,

  handleEmotionEvent: (data: unknown) => {
    const state = get();
    let snapshot: EmotionSnapshot;

    // Duck-type: if it has `vad`, it's a full snapshot; otherwise legacy EmotionState
    if (data && typeof data === "object" && "vad" in data) {
      snapshot = data as EmotionSnapshot;
    } else if (data && typeof data === "object" && "emotion" in data) {
      snapshot = upgradeLegacyEmotion(data as EmotionState);
    } else {
      return;
    }

    const home = state.homePosition;
    const dist = home ? vadDistance(snapshot.vad, home) : 0;
    const prevDist = state.currentSnapshot
      ? vadDistance(snapshot.vad, state.currentSnapshot.vad)
      : 0;
    const isShift = prevDist > SIGNIFICANT_SHIFT_THRESHOLD;

    const updatedHistory = [...state.sessionHistory, snapshot].slice(-MAX_SESSION_HISTORY);

    set({
      previousSnapshot: state.currentSnapshot,
      currentSnapshot: snapshot,
      sessionHistory: updatedHistory,
      displayColor: snapshot.color,
      displayLabel: snapshot.displayLabel,
      secondaryLabel: snapshot.blend.secondary?.emotion.replace(/_/g, " ") ?? null,
      blendIntensity: snapshot.blend.intensity,
      distanceFromHome: dist,
      isSignificantShift: isShift,
    });

    // Auto-reset significant shift flag after duration (clear previous timer)
    if (shiftTimeoutId) clearTimeout(shiftTimeoutId);
    if (isShift) {
      shiftTimeoutId = setTimeout(() => {
        shiftTimeoutId = null;
        set({ isSignificantShift: false });
      }, SIGNIFICANT_SHIFT_DURATION);
    }
  },

  setPreset: (presetId: string) => {
    const gravity = PERSONALITY_GRAVITIES[presetId];
    set({
      presetId,
      homePosition: gravity?.home ?? null,
    });
  },

  loadSessionHistory: async (sessionId: string) => {
    try {
      const history = await api.get<EmotionSnapshot[]>(`/emotions/session/${sessionId}`) ?? [];
      const last = history.length > 0 ? history[history.length - 1] : null;
      set({
        sessionHistory: history,
        currentSnapshot: last,
        displayColor: last?.color ?? null,
        displayLabel: last?.displayLabel ?? "",
        secondaryLabel: last?.blend.secondary?.emotion.replace(/_/g, " ") ?? null,
        blendIntensity: last?.blend.intensity ?? 0,
      });
    } catch (e) {
      console.warn("[emotion] failed to load session history:", e);
    }
  },

  clearSession: () => {
    if (shiftTimeoutId) { clearTimeout(shiftTimeoutId); shiftTimeoutId = null; }
    set({
      currentSnapshot: null,
      previousSnapshot: null,
      sessionHistory: [],
      displayColor: null,
      displayLabel: "",
      secondaryLabel: null,
      blendIntensity: 0,
      distanceFromHome: 0,
      isSignificantShift: false,
    });
  },

  // ── a2ui-store ───────────────────────────────────────────────────────────
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
