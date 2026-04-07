// apps/client/src/stores/voice-store.ts
import { create } from "zustand";

export type TtsMode = "off" | "always" | "inbound";


// ── Types from server /api/voice/status ───────────────────────

export interface VoiceProviderInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
  needsCredential?: string | null;
  modelStatus?: string;
}

export interface VoiceStatus {
  stt: { provider: string; alternatives: VoiceProviderInfo[] };
  tts: { provider: string | null; order: string[]; providers: VoiceProviderInfo[] };
}

export interface VoiceModelInfo {
  id: string;
  name: string;
  type: "stt" | "tts";
  description: string;
  sizeEstimate: string;
  status: string;
  progress: { status: string; percent: number; error?: string };
  meta?: {
    language?: string;
    locale?: string;
    gender?: "male" | "female";
    quality?: "low" | "medium" | "high";
  };
}

// ── Store ─────────────────────────────────────────────────────

interface VoiceState {
  ttsMode: TtsMode;
  sttProvider: string;
  ttsProvider: string | null;
  ttsSpeed: number;
  piperVoice: string | null;
  recording: boolean;
  talkModeActive: boolean;
  talkPhase: "idle" | "listening" | "sending" | "thinking" | "speaking";

  voiceStatus: VoiceStatus | null;
  models: VoiceModelInfo[];

  setTtsMode: (mode: TtsMode) => void;
  setRecording: (recording: boolean) => void;
  setTalkModeActive: (active: boolean) => void;
  setTalkPhase: (phase: VoiceState["talkPhase"]) => void;

  // Audio URL per message ID
  audioUrls: Record<string, string>;
  setAudioUrl: (messageId: string, url: string) => void;
  lastPlayedAudioId: string | null;
  setLastPlayedAudioId: (id: string | null) => void;

  fetchConfig: () => Promise<void>;
  fetchVoiceStatus: () => Promise<void>;
  fetchModels: () => Promise<void>;
  updateSTTProvider: (provider: string) => Promise<void>;
  updateTTSProvider: (provider: string) => Promise<void>;
  updateTTSMode: (mode: TtsMode) => Promise<void>;
  updateTTSSpeed: (speed: number) => Promise<void>;
  updatePiperVoice: (modelId: string) => Promise<void>;
  startModelDownload: (modelId: string) => Promise<void>;
}

// Track active polling intervals per model (module-level to avoid Zustand serialization issues)
const activePolls = new Map<string, ReturnType<typeof setInterval>>();

