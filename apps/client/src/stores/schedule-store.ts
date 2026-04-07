import { create } from "zustand";
import type { Schedule, ScheduleRun } from "@chvor/shared";
import { api } from "../lib/api";

interface ScheduleState {
  schedules: Schedule[];
  loading: boolean;
  error: string | null;

  // Drill-down state
  selectedScheduleId: string | null;
  runs: ScheduleRun[];
  runsLoading: boolean;

  fetchAll: () => Promise<void>;
  addSchedule: (s: Schedule) => void;
  removeSchedule: (id: string) => void;
  updateSchedule: (id: string, updates: Partial<Schedule>) => void;
  selectSchedule: (id: string | null) => void;
  fetchRuns: (scheduleId: string) => Promise<void>;
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  schedules: [],
  loading: false,
  error: null,

  selectedScheduleId: null,
  runs: [],
  runsLoading: false,

  fetchAll: async () => {
    set({ loading: true, error: null });
    try {
      const schedules = await api.schedules.list();
      set({ schedules, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  addSchedule: (s) =>
    set((st) => ({ schedules: [s, ...st.schedules] })),

  removeSchedule: (id) =>
    set((st) => ({ schedules: st.schedules.filter((s) => s.id !== id) })),

  updateSchedule: (id, updates) =>
    set((st) => ({
      schedules: st.schedules.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      ),
    })),

  selectSchedule: (id) => {
    set({ selectedScheduleId: id, runs: [], runsLoading: !!id });
    if (id) get().fetchRuns(id);
  },

  fetchRuns: async (scheduleId) => {
    set({ runsLoading: true });
    try {
      const runs = await api.schedules.runs(scheduleId);
      set({ runs, runsLoading: false });
    } catch (err) {
      console.error("[schedule-store] failed to fetch runs:", err);
      set({ runsLoading: false });
    }
  },
}));
