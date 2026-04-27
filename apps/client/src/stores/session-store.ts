// Consolidated session-store.
// Merges auth-store + pc-store into a single Zustand store.
//
// All state property and action names are preserved verbatim from the source
// stores so consumer selectors continue to work unchanged.
//
// No collisions detected between auth-store and pc-store property/action names.

import { create } from "zustand";
import type {
  AuthMethod,
  AuthSession,
  ApiKeyInfo,
  PcAgentInfo,
  PcSafetyLevel,
  PipelineLayer,
} from "@chvor/shared";
import { api } from "../lib/api";

interface PipelineActivity {
  task: string;
  layer: PipelineLayer;
  status: "trying" | "success" | "fallthrough";
}

interface SessionState {
  // ── auth-store fields ───────────────────────────────────────
  authEnabled: boolean;
  authenticated: boolean;
  setupComplete: boolean | null;
  authMethod: AuthMethod | null;
  sessions: AuthSession[];
  apiKeys: ApiKeyInfo[];
  loading: boolean;
  error: string | null;

  checkStatus: () => Promise<void>;
  login: (credentials: { username?: string; password?: string; pin?: string }) => Promise<boolean>;
  logout: () => Promise<void>;
  setAuthenticated: (v: boolean) => void;
  fetchSessions: () => Promise<void>;
  fetchApiKeys: () => Promise<void>;

  // ── pc-store fields ─────────────────────────────────────────
  /** Whether PC control feature is enabled */
  enabled: boolean;
  /** Whether local PC control is available on the server */
  localAvailable: boolean;
  /** Connected PC agents (including local if available) */
  agents: PcAgentInfo[];
  /** Currently selected agent for the viewer */
  activeAgentId: string | null;
  /** Latest screenshot base64 for the active agent */
  latestFrame: string | null;
  /** MIME type of the latest frame */
  latestFrameMime: string;
  /** PC viewer panel visible */
  viewerOpen: boolean;
  /** Safety level setting */
  safetyLevel: PcSafetyLevel;
  /** Current pipeline activity (which layer is being used) */
  pipelineActivity: PipelineActivity | null;

  setViewerOpen: (open: boolean) => void;
  setActiveAgent: (id: string | null) => void;
  setEnabled: (enabled: boolean) => Promise<void>;
  handleAgentConnected: (agent: PcAgentInfo) => void;
  handleAgentDisconnected: (id: string) => void;
  handleFrame: (agentId: string, screenshot: string, mimeType?: string) => void;
  handlePipelineEvent: (type: string, data: Record<string, unknown>) => void;
  fetchAgents: () => Promise<void>;
  fetchConfig: () => Promise<void>;
  setSafetyLevel: (level: PcSafetyLevel) => Promise<void>;
  disconnectAgent: (id: string) => Promise<void>;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  // ── auth-store initial state ────────────────────────────────
  authEnabled: false,
  authenticated: false,
  setupComplete: null,
  authMethod: null,
  sessions: [],
  apiKeys: [],
  loading: false,
  error: null,

  checkStatus: async () => {
    try {
      const status = await api.auth.status();
      set({
        authEnabled: status.enabled,
        setupComplete: status.setupComplete,
        authMethod: status.method,
        authenticated: status.authenticated,
      });
    } catch {
      // Server unreachable — assume not authenticated
      set({ authenticated: false, setupComplete: null });
    }
  },

  login: async (credentials) => {
    set({ loading: true, error: null });
    try {
      await api.auth.login(credentials);
      set({ authenticated: true, loading: false, error: null });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      set({ error: msg, loading: false });
      return false;
    }
  },

  logout: async () => {
    try {
      await api.auth.logout();
    } catch {
      // ignore
    }
    set({ authenticated: false });
  },

  setAuthenticated: (v) => set({ authenticated: v }),

