import { create } from "zustand";
import type { ModelRole, ModelRoleConfig, ModelRolesConfig, EmbeddingConfig, RoleFallbackEntry } from "@chvor/shared";
import { api } from "../lib/api";

interface ModelsState {
  roles: ModelRolesConfig;
  embedding: EmbeddingConfig;
  defaults: Record<string, ModelRoleConfig | null>;
  fallbacks: Record<string, RoleFallbackEntry[]>;
  loading: boolean;
  reembedStatus: { status: "idle" | "running"; done: number; total: number };

  fetchConfig: () => Promise<void>;
  setRole: (role: ModelRole, providerId: string | null, model: string | null) => Promise<void>;
  setFallbacks: (role: ModelRole, entries: RoleFallbackEntry[]) => Promise<void>;
  setEmbedding: (providerId: string, model: string) => Promise<void>;
  triggerReembed: () => Promise<void>;
  pollReembedStatus: () => Promise<void>;
}

function applyConfigResponse(data: { roles: ModelRolesConfig; embedding: EmbeddingConfig; defaults?: Record<string, ModelRoleConfig | null>; fallbacks?: Record<string, RoleFallbackEntry[]> }) {
  return {
    roles: data.roles,
    embedding: data.embedding,
    defaults: data.defaults ?? {},
    fallbacks: data.fallbacks ?? {},
  };
}

export const useModelsStore = create<ModelsState>((set) => ({
  roles: { primary: null, reasoning: null, lightweight: null, heartbeat: null },
  embedding: { providerId: "local", model: "Xenova/all-MiniLM-L6-v2", dimensions: 384 },
  defaults: {},
  fallbacks: {},
  loading: false,
  reembedStatus: { status: "idle", done: 0, total: 0 },

  fetchConfig: async () => {
    set({ loading: true });
    try {
      const data = await api.models.get();
      set({ ...applyConfigResponse(data), loading: false });
    } catch (err) {
      console.error("[models-store] fetch failed:", err);
      set({ loading: false });
    }
  },

  setRole: async (role, providerId, model) => {
    try {
      const result = await api.models.setRole({ role, providerId, model });
      set(applyConfigResponse(result));
    } catch (err) {
      console.error("[models-store] setRole failed:", err);
    }
  },

  setFallbacks: async (role, entries) => {
    try {
      const result = await api.models.setFallbacks({ role, fallbacks: entries });
      set(applyConfigResponse(result));
    } catch (err) {
      console.error("[models-store] setFallbacks failed:", err);
    }
  },

  setEmbedding: async (providerId, model) => {
    try {
      const result = await api.models.setEmbedding({ embedding: { providerId, model } });
      set(applyConfigResponse(result));
    } catch (err) {
      console.error("[models-store] setEmbedding failed:", err);
    }
  },

  triggerReembed: async () => {
    try {
      const result = await api.models.reembed();
      set({ reembedStatus: { status: "running", done: 0, total: result.total } });
    } catch (err) {
      console.error("[models-store] reembed failed:", err);
    }
  },

  pollReembedStatus: async () => {
    try {
      const result = await api.models.reembedStatus();
      set({
        reembedStatus: {
          status: result.status as "idle" | "running",
          done: result.progress.done,
          total: result.progress.total,
        },
      });
    } catch {
      // Ignore polling errors
    }
  },
}));
