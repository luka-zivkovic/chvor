import { create } from "zustand";
import type { CredentialSummary, AnyProviderDef, LLMProviderDef, EmbeddingProviderDef, IntegrationProviderDef, OAuthProviderDef, OAuthConnection } from "@chvor/shared";
import { api } from "../lib/api";
import { invalidateSttStatus } from "../components/chat/MicButton";

interface CredentialState {
  credentials: CredentialSummary[];
  providers: AnyProviderDef[];
  llmProviders: LLMProviderDef[];
  embeddingProviders: EmbeddingProviderDef[];
  integrationProviders: IntegrationProviderDef[];
  oauthProviders: (OAuthProviderDef & { connected: boolean; hasSetupCredentials: boolean })[];
  oauthConnections: OAuthConnection[];
  hasComposioKey: boolean;
  loading: boolean;
  error: string | null;

  fetchAll: () => Promise<void>;
  fetchOAuthState: () => Promise<void>;
  addCredential: (cred: CredentialSummary) => void;
  removeCredential: (id: string) => void;
  updateCredential: (id: string, updates: Partial<CredentialSummary>) => void;
}

export const useCredentialStore = create<CredentialState>((set) => ({
  credentials: [],
  providers: [],
  llmProviders: [],
  embeddingProviders: [],
  integrationProviders: [],
  oauthProviders: [],
  oauthConnections: [],
  hasComposioKey: false,
  loading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null });

    const [credResult, provResult] = await Promise.allSettled([
      api.credentials.list(),
      api.providers.list(),
    ]);

    const credentials =
      credResult.status === "fulfilled" ? credResult.value : [];

    let providers: AnyProviderDef[] = [];
    let llmProviders: LLMProviderDef[] = [];
    let embeddingProviders: EmbeddingProviderDef[] = [];
    let integrationProviders: IntegrationProviderDef[] = [];

    if (provResult.status === "fulfilled") {
      const data = provResult.value;
      llmProviders = data.llm ?? [];
      embeddingProviders = data.embedding ?? [];
      integrationProviders = data.integration ?? [];
      // Backward compat: flat array of all non-embedding providers
      providers = [...llmProviders, ...integrationProviders];
    }

    const error =
      credResult.status === "rejected"
        ? String(credResult.reason)
        : provResult.status === "rejected"
          ? String(provResult.reason)
          : null;

    set({ credentials, providers, llmProviders, embeddingProviders, integrationProviders, loading: false, error });
  },

  fetchOAuthState: async () => {
    try {
      const data = await api.oauth.providers();
      set({
        oauthProviders: data.providers,
        oauthConnections: data.connections,
        hasComposioKey: data.hasComposioKey,
      });
    } catch {
      // OAuth endpoints may not be available — ignore
    }
  },

  addCredential: (cred) => {
    set((s) => ({ credentials: [cred, ...s.credentials] }));
    invalidateSttStatus();
  },

  removeCredential: (id) => {
    set((s) => ({ credentials: s.credentials.filter((c) => c.id !== id) }));
    invalidateSttStatus();
  },

  updateCredential: (id, updates) => {
    set((s) => ({
      credentials: s.credentials.map((c) =>
        c.id === id ? { ...c, ...updates } : c
      ),
    }));
    invalidateSttStatus();
  },
}));
