// Consolidated config-store.
// Merges persona-store + models-store + pulse-store + retention-store +
// session-lifecycle-store + backup-store into a single Zustand store.
//
// PROPERTY/ACTION RENAMES (collision resolution):
//   • persona-store        loading/error              → personaLoading / personaError
//   • models-store         loading                    → modelsLoading
//                          fetchConfig                → fetchModelsConfig
//   • pulse-store          loading/error              → pulseLoading / pulseError
//   • retention-store      loading/error              → retentionLoading / retentionError
//                          config                     → retentionConfig
//                          fetchConfig                → fetchRetentionConfig
//                          updateConfig               → updateRetentionConfig
//   • session-lifecycle    loading/error              → sessionLifecycleLoading / sessionLifecycleError
//                          config                     → sessionLifecycleConfig
//                          fetchConfig                → fetchSessionLifecycleConfig
//                          updateConfig               → updateSessionLifecycleConfig
//   • backup-store         error                      → backupError
//                          config                     → backupConfig
//                          fetchConfig                → fetchBackupConfig
//                          updateConfig               → updateBackupConfig
//
// Non-colliding properties keep their original names.

import { create } from "zustand";
import { toast } from "sonner";
import type {
  PersonaConfig,
  UpdatePersonaRequest,
  ModelRole,
  ModelRoleConfig,
  ModelRolesConfig,
  EmbeddingConfig,
  RoleFallbackEntry,
  PulseConfig,
  UpdatePulseRequest,
  RetentionConfig,
  UpdateRetentionRequest,
  SessionLifecycleConfig,
  UpdateSessionLifecycleRequest,
  BackupInfo,
  BackupConfig,
  UpdateBackupConfigRequest,
} from "@chvor/shared";
import { api } from "../lib/api";

interface ConfigState {
  // ── persona ────────────────────────────────────────────────
  persona: PersonaConfig | null;
  personaLoading: boolean;
  personaError: string | null;
  fetchPersona: () => Promise<void>;
  updatePersona: (updates: UpdatePersonaRequest) => Promise<void>;

  // ── models ─────────────────────────────────────────────────
  roles: ModelRolesConfig;
  embedding: EmbeddingConfig;
  defaults: Record<string, ModelRoleConfig | null>;
  fallbacks: Record<string, RoleFallbackEntry[]>;
  modelsLoading: boolean;
  reembedStatus: { status: "idle" | "running"; done: number; total: number };

  fetchModelsConfig: () => Promise<void>;
  setRole: (role: ModelRole, providerId: string | null, model: string | null) => Promise<void>;
  setFallbacks: (role: ModelRole, entries: RoleFallbackEntry[]) => Promise<void>;
  setEmbedding: (providerId: string, model: string) => Promise<void>;
  triggerReembed: () => Promise<void>;
  pollReembedStatus: () => Promise<void>;

  // ── pulse ──────────────────────────────────────────────────
  pulse: PulseConfig | null;
  pulseLoading: boolean;
  pulseError: string | null;
  fetchPulse: () => Promise<void>;
  updatePulse: (updates: UpdatePulseRequest) => Promise<void>;

  // ── retention ──────────────────────────────────────────────
  retentionConfig: RetentionConfig | null;
  retentionLoading: boolean;
  retentionError: string | null;
  fetchRetentionConfig: () => Promise<void>;
  updateRetentionConfig: (updates: UpdateRetentionRequest) => Promise<void>;

  // ── session lifecycle ──────────────────────────────────────
  sessionLifecycleConfig: SessionLifecycleConfig | null;
  sessionLifecycleLoading: boolean;
  sessionLifecycleError: string | null;
  fetchSessionLifecycleConfig: () => Promise<void>;
  updateSessionLifecycleConfig: (updates: UpdateSessionLifecycleRequest) => Promise<void>;

  // ── backup ─────────────────────────────────────────────────
  backups: BackupInfo[];
  backupConfig: BackupConfig | null;
  creating: boolean;
  restoring: boolean;
  backupError: string | null;
  fetchBackups: () => Promise<void>;
  fetchBackupConfig: () => Promise<void>;
  updateBackupConfig: (updates: UpdateBackupConfigRequest) => Promise<void>;
  createBackup: () => Promise<BackupInfo | null>;
  deleteBackup: (id: string) => Promise<void>;
  restoreBackup: (file: File) => Promise<boolean>;
}

