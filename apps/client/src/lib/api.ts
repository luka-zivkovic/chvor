import type {
  ChatMessage,
  CredentialSummary,
  LLMProviderDef,
  EmbeddingProviderDef,
  IntegrationProviderDef,
  ModelRoleConfig,
  ModelRolesConfig,
  EmbeddingConfig,
  Skill,
  Tool,
  Workspace,
  Schedule,
  ScheduleRun,
  Memory,
  UpdateMemoryRequest,
  PersonaConfig,
  UpdatePersonaRequest,
  PulseConfig,
  UpdatePulseRequest,
  RetentionConfig,
  UpdateRetentionRequest,
  BrainConfig,
  UpdateBrainConfigRequest,
  ShellConfig,
  UpdateShellConfigRequest,
  CreateCredentialRequest,
  UpdateCredentialRequest,
  CreateScheduleRequest,
  UpdateScheduleRequest,
  WebhookSubscription,
  WebhookEvent,
  CreateWebhookRequest,
  UpdateWebhookRequest,
  TestCredentialRequest,
  TestCredentialResponse,
  ConversationSummary,
  ActivityEntry,
  SelfHealingStatus,
  ChannelPolicy,
  AuthStatus,
  AuthSession,
  ApiKeyInfo,
  CreateApiKeyResponse,
  AuthSetupResponse,
  AuthLoginResponse,
  AuthRecoverRequest,
  AuthRecoverResponse,
  BackupInfo,
  BackupConfig,
  UpdateBackupConfigRequest,
  UpdateChannelPolicyRequest,
  SessionLifecycleConfig,
  UpdateSessionLifecycleRequest,
  ModelDef,
  RoleFallbackEntry,
  RegistryEntry,
  SkillConfigParam,
  KnowledgeResource,
  FilesystemConfig,
  UpdateFilesystemConfigRequest,
  TrustedCommandsConfig,
  SandboxConfig,
  UpdateSandboxConfigRequest,
  SandboxStatus,
  DaemonConfig,
  UpdateDaemonConfigRequest,
  DaemonPresence,
  DaemonTask,
  CreateDaemonTaskRequest,
  MemoryGraphExport,
  MemoryStats,
  OAuthProviderDef,
  OAuthConnection,
} from "@chvor/shared";

export interface ProvidersResponse {
  llm: LLMProviderDef[];
  embedding: EmbeddingProviderDef[];
  integration: IntegrationProviderDef[];
  oauth?: OAuthProviderDef[];
}

export interface ModelsConfigResponse {
  roles: ModelRolesConfig;
  embedding: EmbeddingConfig;
  defaults: Record<string, ModelRoleConfig | null>;
  fallbacks: Record<string, RoleFallbackEntry[]>;
}

