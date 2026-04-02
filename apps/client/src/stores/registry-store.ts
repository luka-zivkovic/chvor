import { create } from "zustand";
import type { RegistryEntry, RegistryEntryKind } from "@chvor/shared";
import { api } from "../lib/api";

export type RegistryEntryWithStatus = RegistryEntry & {
  installed: boolean;
  installedVersion: string | null;
  hasBundledVersion?: boolean;
  bundledVersion?: string | null;
};

export interface UpdateInfo {
  id: string;
  kind: string;
  current: string;
  available: string;
  userModified: boolean;
  isBundled?: boolean;
  bundledVersion?: string;
}

interface RegistryState {
  entries: RegistryEntryWithStatus[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  categoryFilter: string | null;
  kindFilter: RegistryEntryKind | null;
  availableUpdates: UpdateInfo[];

  search: (query?: string, category?: string, kind?: RegistryEntryKind | null) => Promise<void>;
  install: (id: string, kind?: RegistryEntryKind) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
  checkUpdates: () => Promise<void>;
  applyUpdate: (id: string) => Promise<void>;
  applyAllUpdates: () => Promise<void>;
  refresh: () => Promise<void>;
  setKindFilter: (kind: RegistryEntryKind | null) => void;
}

export const useRegistryStore = create<RegistryState>((set, get) => ({
  entries: [],
  loading: false,
  error: null,
  searchQuery: "",
  categoryFilter: null,
  kindFilter: null,
  availableUpdates: [],

  search: async (query?: string, category?: string, kind?: RegistryEntryKind | null) => {
    const q = query ?? get().searchQuery;
    const cat = category ?? get().categoryFilter;
    const k = kind !== undefined ? kind : get().kindFilter;
    set({ loading: true, error: null, searchQuery: q, categoryFilter: cat, kindFilter: k });
    try {
      const entries = await api.registry.search({
        q: q || undefined,
        category: cat || undefined,
        kind: k || undefined,
      });
      set({ entries, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },

  install: async (id: string, kind?: RegistryEntryKind) => {
    try {
      await api.registry.install(id, kind);
      // Refresh to update install status
      await get().search();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  uninstall: async (id: string) => {
    try {
      await api.registry.uninstall(id);
      await get().search();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  checkUpdates: async () => {
    try {
      const updates = await api.registry.checkUpdates();
      set({ availableUpdates: updates });
    } catch (err) {
      console.warn("[registry-store] update check failed:", err);
    }
  },

  applyUpdate: async (id: string) => {
    try {
      await api.registry.update(id);
      set((s) => ({
        availableUpdates: s.availableUpdates.filter((u) => u.id !== id),
      }));
      await get().search();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  applyAllUpdates: async () => {
    try {
      await api.registry.updateAll();
      set({ availableUpdates: [] });
      await get().search();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  refresh: async () => {
    try {
      await api.registry.refresh();
      await get().search();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  setKindFilter: (kind: RegistryEntryKind | null) => {
    set({ kindFilter: kind });
    get().search(undefined, undefined, kind);
  },
}));
