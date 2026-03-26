import { create } from "zustand";
import type { Memory } from "@chvor/shared";
import { api } from "../lib/api";

interface MemoryState {
  memories: Memory[];
  loading: boolean;
  error: string | null;

  fetchAll: () => Promise<void>;
  addMemory: (content: string) => Promise<void>;
  removeMemory: (id: string) => void;
  updateMemory: (id: string, content: string) => void;
  clearAll: () => Promise<void>;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  memories: [],
  loading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null });
    try {
      const memories = await api.memories.list();
      set({ memories, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  addMemory: async (content) => {
    try {
      const memory = await api.memories.create(content);
      set((st) => ({ memories: [memory, ...st.memories] }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  removeMemory: (id) =>
    set((st) => ({ memories: st.memories.filter((m) => m.id !== id) })),

  updateMemory: (id, content) =>
    set((st) => ({
      memories: st.memories.map((m) =>
        m.id === id ? { ...m, abstract: content, content } : m
      ),
    })),

  clearAll: async () => {
    try {
      await api.memories.deleteAll();
      set({ memories: [] });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
