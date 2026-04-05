import { create } from "zustand";
import type { KnowledgeResource } from "@chvor/shared";
import { api } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";

// Track active poll timers and generation counters for cancellation
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pollGenerations = new Map<string, number>();

function cancelPoll(id: string) {
  const timer = pollTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    pollTimers.delete(id);
  }
  // Bump generation so any in-flight fetch is ignored on return
  pollGenerations.set(id, (pollGenerations.get(id) ?? 0) + 1);
}

interface KnowledgeState {
  resources: KnowledgeResource[];
  loading: boolean;
  uploading: boolean;
  error: string | null;

  fetchAll: () => Promise<void>;
  uploadFile: (file: File, title?: string) => Promise<void>;
  ingestUrl: (url: string, title?: string) => Promise<void>;
  deleteResource: (id: string) => Promise<void>;
  reprocess: (id: string) => Promise<void>;
  pollResource: (id: string) => Promise<void>;
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  resources: [],
  loading: false,
  uploading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null });
    try {
      const resources = await api.knowledge.list();
      set({ resources, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  uploadFile: async (file, title) => {
    set({ uploading: true, error: null });
    try {
      const resource = await api.knowledge.upload(file, title);
      set((s) => ({ resources: [resource, ...s.resources], uploading: false }));
      trackEvent("feature:knowledge", { method: "upload" });
      // Start polling for status updates
      get().pollResource(resource.id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), uploading: false });
    }
  },

  ingestUrl: async (url, title) => {
    set({ uploading: true, error: null });
    try {
      const resource = await api.knowledge.ingestUrl(url, title);
      set((s) => ({ resources: [resource, ...s.resources], uploading: false }));
      trackEvent("feature:knowledge", { method: "url" });
      get().pollResource(resource.id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), uploading: false });
    }
  },

  deleteResource: async (id) => {
    // Cancel any active polling for this resource
    cancelPoll(id);
    try {
      await api.knowledge.delete(id);
      set((s) => ({ resources: s.resources.filter((r) => r.id !== id) }));
      pollGenerations.delete(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  reprocess: async (id) => {
    // Cancel existing poll before starting a new one
    cancelPoll(id);
    try {
      await api.knowledge.reprocess(id);
      // Update status locally
      set((s) => ({
        resources: s.resources.map((r) =>
          r.id === id ? { ...r, status: "processing" as const, memoryCount: 0 } : r,
        ),
      }));
      get().pollResource(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  pollResource: async (id) => {
    // Cancel any existing poll chain for this resource
    cancelPoll(id);

    const gen = pollGenerations.get(id) ?? 0;
    const MAX_POLLS = 60;
    let remaining = MAX_POLLS;
    const poll = async () => {
      pollTimers.delete(id);
      // If generation changed, this poll chain is stale — abort
      if (pollGenerations.get(id) !== gen) return;
      try {
        const updated = await api.knowledge.get(id);
        // Re-check generation after async fetch
        if (pollGenerations.get(id) !== gen) return;
        set((s) => ({
          resources: s.resources.map((r) => (r.id === id ? updated : r)),
        }));
        remaining--;
        if ((updated.status === "pending" || updated.status === "processing") && remaining > 0) {
          const timer = setTimeout(poll, 2000);
          pollTimers.set(id, timer);
        }
      } catch {
        // Resource may have been deleted, stop polling
        pollTimers.delete(id);
      }
    };
    const timer = setTimeout(poll, 1500);
    pollTimers.set(id, timer);
  },
}));
