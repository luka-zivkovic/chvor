import { create } from "zustand";
import type { PersonaConfig, UpdatePersonaRequest } from "@chvor/shared";
import { api } from "../lib/api";

interface PersonaState {
  persona: PersonaConfig | null;
  loading: boolean;
  error: string | null;

  fetchPersona: () => Promise<void>;
  updatePersona: (updates: UpdatePersonaRequest) => Promise<void>;
}

export const usePersonaStore = create<PersonaState>((set) => ({
  persona: null,
  loading: false,
  error: null,

  fetchPersona: async () => {
    set({ loading: true, error: null });
    try {
      const persona = await api.persona.get();
      set({ persona, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  updatePersona: async (updates) => {
    try {
      const persona = await api.persona.update(updates);
      set({ persona });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
