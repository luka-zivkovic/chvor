import { create } from "zustand";
import type { WebhookSubscription, WebhookEvent } from "@chvor/shared";
import { api } from "../lib/api";

interface WebhookState {
  webhooks: WebhookSubscription[];
  loading: boolean;
  error: string | null;

  // Drill-down state
  selectedWebhookId: string | null;
  events: WebhookEvent[];
  eventsLoading: boolean;
  eventsError: string | null;

  fetchAll: () => Promise<void>;
  addWebhook: (w: WebhookSubscription) => void;
  removeWebhook: (id: string) => void;
  updateWebhook: (id: string, updates: Partial<WebhookSubscription>) => void;
  selectWebhook: (id: string | null) => void;
  fetchEvents: (webhookId: string) => Promise<void>;
}

export const useWebhookStore = create<WebhookState>((set, get) => ({
  webhooks: [],
  loading: false,
  error: null,

  selectedWebhookId: null,
  events: [],
  eventsLoading: false,
  eventsError: null,

  fetchAll: async () => {
    set({ loading: true, error: null });
    try {
      const webhooks = await api.webhooks.list();
      set({ webhooks, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  addWebhook: (w) =>
    set((st) => ({ webhooks: [w, ...st.webhooks] })),

  removeWebhook: (id) =>
    set((st) => ({ webhooks: st.webhooks.filter((w) => w.id !== id) })),

  updateWebhook: (id, updates) =>
    set((st) => ({
      webhooks: st.webhooks.map((w) =>
        w.id === id ? { ...w, ...updates } : w
      ),
    })),

  selectWebhook: (id) => {
    set({ selectedWebhookId: id, events: [], eventsLoading: !!id, eventsError: null });
    if (id) get().fetchEvents(id);
  },

  fetchEvents: async (webhookId) => {
    set({ eventsLoading: true, eventsError: null });
    try {
      const events = await api.webhooks.events(webhookId);
      set({ events, eventsLoading: false });
    } catch (err) {
      set({
        eventsLoading: false,
        eventsError: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));
