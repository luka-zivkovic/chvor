import { create } from "zustand";
import type { AuthStatus, AuthMethod, AuthSession, ApiKeyInfo } from "@chvor/shared";
import { api } from "../lib/api";

interface AuthState {
  authEnabled: boolean;
  authenticated: boolean;
  setupComplete: boolean | null;
  authMethod: AuthMethod | null;
  sessions: AuthSession[];
  apiKeys: ApiKeyInfo[];
  loading: boolean;
  error: string | null;

  checkStatus: () => Promise<void>;
  login: (credentials: { username?: string; password?: string; pin?: string }) => Promise<boolean>;
  logout: () => Promise<void>;
  setAuthenticated: (v: boolean) => void;
  fetchSessions: () => Promise<void>;
  fetchApiKeys: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  authEnabled: false,
  authenticated: false,
  setupComplete: null,
  authMethod: null,
  sessions: [],
  apiKeys: [],
  loading: false,
  error: null,

  checkStatus: async () => {
    try {
      const status = await api.auth.status();
      set({
        authEnabled: status.enabled,
        setupComplete: status.setupComplete,
        authMethod: status.method,
        authenticated: status.authenticated,
      });
    } catch {
      // Server unreachable — assume not authenticated
      set({ authenticated: false, setupComplete: null });
    }
  },

  login: async (credentials) => {
    set({ loading: true, error: null });
    try {
      await api.auth.login(credentials);
      set({ authenticated: true, loading: false, error: null });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      set({ error: msg, loading: false });
      return false;
    }
  },

  logout: async () => {
    try {
      await api.auth.logout();
    } catch {
      // ignore
    }
    set({ authenticated: false });
  },

  setAuthenticated: (v) => set({ authenticated: v }),

  fetchSessions: async () => {
    try {
      const sessions = await api.auth.sessions();
      set({ sessions, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to load sessions" });
    }
  },

  fetchApiKeys: async () => {
    try {
      const apiKeys = await api.auth.apiKeys();
      set({ apiKeys, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to load API keys" });
    }
  },
}));
