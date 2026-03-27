import { create } from "zustand";
import type { EmotionSnapshot, EmotionState, VADState } from "@chvor/shared";
import { upgradeLegacyEmotion, PERSONALITY_GRAVITIES } from "@chvor/shared";
import { api } from "../lib/api";

const SIGNIFICANT_SHIFT_THRESHOLD = 0.4;
const SIGNIFICANT_SHIFT_DURATION = 1200; // ms
const MAX_SESSION_HISTORY = 200;

let shiftTimeoutId: ReturnType<typeof setTimeout> | null = null;

function vadDistance(a: VADState, b: VADState): number {
  const dv = a.valence - b.valence;
  const da = a.arousal - b.arousal;
  const dd = a.dominance - b.dominance;
  return Math.sqrt(dv * dv + da * da + dd * dd);
}

interface EmotionStoreState {
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
}

export const useEmotionStore = create<EmotionStoreState>((set, get) => ({
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
      const history = await api.get<EmotionSnapshot[]>(`/emotions/session/${sessionId}`);
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
}));
