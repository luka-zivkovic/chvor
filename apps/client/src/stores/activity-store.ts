import { create } from "zustand";
import { api } from "../lib/api";
import type { ActivityEntry } from "@chvor/shared";

interface ActivityState {
  activities: ActivityEntry[];
  unreadCount: number;
  loading: boolean;

  fetchActivities: () => Promise<void>;
  fetchUnread: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  handleActivityEvent: (entry: ActivityEntry) => void;
}

export const useActivityStore = create<ActivityState>((set) => ({
  activities: [],
  unreadCount: 0,
  loading: false,

  fetchActivities: async () => {
    set({ loading: true });
    try {
      const activities = await api.activity.list();
      set({ activities, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  fetchUnread: async () => {
    try {
      const { count } = await api.activity.unread();
      set({ unreadCount: count });
    } catch {
      /* non-critical */
    }
  },

  markRead: async (id: string) => {
    try {
      await api.activity.markRead(id);
      set((s) => ({
        activities: s.activities.map((a) => (a.id === id ? { ...a, read: true } : a)),
        unreadCount: Math.max(0, s.unreadCount - 1),
      }));
    } catch {
      /* non-critical */
    }
  },

  markAllRead: async () => {
    try {
      await api.activity.markAllRead();
      set((s) => ({
        activities: s.activities.map((a) => ({ ...a, read: true })),
        unreadCount: 0,
      }));
    } catch {
      /* non-critical */
    }
  },

  handleActivityEvent: (entry: ActivityEntry) => {
    set((s) => {
      if (s.activities.some((a) => a.id === entry.id)) return s;
      return {
        activities: [entry, ...s.activities].slice(0, 200),
        unreadCount: s.unreadCount + 1,
      };
    });
  },
}));
