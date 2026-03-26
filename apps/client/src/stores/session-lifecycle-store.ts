import { create } from "zustand";
import type { SessionLifecycleConfig, UpdateSessionLifecycleRequest } from "@chvor/shared";
import { api } from "../lib/api";

interface SessionLifecycleState {
  config: SessionLifecycleConfig | null;
  loading: boolean;
  error: string | null;

  fetchConfig: () => Promise<void>;
  updateConfig: (updates: UpdateSessionLifecycleRequest) => Promise<void>;
}

export const useSessionLifecycleStore = create<SessionLifecycleState>((set) => ({
  config: null,
  loading: false,
  error: null,

  fetchConfig: async () => {
    set({ loading: true, error: null });
    try {
      const config = await api.sessionLifecycle.get();
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
      const config = await api.sessionLifecycle.update(updates);
      set({ config });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