  fetchSessions: async () => {
    try {
      const sessions = await api.auth.sessions();
      set({ sessions, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to load sessions" });
    }
  },

  fetchApiKeys: async () => {
    try {
      const apiKeys = await api.auth.apiKeys();
      set({ apiKeys, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to load API keys" });
    }
  },

  // ── pc-store initial state ──────────────────────────────────
  enabled: false,
  localAvailable: false,
  agents: [],
  activeAgentId: null,
  latestFrame: null,
  latestFrameMime: "image/jpeg",
  viewerOpen: false,
  safetyLevel: "supervised",
  pipelineActivity: null,

  setViewerOpen: (open) => set({ viewerOpen: open }),

  setActiveAgent: (id) => set({ activeAgentId: id, latestFrame: null }),

  setEnabled: async (enabled) => {
    try {
      const config = await api.pc.setConfig({ enabled });
      set({
        enabled: config.enabled,
        localAvailable: config.localAvailable ?? false,
        // When disabling, clear agents from local state
        ...(config.enabled ? {} : { agents: [], activeAgentId: null, latestFrame: null }),
      });
    } catch (err) {
      console.error("[session-store] setEnabled failed:", err);
    }
  },

  handleAgentConnected: (agent) => {
    set((s) => {
      const exists = s.agents.some((a) => a.id === agent.id);
      const agents = exists
        ? s.agents.map((a) => (a.id === agent.id ? agent : a))
        : [...s.agents, agent];
      const activeAgentId = s.activeAgentId ?? agent.id;
      return { agents, activeAgentId };
    });
  },

  handleAgentDisconnected: (id) => {
    set((s) => {
      const agents = s.agents.filter((a) => a.id !== id);
      const activeAgentId = s.activeAgentId === id
        ? (agents[0]?.id ?? null)
        : s.activeAgentId;
      return { agents, activeAgentId, ...(s.activeAgentId === id ? { latestFrame: null } : {}) };
    });
  },

  handleFrame: (agentId, screenshot, mimeType) => {
    if (get().activeAgentId === agentId) {
      set({ latestFrame: screenshot, ...(mimeType ? { latestFrameMime: mimeType } : {}) });
    }
  },

  handlePipelineEvent: (type, data) => {
    if (type === "pc.pipeline.start") {
      set({
        pipelineActivity: {
          task: (data.task as string) ?? "",
          layer: "action-router",
          status: "trying",
        },
      });
    } else if (type === "pc.pipeline.layer") {
      set((s) => ({
        pipelineActivity: {
          task: s.pipelineActivity?.task ?? "",
          layer: data.layer as PipelineLayer,
          status: data.status as PipelineActivity["status"],
        },
      }));
    } else if (type === "pc.pipeline.complete") {
      // Clear after a short delay so the UI can show the result
      setTimeout(() => set({ pipelineActivity: null }), 1500);
    }
  },

  fetchAgents: async () => {
    try {
      const agents = await api.pc.connections();
      set({ agents });
      if (!get().activeAgentId && agents.length > 0) {
        set({ activeAgentId: agents[0].id });
      }
    } catch (err) {
      console.error("[session-store] fetchAgents failed:", err);
    }
  },

  fetchConfig: async () => {
    try {
      const config = await api.pc.config();
      set({
        enabled: config.enabled ?? false,
        safetyLevel: config.safetyLevel ?? "supervised",
        localAvailable: config.localAvailable ?? false,
      });
    } catch (err) {
      console.error("[session-store] fetchConfig failed:", err);
    }
  },

  setSafetyLevel: async (level) => {
    try {
      await api.pc.setConfig({ safetyLevel: level });
      set({ safetyLevel: level });
    } catch (err) {
      console.error("[session-store] setSafetyLevel failed:", err);
    }
  },

  disconnectAgent: async (id) => {
    try {
      await api.pc.disconnect(id);
    } catch (err) {
      console.error("[session-store] disconnectAgent failed:", err);
    }
  },
}));
