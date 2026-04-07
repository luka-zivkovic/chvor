import { create } from "zustand";
import type { PcAgentInfo, PcSafetyLevel, PipelineLayer } from "@chvor/shared";
import { api } from "../lib/api";

interface PipelineActivity {
  task: string;
  layer: PipelineLayer;
  status: "trying" | "success" | "fallthrough";
}

interface PcState {
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

  // Actions
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

export const usePcStore = create<PcState>((set, get) => ({
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
      console.error("[pc-store] setEnabled failed:", err);
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
      console.error("[pc-store] fetchAgents failed:", err);
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
      console.error("[pc-store] fetchConfig failed:", err);
    }
  },

  setSafetyLevel: async (level) => {
    try {
      await api.pc.setConfig({ safetyLevel: level });
      set({ safetyLevel: level });
    } catch (err) {
      console.error("[pc-store] setSafetyLevel failed:", err);
    }
  },

  disconnectAgent: async (id) => {
    try {
      await api.pc.disconnect(id);
    } catch (err) {
      console.error("[pc-store] disconnectAgent failed:", err);
    }
  },
}));
