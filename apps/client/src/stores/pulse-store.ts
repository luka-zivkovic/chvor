import { create } from "zustand";
import type { PulseConfig, UpdatePulseRequest } from "@chvor/shared";
import { api } from "../lib/api";

interface PulseState {
  pulse: PulseConfig | null;
  loading: boolean;
  error: string | null;

  fetchPulse: () => Promise<void>;
  updatePulse: (updates: UpdatePulseRequest) => Promise<void>;
}

export const usePulseStore = create<PulseState>((set) => ({
  pulse: null,
  loading: false,
  error: null,

  fetchPulse: async () => {
    set({ loading: true, error: null });
    try {
      const pulse = await api.pulse.get();
      set({ pulse, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  updatePulse: async (updates) => {
    try {
      const pulse = await api.pulse.update(updates);
      set({ pulse });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
