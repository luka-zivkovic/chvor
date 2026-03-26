import { create } from "zustand";
import type { Skill } from "@chvor/shared";
import { api } from "../lib/api";

export type SkillWithEnabled = Skill & { enabled: boolean };

interface SkillState {
  skills: SkillWithEnabled[];
  loading: boolean;
  error: string | null;
  fetchSkills: () => Promise<void>;
}

export const useSkillStore = create<SkillState>((set) => ({
  skills: [],
  loading: false,
  error: null,

  fetchSkills: async () => {
    set({ loading: true, error: null });
    try {
      const skills = await api.skills.list();
      set({ skills, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },
}));
