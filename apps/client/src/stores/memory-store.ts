import { create } from "zustand";
import type { Memory, MemoryGraphNode, MemoryEdge, MemoryStats } from "@chvor/shared";
import { api } from "../lib/api";

interface MemoryState {
  memories: Memory[];
  loading: boolean;
  error: string | null;

  // Graph & stats for Memory Insights Dashboard
  graphNodes: MemoryGraphNode[];
  graphEdges: MemoryEdge[];
  stats: MemoryStats | null;
  graphLoading: boolean;
  statsLoading: boolean;

  fetchAll: () => Promise<void>;
  addMemory: (content: string) => Promise<void>;
  removeMemory: (id: string) => Promise<void>;
  updateMemory: (id: string, content: string) => Promise<void>;
  clearAll: () => Promise<void>;
  fetchGraph: () => Promise<void>;
  fetchStats: () => Promise<void>;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  memories: [],
  loading: false,
  error: null,
  graphNodes: [],
  graphEdges: [],
  stats: null,
  graphLoading: false,
  statsLoading: false,

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

  removeMemory: async (id) => {
    // Optimistic update
    set((st) => ({ memories: st.memories.filter((m) => m.id !== id) }));
    try {
      await api.memories.delete(id);
    } catch (err) {
      // Revert: re-fetch from server on failure
      set({ error: err instanceof Error ? err.message : String(err) });
      try {
        const memories = await api.memories.list();
        set({ memories });
      } catch { /* best effort revert */ }
    }
  },

  updateMemory: async (id, content) => {
    // Optimistic update
    set((st) => ({
      memories: st.memories.map((m) =>
        m.id === id ? { ...m, abstract: content, content } : m
      ),
    }));
    try {
      await api.memories.update(id, { content });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      try {
        const memories = await api.memories.list();
        set({ memories });
      } catch { /* best effort revert */ }
    }
  },

  clearAll: async () => {
    try {
      await api.memories.deleteAll();
      set({ memories: [] });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  fetchGraph: async () => {
    set({ graphLoading: true, error: null });
    try {
      const data = await api.memories.graph();
      set({ graphNodes: data.nodes, graphEdges: data.edges, graphLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), graphLoading: false });
    }
  },

  fetchStats: async () => {
    set({ statsLoading: true, error: null });
    try {
      const stats = await api.memories.stats();
      set({ stats, statsLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), statsLoading: false });
    }
  },
}));
