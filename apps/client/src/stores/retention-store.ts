import { create } from "zustand";
import type { RetentionConfig, UpdateRetentionRequest } from "@chvor/shared";
import { api } from "../lib/api";

interface RetentionState {
  config: RetentionConfig | null;
  loading: boolean;
  error: string | null;

  fetchConfig: () => Promise<void>;
  updateConfig: (updates: UpdateRetentionRequest) => Promise<void>;
}

export const useRetentionStore = create<RetentionState>((set) => ({
  config: null,
  loading: false,
  error: null,

  fetchConfig: async () => {
    set({ loading: true, error: null });
    try {
      const config = await api.retention.get();
      set({ config, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  updateConfig: async (updates) => {
    try {
      const config = await api.retention.update(updates);
      set({ config });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