export const useVoiceStore = create<VoiceState>((set, get) => ({
  ttsMode: "inbound",
  sttProvider: "whisper-api",
  ttsProvider: null,
  ttsSpeed: 1.0,
  piperVoice: null,
  recording: false,
  talkModeActive: false,
  talkPhase: "idle",

  voiceStatus: null,
  models: [],

  setTtsMode: (mode) => set({ ttsMode: mode }),
  setRecording: (recording) => set({ recording }),
  setTalkModeActive: (active) =>
    set({ talkModeActive: active, talkPhase: active ? "listening" : "idle" }),
  setTalkPhase: (phase) => set({ talkPhase: phase }),

  audioUrls: {},
  setAudioUrl: (messageId, url) =>
    set((s) => {
      const entries = Object.entries(s.audioUrls);
      const MAX_CACHED_AUDIO = 20;
      const updated = { ...s.audioUrls, [messageId]: url };
      // Evict oldest entries beyond the cap
      if (entries.length >= MAX_CACHED_AUDIO) {
        const toRemove = entries.slice(0, entries.length - MAX_CACHED_AUDIO + 1);
        for (const [key, oldUrl] of toRemove) {
          if (oldUrl.startsWith("blob:")) URL.revokeObjectURL(oldUrl);
          delete updated[key];
        }
      }
      return { audioUrls: updated };
    }),
  lastPlayedAudioId: null,
  setLastPlayedAudioId: (id) => set({ lastPlayedAudioId: id }),

  fetchConfig: async () => {
    try {
      const res = await fetch("/api/voice/config", { credentials: "same-origin" });
      if (!res.ok) return;
      const json = await res.json();
      set({
        ttsMode: json.data.ttsMode ?? "inbound",
        sttProvider: json.data.sttProvider ?? "whisper-api",
        ttsProvider: json.data.ttsProvider ?? null,
        ttsSpeed: json.data.ttsSpeed ?? 1.0,
        piperVoice: json.data.piperVoice ?? null,
      });
    } catch (err) {
      console.error("[voice] fetch config failed:", err);
    }
  },

  fetchVoiceStatus: async () => {
    try {
      const res = await fetch("/api/voice/status", { credentials: "same-origin" });
      if (!res.ok) return;
      const json = await res.json();
      set({ voiceStatus: json });
    } catch (err) {
      console.error("[voice] fetch status failed:", err);
    }
  },

  fetchModels: async () => {
    try {
      const res = await fetch("/api/voice/models", { credentials: "same-origin" });
      if (!res.ok) return;
      const json = await res.json();
      set({ models: json.models ?? [] });
    } catch (err) {
      console.error("[voice] fetch models failed:", err);
    }
  },

  updateSTTProvider: async (provider) => {
    const prev = get().sttProvider;
    set({ sttProvider: provider });
    try {
      const res = await fetch("/api/voice/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ sttProvider: provider }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      set({ sttProvider: prev });
      console.error("[voice] update STT provider failed:", err);
    }
  },

  updateTTSProvider: async (provider) => {
    const prev = get().ttsProvider;
    set({ ttsProvider: provider });
    try {
      const res = await fetch("/api/voice/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ttsProvider: provider }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      set({ ttsProvider: prev });
      console.error("[voice] update TTS provider failed:", err);
    }
  },

  updateTTSMode: async (mode) => {
    const prev = get().ttsMode;
    set({ ttsMode: mode });
    try {
      const res = await fetch("/api/voice/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ttsMode: mode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      set({ ttsMode: prev });
      console.error("[voice] update TTS mode failed:", err);
    }
  },

  updateTTSSpeed: async (speed) => {
    const prev = get().ttsSpeed;
    set({ ttsSpeed: speed });
    try {
      const res = await fetch("/api/voice/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ttsSpeed: speed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      set({ ttsSpeed: prev });
      console.error("[voice] update TTS speed failed:", err);
    }
  },

  updatePiperVoice: async (modelId) => {
    const prev = get().piperVoice;
    set({ piperVoice: modelId });
    try {
      const res = await fetch("/api/voice/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ piperVoice: modelId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      set({ piperVoice: prev });
      console.error("[voice] update Piper voice failed:", err);
    }
  },

  startModelDownload: async (modelId) => {
    // Prevent duplicate polling for the same model
    if (activePolls.has(modelId)) return;

    try {
      await fetch(`/api/voice/models/${modelId}/download`, {
        method: "POST",
        credentials: "same-origin",
      });

      const stopPolling = () => {
        const interval = activePolls.get(modelId);
        if (interval) { clearInterval(interval); activePolls.delete(modelId); }
      };

      const poll = setInterval(async () => {
        try {
          const res = await fetch(`/api/voice/models/${modelId}/status`, {
            credentials: "same-origin",
          });
          if (!res.ok) { stopPolling(); return; }
          const progress = await res.json();
          set((s) => ({
            models: s.models.map((m) =>
              m.id === modelId ? { ...m, status: progress.status, progress } : m
            ),
          }));
          if (progress.status === "ready" || progress.status === "error") {
            stopPolling();
            get().fetchVoiceStatus();
          }
        } catch {
          stopPolling();
        }
      }, 2000);
      activePolls.set(modelId, poll);
    } catch (err) {
      console.error("[voice] start download failed:", err);
      // Reflect failure in UI so user can retry
      set((s) => ({
        models: s.models.map((m) =>
          m.id === modelId ? { ...m, status: "error", progress: { status: "error", percent: 0, error: "Failed to start download" } } : m
        ),
      }));
    }
  },
}));
