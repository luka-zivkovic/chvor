import { create } from "zustand";
import type { TelemetryConfig, UpdateTelemetryRequest } from "@chvor/shared";
import { api } from "../lib/api";
import { setAnalyticsEnabled } from "../lib/analytics";

interface TelemetryState {
  config: TelemetryConfig | null;
  loading: boolean;
  error: string | null;
  fetchConfig: () => Promise<void>;
  updateConfig: (updates: UpdateTelemetryRequest) => Promise<void>;
}

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  config: null,
  loading: false,
  error: null,

  fetchConfig: async () => {
    set({ loading: true, error: null });
    try {
      const config = await api.telemetry.get();
      set({ config, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  updateConfig: async (updates) => {
    const prev = get().config;

    // Optimistic update
    if (prev && updates.enabled !== undefined) {
      set({ config: { ...prev, enabled: updates.enabled }, error: null });
    }

    try {
      const config = await api.telemetry.update(updates);
      set({ config });
      if (updates.enabled !== undefined) {
        await setAnalyticsEnabled(updates.enabled);
      }
    } catch (err) {
      // Roll back to previous state
      set({ config: prev, error: err instanceof Error ? err.message : String(err) });
      if (prev && updates.enabled !== undefined) {
        await setAnalyticsEnabled(prev.enabled);
      }
    }
  },
}));