function applyModelsConfigResponse(data: { roles: ModelRolesConfig; embedding: EmbeddingConfig; defaults?: Record<string, ModelRoleConfig | null>; fallbacks?: Record<string, RoleFallbackEntry[]> }) {
  return {
    roles: data.roles,
    embedding: data.embedding,
    defaults: data.defaults ?? {},
    fallbacks: data.fallbacks ?? {},
  };
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  // ── persona ────────────────────────────────────────────────
  persona: null,
  personaLoading: false,
  personaError: null,

  fetchPersona: async () => {
    set({ personaLoading: true, personaError: null });
    try {
      const persona = await api.persona.get();
      set({ persona, personaLoading: false });
    } catch (err) {
      set({
        personaError: err instanceof Error ? err.message : String(err),
        personaLoading: false,
      });
    }
  },

  updatePersona: async (updates) => {
    try {
      const persona = await api.persona.update(updates);
      set({ persona });
    } catch (err) {
      set({ personaError: err instanceof Error ? err.message : String(err) });
    }
  },

  // ── models ─────────────────────────────────────────────────
  roles: { primary: null, reasoning: null, lightweight: null, heartbeat: null },
  embedding: { providerId: "local", model: "Xenova/all-MiniLM-L6-v2", dimensions: 384 },
  defaults: {},
  fallbacks: {},
  modelsLoading: false,
  reembedStatus: { status: "idle", done: 0, total: 0 },

  fetchModelsConfig: async () => {
    set({ modelsLoading: true });
    try {
      const data = await api.models.get();
      set({ ...applyModelsConfigResponse(data), modelsLoading: false });
    } catch (err) {
      console.error("[config-store] fetchModelsConfig failed:", err);
      set({ modelsLoading: false });
    }
  },

  setRole: async (role, providerId, model) => {
    try {
      const result = await api.models.setRole({ role, providerId, model });
      set(applyModelsConfigResponse(result));
    } catch (err) {
      console.error("[config-store] setRole failed:", err);
      toast.error("Failed to update model configuration");
    }
  },

  setFallbacks: async (role, entries) => {
    try {
      const result = await api.models.setFallbacks({ role, fallbacks: entries });
      set(applyModelsConfigResponse(result));
    } catch (err) {
      console.error("[config-store] setFallbacks failed:", err);
    }
  },

  setEmbedding: async (providerId, model) => {
    try {
      const result = await api.models.setEmbedding({ embedding: { providerId, model } });
      set(applyModelsConfigResponse(result));
    } catch (err) {
      console.error("[config-store] setEmbedding failed:", err);
    }
  },

  triggerReembed: async () => {
    try {
      const result = await api.models.reembed();
      set({ reembedStatus: { status: "running", done: 0, total: result.total } });
    } catch (err) {
      console.error("[config-store] reembed failed:", err);
    }
  },

  pollReembedStatus: async () => {
    try {
      const result = await api.models.reembedStatus();
      set({
        reembedStatus: {
          status: result.status as "idle" | "running",
          done: result.progress.done,
          total: result.progress.total,
        },
      });
    } catch {
      // Ignore polling errors
    }
  },

  // ── pulse ──────────────────────────────────────────────────
  pulse: null,
  pulseLoading: false,
  pulseError: null,

  fetchPulse: async () => {
    set({ pulseLoading: true, pulseError: null });
    try {
      const pulse = await api.pulse.get();
      set({ pulse, pulseLoading: false });
    } catch (err) {
      set({
        pulseError: err instanceof Error ? err.message : String(err),
        pulseLoading: false,
      });
    }
  },

  updatePulse: async (updates) => {
    try {
      const pulse = await api.pulse.update(updates);
      set({ pulse });
    } catch (err) {
      set({ pulseError: err instanceof Error ? err.message : String(err) });
    }
  },

  // ── retention ──────────────────────────────────────────────
  retentionConfig: null,
  retentionLoading: false,
  retentionError: null,

  fetchRetentionConfig: async () => {
    set({ retentionLoading: true, retentionError: null });
    try {
      const config = await api.retention.get();
      set({ retentionConfig: config, retentionLoading: false });
    } catch (err) {
      set({
        retentionError: err instanceof Error ? err.message : String(err),
        retentionLoading: false,
      });
    }
  },

  updateRetentionConfig: async (updates) => {
    try {
      const config = await api.retention.update(updates);
      set({ retentionConfig: config });
    } catch (err) {
      set({ retentionError: err instanceof Error ? err.message : String(err) });
    }
  },

  // ── session lifecycle ──────────────────────────────────────
  sessionLifecycleConfig: null,
  sessionLifecycleLoading: false,
  sessionLifecycleError: null,

  fetchSessionLifecycleConfig: async () => {
    set({ sessionLifecycleLoading: true, sessionLifecycleError: null });
    try {
      const config = await api.sessionLifecycle.get();
      set({ sessionLifecycleConfig: config, sessionLifecycleLoading: false });
    } catch (err) {
      set({
        sessionLifecycleError: err instanceof Error ? err.message : String(err),
        sessionLifecycleLoading: false,
      });
    }
  },

  updateSessionLifecycleConfig: async (updates) => {
    try {
      const config = await api.sessionLifecycle.update(updates);
      set({ sessionLifecycleConfig: config });
    } catch (err) {
      set({ sessionLifecycleError: err instanceof Error ? err.message : String(err) });
    }
  },

  // ── backup ─────────────────────────────────────────────────
  backups: [],
  backupConfig: null,
  creating: false,
  restoring: false,
  backupError: null,

  fetchBackups: async () => {
    try {
      const backups = await api.backup.list();
      set({ backups });
    } catch (err) {
      set({ backupError: err instanceof Error ? err.message : String(err) });
    }
  },

  fetchBackupConfig: async () => {
    try {
      const config = await api.backup.getConfig();
      set({ backupConfig: config });
    } catch (err) {
      set({ backupError: err instanceof Error ? err.message : String(err) });
    }
  },

  updateBackupConfig: async (updates) => {
    try {
      const config = await api.backup.updateConfig(updates);
      set({ backupConfig: config });
    } catch (err) {
      set({ backupError: err instanceof Error ? err.message : String(err) });
    }
  },

  createBackup: async () => {
    set({ creating: true, backupError: null });
    try {
      const info = await api.backup.create();
      await get().fetchBackups();
      set({ creating: false });
      return info;
    } catch (err) {
      set({ creating: false, backupError: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  deleteBackup: async (id) => {
    try {
      await api.backup.delete(id);
      await get().fetchBackups();
    } catch (err) {
      set({ backupError: err instanceof Error ? err.message : String(err) });
    }
  },

  restoreBackup: async (file) => {
    set({ restoring: true, backupError: null });
    try {
      await api.backup.restore(file);
      set({ restoring: false });
      return true;
    } catch (err) {
      set({ restoring: false, backupError: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },
}));