export interface ChannelTargetDTO {
  channelType: string;
  channelId: string;
  lastActive: string;
}

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    // Only set JSON content-type when body is a string (not FormData/Blob)
    ...(typeof init?.body === "string" || !init?.body ? { "Content-Type": "application/json" } : {}),
    ...(init?.headers as Record<string, string>),
  };

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  if (res.status === 401) {
    // Session expired or not authenticated — notify auth store
    const { useAuthStore } = await import("../stores/auth-store");
    useAuthStore.getState().setAuthenticated(false);
    throw new Error("Session expired");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  const json = (await res.json()) as { data: T };
  return json.data;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  credentials: {
    list: () => request<CredentialSummary[]>("/credentials"),

    create: (body: CreateCredentialRequest) =>
      request<CredentialSummary>("/credentials", {
        method: "POST",
        body: JSON.stringify(body),
      }),

    update: (id: string, body: UpdateCredentialRequest) =>
      request<CredentialSummary>(`/credentials/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),

    delete: (id: string) =>
      request<null>(`/credentials/${id}`, { method: "DELETE" }),

    test: (body: TestCredentialRequest) =>
      request<TestCredentialResponse>("/credentials/test", {
        method: "POST",
        body: JSON.stringify(body),
      }),

    testSaved: (id: string) =>
      request<TestCredentialResponse>(`/credentials/${id}/test`, {
        method: "POST",
      }),
  },

  providers: {
    list: () => request<ProvidersResponse>("/providers"),
    discovery: () => request<{ discovered: string[] }>("/providers/discovery"),
    models: (providerId: string) =>
      request<{ models: ModelDef[]; source: "api" | "static" }>(`/providers/${providerId}/models`),
  },

  skills: {
    list: () => request<(Skill & { enabled: boolean })[]>("/skills"),
    get: (id: string) => request<Skill & { enabled: boolean }>(`/skills/${id}`),
    reload: () => request<Skill[]>("/skills/reload", { method: "POST" }),
    toggle: (id: string, enabled?: boolean) =>
      request<{ id: string; enabled: boolean }>(`/skills/${id}/toggle`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled !== undefined ? { enabled } : {}),
      }),
    exportSkill: (id: string) =>
      fetch(`${BASE}/skills/${id}/export`, {
        credentials: "same-origin",
      }).then((r) => r.text()),
    importSkill: (content: string) =>
      request<Skill>("/skills/import", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: content,
      }),
    delete: (id: string) =>
      request<null>(`/skills/${id}`, { method: "DELETE" }),
    getConfig: (id: string) =>
      request<{ params: SkillConfigParam[]; values: Record<string, unknown> }>(`/skills/${id}/config`),
    updateConfig: (id: string, values: Record<string, unknown>) =>
      request<{ id: string; updated: boolean }>(`/skills/${id}/config`, {
        method: "PATCH",
        body: JSON.stringify(values),
      }),
    getInstructions: (id: string) =>
      request<{ id: string; original: string; override: string | null; hasOverride: boolean }>(`/skills/${id}/instructions`),
    updateInstructions: (id: string, instructions: string) =>
      request<{ id: string; hasOverride: boolean }>(`/skills/${id}/instructions`, {
        method: "PATCH",
        body: JSON.stringify({ instructions }),
      }),
    resetInstructions: (id: string) =>
      request<{ id: string; hasOverride: boolean }>(`/skills/${id}/instructions`, { method: "DELETE" }),
  },

  registry: {
    search: (params?: { q?: string; category?: string; tags?: string[]; kind?: string }) => {
      const qs = new URLSearchParams();
      if (params?.q) qs.set("q", params.q);
      if (params?.category) qs.set("category", params.category);
      if (params?.tags?.length) qs.set("tags", params.tags.join(","));
      if (params?.kind) qs.set("kind", params.kind);
      return request<(RegistryEntry & { installed: boolean; installedVersion: string | null })[]>(
        `/registry/search?${qs.toString()}`,
      );
    },
    getEntry: (id: string) =>
      request<RegistryEntry & { installed: boolean; installedVersion: string | null; userModified: boolean }>(
        `/registry/entry/${encodeURIComponent(id)}`,
      ),
    /** @deprecated Use getEntry */
    getSkill: (id: string) =>
      request<RegistryEntry & { installed: boolean; installedVersion: string | null; userModified: boolean }>(
        `/registry/skill/${encodeURIComponent(id)}`,
      ),
    install: (id: string, kind?: string) =>
      request<{ entry: Skill | Tool; skill: Skill | Tool; dependencies: string[] }>("/registry/install", {
        method: "POST",
        body: JSON.stringify({ id, kind }),
      }),
    uninstall: (id: string) =>
      request<{ id: string; uninstalled: boolean }>(`/registry/entry/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    checkUpdates: () =>
      request<Array<{ id: string; kind: string; current: string; available: string; userModified: boolean; isBundled?: boolean; bundledVersion?: string }>>("/registry/updates"),
    update: (id: string, force?: boolean) =>
      request<{ id: string; updated: boolean; conflict: boolean }>("/registry/update", {
        method: "POST",
        body: JSON.stringify({ id, force }),
      }),
    updateAll: (force?: boolean) =>
      request<Array<{ id: string; updated: boolean; conflict: boolean }>>("/registry/update", {
        method: "POST",
        body: JSON.stringify({ all: true, force }),
      }),
    refresh: () =>
      request<{ entryCount: number; skillCount: number; updatedAt: string }>("/registry/refresh", { method: "POST" }),
  },

  tools: {
    list: () => request<(Tool & { enabled: boolean })[]>("/tools"),
    get: (id: string) => request<Tool & { enabled: boolean }>(`/tools/${id}`),
    reload: () => request<Tool[]>("/tools/reload", { method: "POST" }),
    toggle: (id: string, enabled?: boolean) =>
      request<{ id: string; enabled: boolean }>(`/tools/${id}/toggle`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled !== undefined ? { enabled } : {}),
      }),
    exportTool: (id: string) =>
      fetch(`${BASE}/tools/${id}/export`, {
        credentials: "same-origin",
      }).then((r) => r.text()),
    importTool: (content: string) =>
      request<Tool>("/tools/import", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: content,
      }),
    delete: (id: string) =>
      request<null>(`/tools/${id}`, { method: "DELETE" }),
    getInstructions: (id: string) =>
      request<{ id: string; original: string; override: string | null; hasOverride: boolean }>(`/tools/${id}/instructions`),
    updateInstructions: (id: string, instructions: string) =>
      request<{ id: string; hasOverride: boolean }>(`/tools/${id}/instructions`, {
        method: "PATCH",
        body: JSON.stringify({ instructions }),
      }),
    resetInstructions: (id: string) =>
      request<{ id: string; hasOverride: boolean }>(`/tools/${id}/instructions`, { method: "DELETE" }),
  },

  schedules: {
    list: () => request<Schedule[]>("/schedules"),
    get: (id: string) => request<Schedule>(`/schedules/${id}`),
    create: (body: CreateScheduleRequest) =>
      request<Schedule>("/schedules", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    update: (id: string, body: UpdateScheduleRequest) =>
      request<Schedule>(`/schedules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    delete: (id: string) =>
      request<null>(`/schedules/${id}`, { method: "DELETE" }),
    toggle: (id: string, enabled: boolean) =>
      request<Schedule>(`/schedules/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    runs: (id: string) => request<ScheduleRun[]>(`/schedules/${id}/runs`),
  },

  webhooks: {
    list: () => request<WebhookSubscription[]>("/webhooks"),
    get: (id: string) => request<WebhookSubscription>(`/webhooks/${id}`),
    create: (body: CreateWebhookRequest) =>
      request<WebhookSubscription & { webhookUrl: string }>("/webhooks", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    update: (id: string, body: UpdateWebhookRequest) =>
      request<WebhookSubscription>(`/webhooks/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    delete: (id: string) =>
      request<null>(`/webhooks/${id}`, { method: "DELETE" }),
    toggle: (id: string, enabled: boolean) =>
      request<WebhookSubscription>(`/webhooks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    events: (id: string) => request<WebhookEvent[]>(`/webhooks/${id}/events`),
  },

  memories: {
    list: () => request<Memory[]>("/memories"),
    create: (content: string) =>
      request<Memory>("/memories", {
        method: "POST",
        body: JSON.stringify({ content }),
      }),
    update: (id: string, body: UpdateMemoryRequest) =>
      request<Memory>(`/memories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    delete: (id: string) =>
      request<null>(`/memories/${id}`, { method: "DELETE" }),
    deleteAll: () => request<null>("/memories", { method: "DELETE" }),
    graph: () => request<MemoryGraphExport>("/memories/graph"),
    stats: () => request<MemoryStats>("/memories/stats"),
  },

  knowledge: {
    list: () => request<KnowledgeResource[]>("/knowledge"),
    get: (id: string) => request<KnowledgeResource>(`/knowledge/${id}`),
    getMemories: (id: string) => request<Memory[]>(`/knowledge/${id}/memories`),
    delete: (id: string) => request<null>(`/knowledge/${id}`, { method: "DELETE" }),
    reprocess: (id: string) =>
      request<{ reprocessing: boolean; removedMemories: number }>(`/knowledge/${id}/reprocess`, { method: "POST" }),
    ingestUrl: (url: string, title?: string) =>
      request<KnowledgeResource>("/knowledge/url", {
        method: "POST",
        body: JSON.stringify({ url, title }),
      }),
    upload: async (file: File, title?: string): Promise<KnowledgeResource> => {
      const form = new FormData();
      form.append("file", file);
      if (title) form.append("title", title);
      const res = await fetch(`${BASE}/knowledge/upload`, {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { data: KnowledgeResource };
      return json.data;
    },
  },

  persona: {
    get: () => request<PersonaConfig>("/persona"),
    update: (body: UpdatePersonaRequest) =>
      request<PersonaConfig>("/persona", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },

  pulse: {
    get: () => request<PulseConfig>("/pulse"),
    update: (body: UpdatePulseRequest) =>
      request<PulseConfig>("/pulse", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },

  activity: {
    list: (limit?: number, offset?: number) =>
      request<ActivityEntry[]>(`/activity?limit=${limit ?? 50}&offset=${offset ?? 0}`),
    unread: () => request<{ count: number }>("/activity/unread"),
    markRead: (id: string) =>
      request<{ ok: boolean }>(`/activity/${id}/read`, { method: "PATCH" }),
    markAllRead: () =>
      request<{ ok: boolean }>("/activity/read-all", { method: "PATCH" }),
  },

  retention: {
    get: () => request<RetentionConfig>("/config/retention"),
    update: (body: UpdateRetentionRequest) =>
      request<RetentionConfig>("/config/retention", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },

  models: {
    get: () => request<ModelsConfigResponse>("/config/models"),
    setRole: (body: { role: string; providerId: string | null; model: string | null }) =>
      request<ModelsConfigResponse>("/config/models", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    setFallbacks: (body: { role: string; fallbacks: RoleFallbackEntry[] }) =>
      request<ModelsConfigResponse>("/config/models", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    setEmbedding: (body: { embedding: { providerId: string; model: string } }) =>
      request<ModelsConfigResponse>("/config/models", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    reembed: () =>
      request<{ total: number }>("/config/models/embedding/reembed", { method: "POST" }),
    reembedStatus: () =>
      request<{ status: string; progress: { done: number; total: number } }>("/config/models/embedding/status"),
    embeddingHealth: () =>
      request<{ embedderAvailable: boolean; activeProvider: string; vecAvailable: boolean }>("/config/models/embedding/health"),
    embeddingModelStatus: () =>
      request<{ status: string; percent: number; error?: string; onnxAvailable: boolean }>("/config/models/embedding/model-status"),
    embeddingModelDownload: () =>
      request<{ ok: boolean; status: string }>("/config/models/embedding/download", { method: "POST" }),
  },

  brainConfig: {
    get: () => request<BrainConfig>("/config/brain"),
    update: (body: UpdateBrainConfigRequest) =>
      request<BrainConfig>("/config/brain", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    getSelfHealing: () => request<{ enabled: boolean }>("/config/brain/self-healing"),
    updateSelfHealing: (enabled: boolean) =>
      request<{ enabled: boolean }>("/config/brain/self-healing", {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    getSelfHealingStatus: () => request<SelfHealingStatus>("/config/brain/self-healing/status"),
  },

  shellConfig: {
    get: () => request<ShellConfig>("/config/shell"),
    update: (body: UpdateShellConfigRequest) =>
      request<ShellConfig>("/config/shell", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },

  sandboxConfig: {
    get: () => request<SandboxConfig>("/config/sandbox"),
    update: (body: UpdateSandboxConfigRequest) =>
      request<SandboxConfig>("/config/sandbox", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    status: () => request<SandboxStatus>("/config/sandbox/status"),
    pull: (language?: string) =>
      request<Record<string, string>>("/config/sandbox/pull", {
        method: "POST",
        body: JSON.stringify({ language }),
      }),
  },

  daemon: {
    getConfig: () => request<DaemonConfig>("/daemon/config"),
    updateConfig: (body: UpdateDaemonConfigRequest) =>
      request<DaemonConfig>("/daemon/config", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    getPresence: () => request<DaemonPresence>("/daemon/presence"),
    listTasks: (status?: string) =>
      request<DaemonTask[]>(`/daemon/tasks${status ? `?status=${status}` : ""}`),
    createTask: (body: CreateDaemonTaskRequest) =>
      request<DaemonTask>("/daemon/tasks", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    getTask: (id: string) => request<DaemonTask>(`/daemon/tasks/${id}`),
    cancelTask: (id: string) =>
      request<null>(`/daemon/tasks/${id}`, { method: "DELETE" }),
  },

  templates: {
    exportYaml: () =>
      fetch(`${BASE}/templates/export`, { credentials: "same-origin" }).then((r) => {
        if (!r.ok) throw new Error(`Export failed: ${r.status}`);
        return r.text();
      }),
    getManifest: (id: string) =>
      request<import("@chvor/shared").TemplateManifest>(
        `/registry/entry/${encodeURIComponent(id)}/manifest`,
      ),
  },

  securityConfig: {
    get: () => request<{ allowLocalhost: boolean }>("/config/security"),
    update: (body: { allowLocalhost?: boolean }) =>
      request<{ allowLocalhost: boolean }>("/config/security", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    getFilesystem: () => request<FilesystemConfig>("/config/security/filesystem"),
    updateFilesystem: (body: UpdateFilesystemConfigRequest) =>
      request<FilesystemConfig>("/config/security/filesystem", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    getTrusted: () => request<TrustedCommandsConfig>("/config/security/trusted"),
    addTrusted: (kind: "shell" | "pc", pattern: string) =>
      request<TrustedCommandsConfig>("/config/security/trusted", {
        method: "POST",
        body: JSON.stringify({ kind, pattern }),
      }),
    removeTrusted: (kind: "shell" | "pc", pattern: string) =>
      request<TrustedCommandsConfig>("/config/security/trusted", {
        method: "DELETE",
        body: JSON.stringify({ kind, pattern }),
      }),
  },

  sessionLifecycle: {
    get: () => request<SessionLifecycleConfig>("/config/session-lifecycle"),
    update: (body: UpdateSessionLifecycleRequest) =>
      request<SessionLifecycleConfig>("/config/session-lifecycle", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    resetSession: (id: string) =>
      request<{ ok: boolean }>(`/config/session-lifecycle/reset/${encodeURIComponent(id)}`, {
        method: "POST",
      }),
  },

  llmConfig: {
    get: () => request<{ providerId: string; model: string } | null>("/config/llm"),
    set: (body: { providerId: string; model: string }) =>
      request<{ providerId: string; model: string }>("/config/llm", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    getThinking: () => request<{ enabled: boolean; budgetTokens: number }>("/config/llm/thinking"),
    setThinking: (body: { enabled: boolean; budgetTokens?: number }) =>
      request<{ enabled: boolean; budgetTokens: number }>("/config/llm/thinking", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },

  sessions: {
    targets: () => request<ChannelTargetDTO[]>("/sessions/targets"),
    list: (params?: { archived?: boolean; search?: string }) => {
      const qs = new URLSearchParams();
      if (params?.archived !== undefined) qs.set("archived", String(params.archived));
      if (params?.search) qs.set("search", params.search);
      const query = qs.toString();
      return request<ConversationSummary[]>(`/sessions${query ? `?${query}` : ""}`);
    },
    patch: (id: string, body: { title?: string; archived?: boolean }) =>
      request<{ ok: true }>(`/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    delete: (id: string) =>
      request<null>(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    messages: (compositeId: string) =>
      request<ChatMessage[]>(`/sessions/${encodeURIComponent(compositeId)}/messages`),
    generateTitle: (id: string) =>
      request<{ title: string | null; generated: boolean }>(
        `/sessions/${encodeURIComponent(id)}/generate-title`,
        { method: "POST" }
      ),
  },

  workspaces: {
    list: () => request<Workspace[]>("/workspaces"),
    get: (id: string) => request<Workspace>(`/workspaces/${id}`),
    save: (id: string, data: { nodes: unknown[]; edges: unknown[]; viewport: unknown; settings: unknown }) =>
      request<Workspace>(`/workspaces/${id}`, {
        method: "PUT",
        body: JSON.stringify({ data }),
      }),
  },

  whatsapp: {
    status: () =>
      request<{ status: "disconnected" | "connecting" | "connected"; phoneNumber?: string }>("/whatsapp/status"),
    connect: () =>
      request<{ status: string; message: string }>("/whatsapp/connect", { method: "POST" }),
    disconnect: () =>
      request<{ status: string }>("/whatsapp/disconnect", { method: "POST" }),
    getPolicy: () =>
      request<ChannelPolicy>("/channels/whatsapp/policy"),
    updatePolicy: (body: UpdateChannelPolicyRequest) =>
      request<ChannelPolicy>("/channels/whatsapp/policy", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },

  a2ui: {
    listSurfaces: () => request<import("@chvor/shared").A2UISurfaceListItem[]>("/a2ui/surfaces"),
    getSurface: (id: string) => request<import("@chvor/shared").A2UISurface>(`/a2ui/surfaces/${id}`),
    deleteSurface: (id: string) =>
      request<{ id: string; deleted: boolean }>(`/a2ui/surfaces/${encodeURIComponent(id)}`, { method: "DELETE" }),
    deleteAll: () =>
      request<{ deleted: boolean }>("/a2ui/surfaces", { method: "DELETE" }),
  },

  auth: {
    status: () => request<AuthStatus>("/auth/status"),
    setup: (body: { method: "password" | "pin"; username?: string; password?: string; pin?: string }) =>
      request<AuthSetupResponse>("/auth/setup", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    login: (body: { username?: string; password?: string; pin?: string }) =>
      request<AuthLoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    logout: () => request<null>("/auth/logout", { method: "POST" }),
    logoutAll: () => request<null>("/auth/logout-all", { method: "POST" }),
    disable: () => request<null>("/auth/disable", { method: "POST" }),
    recover: (body: AuthRecoverRequest) =>
      request<AuthRecoverResponse>("/auth/recover", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    sessions: () => request<AuthSession[]>("/auth/sessions"),
    deleteSession: (id: string) =>
      request<null>(`/auth/sessions/${id}`, { method: "DELETE" }),
    apiKeys: () => request<ApiKeyInfo[]>("/auth/api-keys"),
    createApiKey: (body: { name: string; expiresInDays?: number }) =>
      request<CreateApiKeyResponse>("/auth/api-keys", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    revokeApiKey: (id: string) =>
      request<null>(`/auth/api-keys/${id}`, { method: "DELETE" }),
  },

  backup: {
    list: () => request<BackupInfo[]>("/backup"),
    create: () => request<BackupInfo>("/backup", { method: "POST" }),
    delete: (id: string) =>
      request<null>(`/backup/${encodeURIComponent(id)}`, { method: "DELETE" }),
    getConfig: () => request<BackupConfig>("/backup/config"),
    updateConfig: (body: UpdateBackupConfigRequest) =>
      request<BackupConfig>("/backup/config", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    downloadUrl: (id: string) => `${BASE}/backup/download/${encodeURIComponent(id)}`,
    restore: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${BASE}/backup/restore`, {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (res.status === 401) {
        const { useAuthStore } = await import("../stores/auth-store");
        useAuthStore.getState().setAuthenticated(false);
        throw new Error("Session expired");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Restore failed" }));
        throw new Error((body as { error?: string }).error ?? "Restore failed");
      }
      return res.json();
    },
  },

  pc: {
    connections: () => request<import("@chvor/shared").PcAgentInfo[]>("/pc/connections"),
    config: () => request<{ enabled: boolean; safetyLevel: import("@chvor/shared").PcSafetyLevel; localAvailable: boolean }>("/pc/config"),
    setConfig: (updates: { enabled?: boolean; safetyLevel?: import("@chvor/shared").PcSafetyLevel }) =>
      request<{ enabled: boolean; safetyLevel: import("@chvor/shared").PcSafetyLevel; localAvailable: boolean }>("/pc/config", {
        method: "PUT",
        body: JSON.stringify(updates),
      }),
    disconnect: (id: string) =>
      request<null>(`/pc/connections/${id}`, { method: "DELETE" }),
  },

  oauth: {
    providers: () =>
      request<{
        providers: (OAuthProviderDef & { connected: boolean; hasSetupCredentials: boolean })[];
        connections: OAuthConnection[];
        hasComposioKey: boolean;
      }>("/oauth/providers"),
    initiate: (provider: string) =>
      request<{ redirectUrl: string; connectionId: string; method: string }>("/oauth/initiate", {
        method: "POST",
        body: JSON.stringify({ provider }),
      }),
    connections: () => request<OAuthConnection[]>("/oauth/connections"),
    disconnect: (id: string) =>
      request<{ disconnected: boolean; method: string }>(`/oauth/connections/${id}`, {
        method: "DELETE",
      }),
    refresh: (credentialId: string) =>
      request<{ refreshed: boolean; expiresAt?: string }>(`/oauth/refresh/${credentialId}`, {
        method: "POST",
      }),
  },
};
