import { create } from "zustand";
import type { Tool } from "@chvor/shared";
import { api } from "../lib/api";

export type ToolWithEnabled = Tool & { enabled: boolean };

interface ToolState {
  tools: ToolWithEnabled[];
  loading: boolean;
  error: string | null;
  fetchTools: () => Promise<void>;
}

export const useToolStore = create<ToolState>((set) => ({
  tools: [],
  loading: false,
  error: null,

  fetchTools: async () => {
    set({ loading: true, error: null });
    try {
      const tools = await api.tools.list();
      set({ tools, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },
}));
