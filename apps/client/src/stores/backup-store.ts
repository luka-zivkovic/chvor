import { create } from "zustand";
import type { BackupInfo, BackupConfig, UpdateBackupConfigRequest } from "@chvor/shared";
import { api } from "../lib/api";

interface BackupState {
  backups: BackupInfo[];
  config: BackupConfig | null;
  creating: boolean;
  restoring: boolean;
  error: string | null;

  fetchBackups: () => Promise<void>;
  fetchConfig: () => Promise<void>;
  updateConfig: (updates: UpdateBackupConfigRequest) => Promise<void>;
  createBackup: () => Promise<BackupInfo | null>;
  deleteBackup: (id: string) => Promise<void>;
  restoreBackup: (file: File) => Promise<boolean>;
}

export const useBackupStore = create<BackupState>((set, get) => ({
  backups: [],
  config: null,
  creating: false,
  restoring: false,
  error: null,

  fetchBackups: async () => {
    try {
      const backups = await api.backup.list();
      set({ backups });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  fetchConfig: async () => {
    try {
      const config = await api.backup.getConfig();
      set({ config });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  updateConfig: async (updates) => {
    try {
      const config = await api.backup.updateConfig(updates);
      set({ config });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  createBackup: async () => {
    set({ creating: true, error: null });
    try {
      const info = await api.backup.create();
      await get().fetchBackups();
      set({ creating: false });
      return info;
    } catch (err) {
      set({ creating: false, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  deleteBackup: async (id) => {
    try {
      await api.backup.delete(id);
      await get().fetchBackups();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  restoreBackup: async (file) => {
    set({ restoring: true, error: null });
    try {
      await api.backup.restore(file);
      set({ restoring: false });
      return true;
    } catch (err) {
      set({ restoring: false, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },
}));
