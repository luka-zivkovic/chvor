// Consolidated feature-store.
// Merges skill-store + tool-store + schedule-store + webhook-store +
// knowledge-store + registry-store + credential-store + whatsapp-store +
// memory-store + voice-store into a single Zustand store.
//
// PROPERTY/ACTION RENAMES (collision resolution):
//   • skill-store        loading/error            → skillsLoading / skillsError
//                        fetchSkills              → fetchSkills (kept)
//   • tool-store         loading/error            → toolsLoading / toolsError
//                        fetchTools               → fetchTools (kept)
//   • schedule-store     loading/error            → schedulesLoading / schedulesError
//                        fetchAll                 → fetchSchedules
//   • webhook-store      loading/error            → webhooksLoading / webhooksError
//                        fetchAll                 → fetchWebhooks
//   • knowledge-store    loading/error            → knowledgeLoading / knowledgeError
//                        fetchAll                 → fetchKnowledge
//   • registry-store     loading/error            → registryLoading / registryError
//   • credential-store   loading/error            → credentialsLoading / credentialsError
//                        fetchAll                 → fetchCredentials
//   • memory-store       loading/error            → memoriesLoading / memoriesError
//                        fetchAll                 → fetchMemories
//   • voice-store        fetchConfig              → fetchVoiceConfig
//
// All other property/action names are preserved verbatim from their source store.

import { create } from "zustand";
import type {
  Skill,
  Tool,
  Schedule,
  ScheduleRun,
  WebhookSubscription,
  WebhookEvent,
  KnowledgeResource,
  RegistryEntry,
  RegistryEntryKind,
  CredentialSummary,
  AnyProviderDef,
  LLMProviderDef,
  EmbeddingProviderDef,
  IntegrationProviderDef,
  OAuthProviderDef,
  OAuthConnection,
  Memory,
  MemoryGraphNode,
  MemoryEdge,
  MemoryStats,
} from "@chvor/shared";
import { api } from "../lib/api";
import { invalidateSttStatus } from "../components/chat/MicButton";

// ── Re-exported helper types (originally exported by sub-stores) ───────────
export type SkillWithEnabled = Skill & { enabled: boolean; hasOverride: boolean };
export type ToolWithEnabled = Tool & { enabled: boolean };
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

// ── Voice-store types (originally exported from voice-store) ───────────────
export type TtsMode = "off" | "always" | "inbound";

export interface VoiceProviderInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
  needsCredential?: string | null;
  modelStatus?: string;
}

export interface VoiceStatus {
  stt: { provider: string; alternatives: VoiceProviderInfo[] };
  tts: { provider: string | null; order: string[]; providers: VoiceProviderInfo[] };
}

export interface VoiceModelInfo {
  id: string;
  name: string;
  type: "stt" | "tts";
  description: string;
  sizeEstimate: string;
  status: string;
  progress: { status: string; percent: number; error?: string };
  meta?: {
    language?: string;
    locale?: string;
    gender?: "male" | "female";
    quality?: "low" | "medium" | "high";
  };
}

// ── Module-scoped state (preserved verbatim from source stores) ────────────

// knowledge-store: poll bookkeeping
const knowledgePollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const knowledgePollGenerations = new Map<string, number>();

function cancelKnowledgePoll(id: string) {
  const timer = knowledgePollTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    knowledgePollTimers.delete(id);
  }
  knowledgePollGenerations.set(id, (knowledgePollGenerations.get(id) ?? 0) + 1);
}

// voice-store: active polling intervals per model
const voiceActivePolls = new Map<string, ReturnType<typeof setInterval>>();

type WhatsAppStatus = "disconnected" | "connecting" | "connected";

interface FeatureState {
  // ── skill-store ────────────────────────────────────────────
  skills: SkillWithEnabled[];
  skillsLoading: boolean;
  skillsError: string | null;
  fetchSkills: () => Promise<void>;

  // ── tool-store ─────────────────────────────────────────────
  tools: ToolWithEnabled[];
  toolsLoading: boolean;
  toolsError: string | null;
  fetchTools: () => Promise<void>;

  // ── schedule-store ─────────────────────────────────────────
  schedules: Schedule[];
  schedulesLoading: boolean;
  schedulesError: string | null;
  selectedScheduleId: string | null;
  runs: ScheduleRun[];
  runsLoading: boolean;
  fetchSchedules: () => Promise<void>;
  addSchedule: (s: Schedule) => void;
  removeSchedule: (id: string) => void;
  updateSchedule: (id: string, updates: Partial<Schedule>) => void;
  selectSchedule: (id: string | null) => void;
  fetchRuns: (scheduleId: string) => Promise<void>;

  // ── webhook-store ──────────────────────────────────────────
  webhooks: WebhookSubscription[];
  webhooksLoading: boolean;
  webhooksError: string | null;
  selectedWebhookId: string | null;
  events: WebhookEvent[];
  eventsLoading: boolean;
  eventsError: string | null;
  fetchWebhooks: () => Promise<void>;
  addWebhook: (w: WebhookSubscription) => void;
  removeWebhook: (id: string) => void;
  updateWebhook: (id: string, updates: Partial<WebhookSubscription>) => void;
  selectWebhook: (id: string | null) => void;
  fetchEvents: (webhookId: string) => Promise<void>;

  // ── knowledge-store ────────────────────────────────────────
  resources: KnowledgeResource[];
  knowledgeLoading: boolean;
  uploading: boolean;
  knowledgeError: string | null;
  fetchKnowledge: () => Promise<void>;
  uploadFile: (file: File, title?: string) => Promise<void>;
  ingestUrl: (url: string, title?: string) => Promise<void>;
  deleteResource: (id: string) => Promise<void>;
  reprocess: (id: string) => Promise<void>;
  pollResource: (id: string) => Promise<void>;

  // ── registry-store ─────────────────────────────────────────
  entries: RegistryEntryWithStatus[];
  registryLoading: boolean;
  registryError: string | null;
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

  // ── credential-store ───────────────────────────────────────
  credentials: CredentialSummary[];
  providers: AnyProviderDef[];
  llmProviders: LLMProviderDef[];
  embeddingProviders: EmbeddingProviderDef[];
  integrationProviders: IntegrationProviderDef[];
  oauthProviders: (OAuthProviderDef & { connected: boolean; hasSetupCredentials: boolean })[];
  oauthConnections: OAuthConnection[];
  hasComposioKey: boolean;
  credentialsLoading: boolean;
  credentialsError: string | null;
  fetchCredentials: () => Promise<void>;
  fetchOAuthState: () => Promise<void>;
  addCredential: (cred: CredentialSummary) => void;
  removeCredential: (id: string) => void;
  updateCredential: (id: string, updates: Partial<CredentialSummary>) => void;

  // ── whatsapp-store ─────────────────────────────────────────
  status: WhatsAppStatus;
  phoneNumber: string | undefined;
  qrDataUrl: string | null;
  setQR: (qrDataUrl: string) => void;
  setStatus: (status: WhatsAppStatus, phoneNumber?: string) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  fetchStatus: () => Promise<void>;

  // ── memory-store ───────────────────────────────────────────
  memories: Memory[];
  memoriesLoading: boolean;
  memoriesError: string | null;
  graphNodes: MemoryGraphNode[];
  graphEdges: MemoryEdge[];
  stats: MemoryStats | null;
  graphLoading: boolean;
  statsLoading: boolean;
  fetchMemories: () => Promise<void>;
  addMemory: (content: string) => Promise<void>;
  removeMemory: (id: string) => Promise<void>;
  updateMemory: (id: string, content: string) => Promise<void>;
  clearAll: () => Promise<void>;
  fetchGraph: () => Promise<void>;
  fetchStats: () => Promise<void>;

  // ── voice-store ────────────────────────────────────────────
  ttsMode: TtsMode;
  sttProvider: string;
  ttsProvider: string | null;
  ttsSpeed: number;
  piperVoice: string | null;
  recording: boolean;
  talkModeActive: boolean;
  talkPhase: "idle" | "listening" | "sending" | "thinking" | "speaking";
  voiceStatus: VoiceStatus | null;
  models: VoiceModelInfo[];
  setTtsMode: (mode: TtsMode) => void;
  setRecording: (recording: boolean) => void;
  setTalkModeActive: (active: boolean) => void;
  setTalkPhase: (phase: FeatureState["talkPhase"]) => void;
  audioUrls: Record<string, string>;
  setAudioUrl: (messageId: string, url: string) => void;
  lastPlayedAudioId: string | null;
  setLastPlayedAudioId: (id: string | null) => void;
  fetchVoiceConfig: () => Promise<void>;
  fetchVoiceStatus: () => Promise<void>;
  fetchModels: () => Promise<void>;
  updateSTTProvider: (provider: string) => Promise<void>;
  updateTTSProvider: (provider: string) => Promise<void>;
  updateTTSMode: (mode: TtsMode) => Promise<void>;
  updateTTSSpeed: (speed: number) => Promise<void>;
  updatePiperVoice: (modelId: string) => Promise<void>;
  startModelDownload: (modelId: string) => Promise<void>;
}

export const useFeatureStore = create<FeatureState>((set, get) => ({
  // ── skill-store ────────────────────────────────────────────
  skills: [],
  skillsLoading: false,
  skillsError: null,

  fetchSkills: async () => {
    set({ skillsLoading: true, skillsError: null });
    try {
      const skills = await api.skills.list();
      set({ skills, skillsLoading: false });
    } catch (err) {
      set({
        skillsError: err instanceof Error ? err.message : String(err),
        skillsLoading: false,
      });
    }
  },

  // ── tool-store ─────────────────────────────────────────────
  tools: [],
  toolsLoading: false,
  toolsError: null,

  fetchTools: async () => {
    set({ toolsLoading: true, toolsError: null });
    try {
      const tools = await api.tools.list();
      set({ tools, toolsLoading: false });
    } catch (err) {
      set({
        toolsError: err instanceof Error ? err.message : String(err),
        toolsLoading: false,
      });
    }
  },

  // ── schedule-store ─────────────────────────────────────────
  schedules: [],
  schedulesLoading: false,
  schedulesError: null,
  selectedScheduleId: null,
  runs: [],
  runsLoading: false,

  fetchSchedules: async () => {
    set({ schedulesLoading: true, schedulesError: null });
    try {
      const schedules = await api.schedules.list();
      set({ schedules, schedulesLoading: false });
    } catch (err) {
      set({
        schedulesError: err instanceof Error ? err.message : String(err),
        schedulesLoading: false,
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
      console.error("[feature-store] failed to fetch schedule runs:", err);
      set({ runsLoading: false });
    }
  },

  // ── webhook-store ──────────────────────────────────────────
  webhooks: [],
  webhooksLoading: false,
  webhooksError: null,
  selectedWebhookId: null,
  events: [],
  eventsLoading: false,
  eventsError: null,

  fetchWebhooks: async () => {
    set({ webhooksLoading: true, webhooksError: null });
    try {
      const webhooks = await api.webhooks.list();
      set({ webhooks, webhooksLoading: false });
    } catch (err) {
      set({
        webhooksError: err instanceof Error ? err.message : String(err),
        webhooksLoading: false,
      });
    }
  },

  addWebhook: (w) =>
    set((st) => ({ webhooks: [w, ...st.webhooks] })),

  removeWebhook: (id) =>
    set((st) => ({ webhooks: st.webhooks.filter((w) => w.id !== id) })),

  updateWebhook: (id, updates) =>
    set((st) => ({
      webhooks: st.webhooks.map((w) =>
        w.id === id ? { ...w, ...updates } : w
      ),
    })),

  selectWebhook: (id) => {
    set({ selectedWebhookId: id, events: [], eventsLoading: !!id, eventsError: null });
    if (id) get().fetchEvents(id);
  },

  fetchEvents: async (webhookId) => {
    set({ eventsLoading: true, eventsError: null });
    try {
      const events = await api.webhooks.events(webhookId);
      set({ events, eventsLoading: false });
    } catch (err) {
      set({
        eventsLoading: false,
        eventsError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  // ── knowledge-store ────────────────────────────────────────
  resources: [],
  knowledgeLoading: false,
  uploading: false,
  knowledgeError: null,

  fetchKnowledge: async () => {
    set({ knowledgeLoading: true, knowledgeError: null });
    try {
      const resources = await api.knowledge.list();
      set({ resources, knowledgeLoading: false });
    } catch (err) {
      set({ knowledgeError: err instanceof Error ? err.message : String(err), knowledgeLoading: false });
    }
  },

  uploadFile: async (file, title) => {
    set({ uploading: true, knowledgeError: null });
    try {
      const resource = await api.knowledge.upload(file, title);
      set((s) => ({ resources: [resource, ...s.resources], uploading: false }));
      get().pollResource(resource.id);
    } catch (err) {
      set({ knowledgeError: err instanceof Error ? err.message : String(err), uploading: false });
    }
  },

  ingestUrl: async (url, title) => {
    set({ uploading: true, knowledgeError: null });
    try {
      const resource = await api.knowledge.ingestUrl(url, title);
      set((s) => ({ resources: [resource, ...s.resources], uploading: false }));
      get().pollResource(resource.id);
    } catch (err) {
      set({ knowledgeError: err instanceof Error ? err.message : String(err), uploading: false });
    }
  },

  deleteResource: async (id) => {
    cancelKnowledgePoll(id);
    try {
      await api.knowledge.delete(id);
      set((s) => ({ resources: s.resources.filter((r) => r.id !== id) }));
      knowledgePollGenerations.delete(id);
    } catch (err) {
      set({ knowledgeError: err instanceof Error ? err.message : String(err) });
    }
  },

  reprocess: async (id) => {
    cancelKnowledgePoll(id);
    try {
      await api.knowledge.reprocess(id);
      set((s) => ({
        resources: s.resources.map((r) =>
          r.id === id ? { ...r, status: "processing" as const, memoryCount: 0 } : r,
        ),
      }));
      get().pollResource(id);
    } catch (err) {
      set({ knowledgeError: err instanceof Error ? err.message : String(err) });
    }
  },

  pollResource: async (id) => {
    cancelKnowledgePoll(id);

    const gen = knowledgePollGenerations.get(id) ?? 0;
    const MAX_POLLS = 60;
    let remaining = MAX_POLLS;
    const poll = async () => {
      knowledgePollTimers.delete(id);
      if (knowledgePollGenerations.get(id) !== gen) return;
      try {
        const updated = await api.knowledge.get(id);
        if (knowledgePollGenerations.get(id) !== gen) return;
        set((s) => ({
          resources: s.resources.map((r) => (r.id === id ? updated : r)),
        }));
        remaining--;
        if ((updated.status === "pending" || updated.status === "processing") && remaining > 0) {
          const timer = setTimeout(poll, 2000);
          knowledgePollTimers.set(id, timer);
        }
      } catch {
        knowledgePollTimers.delete(id);
      }
    };
    const timer = setTimeout(poll, 1500);
    knowledgePollTimers.set(id, timer);
  },

  // ── registry-store ─────────────────────────────────────────
  entries: [],
  registryLoading: false,
  registryError: null,
  searchQuery: "",
  categoryFilter: null,
  kindFilter: null,
  availableUpdates: [],

  search: async (query?: string, category?: string, kind?: RegistryEntryKind | null) => {
    const q = query ?? get().searchQuery;
    const cat = category ?? get().categoryFilter;
    const k = kind !== undefined ? kind : get().kindFilter;
    set({ registryLoading: true, registryError: null, searchQuery: q, categoryFilter: cat, kindFilter: k });
    try {
      const entries = await api.registry.search({
        q: q || undefined,
        category: cat || undefined,
        kind: k || undefined,
      });
      set({ entries, registryLoading: false });
    } catch (err) {
      set({
        registryError: err instanceof Error ? err.message : String(err),
        registryLoading: false,
      });
    }
  },

  install: async (id: string, kind?: RegistryEntryKind) => {
    try {
      await api.registry.install(id, kind);
      await get().search();
    } catch (err) {
      set({ registryError: err instanceof Error ? err.message : String(err) });
    }
  },

  uninstall: async (id: string) => {
    try {
      await api.registry.uninstall(id);
      await get().search();
    } catch (err) {
      set({ registryError: err instanceof Error ? err.message : String(err) });
    }
  },

  checkUpdates: async () => {
    try {
      const updates = await api.registry.checkUpdates();
      set({ availableUpdates: updates });
    } catch (err) {
      console.warn("[feature-store] update check failed:", err);
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
      set({ registryError: err instanceof Error ? err.message : String(err) });
    }
  },

  applyAllUpdates: async () => {
    try {
      await api.registry.updateAll();
      set({ availableUpdates: [] });
      await get().search();
    } catch (err) {
      set({ registryError: err instanceof Error ? err.message : String(err) });
    }
  },

  refresh: async () => {
    try {
      await api.registry.refresh();
      await get().search();
    } catch (err) {
      set({ registryError: err instanceof Error ? err.message : String(err) });
    }
  },

  setKindFilter: (kind: RegistryEntryKind | null) => {
    set({ kindFilter: kind });
    get().search(undefined, undefined, kind);
  },

  // ── credential-store ───────────────────────────────────────
  credentials: [],
  providers: [],
  llmProviders: [],
  embeddingProviders: [],
  integrationProviders: [],
  oauthProviders: [],
  oauthConnections: [],
  hasComposioKey: false,
  credentialsLoading: false,
  credentialsError: null,

  fetchCredentials: async () => {
    set({ credentialsLoading: true, credentialsError: null });

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
      providers = [...llmProviders, ...integrationProviders];
    }

    const error =
      credResult.status === "rejected"
        ? String(credResult.reason)
        : provResult.status === "rejected"
          ? String(provResult.reason)
          : null;

    set({ credentials, providers, llmProviders, embeddingProviders, integrationProviders, credentialsLoading: false, credentialsError: error });
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

  // ── whatsapp-store ─────────────────────────────────────────
  status: "disconnected",
  phoneNumber: undefined,
  qrDataUrl: null,

  setQR: (qrDataUrl) => set({ qrDataUrl }),

  setStatus: (status, phoneNumber) =>
    set({
      status,
      phoneNumber,
      ...(status !== "connecting" ? { qrDataUrl: null } : {}),
    }),

  connect: async () => {
    set({ status: "connecting", qrDataUrl: null });
    await api.whatsapp.connect();
  },

  disconnect: async () => {
    await api.whatsapp.disconnect();
    set({ status: "disconnected", phoneNumber: undefined, qrDataUrl: null });
  },

  fetchStatus: async () => {
    try {
      const data = await api.whatsapp.status();
      set({ status: data.status, phoneNumber: data.phoneNumber });
    } catch {
      // Ignore — server might not be reachable
    }
  },

  // ── memory-store ───────────────────────────────────────────
  memories: [],
  memoriesLoading: false,
  memoriesError: null,
  graphNodes: [],
  graphEdges: [],
  stats: null,
  graphLoading: false,
  statsLoading: false,

  fetchMemories: async () => {
    set({ memoriesLoading: true, memoriesError: null });
    try {
      const memories = await api.memories.list();
      set({ memories, memoriesLoading: false });
    } catch (err) {
      set({
        memoriesError: err instanceof Error ? err.message : String(err),
        memoriesLoading: false,
      });
    }
  },

  addMemory: async (content) => {
    try {
      const memory = await api.memories.create(content);
      set((st) => ({ memories: [memory, ...st.memories] }));
    } catch (err) {
      set({ memoriesError: err instanceof Error ? err.message : String(err) });
    }
  },

  removeMemory: async (id) => {
    set((st) => ({ memories: st.memories.filter((m) => m.id !== id) }));
    try {
      await api.memories.delete(id);
    } catch (err) {
      set({ memoriesError: err instanceof Error ? err.message : String(err) });
      try {
        const memories = await api.memories.list();
        set({ memories });
      } catch { /* best effort revert */ }
    }
  },

  updateMemory: async (id, content) => {
    set((st) => ({
      memories: st.memories.map((m) =>
        m.id === id ? { ...m, abstract: content, content } : m
      ),
    }));
    try {
      await api.memories.update(id, { content });
    } catch (err) {
      set({ memoriesError: err instanceof Error ? err.message : String(err) });
      try {
        const memories = await api.memories.list();
        set({ memories });
      } catch { /* best effort revert */ }
    }
  },

  clearAll: async () => {
    try {
      await api.memories.deleteAll();
      set({ memories: [] });
    } catch (err) {
      set({ memoriesError: err instanceof Error ? err.message : String(err) });
    }
  },

  fetchGraph: async () => {
    set({ graphLoading: true, memoriesError: null });
    try {
      const data = await api.memories.graph();
      set({ graphNodes: data.nodes, graphEdges: data.edges, graphLoading: false });
    } catch (err) {
      set({ memoriesError: err instanceof Error ? err.message : String(err), graphLoading: false });
    }
  },

  fetchStats: async () => {
    set({ statsLoading: true, memoriesError: null });
    try {
      const stats = await api.memories.stats();
      set({ stats, statsLoading: false });
    } catch (err) {
      set({ memoriesError: err instanceof Error ? err.message : String(err), statsLoading: false });
    }
  },

  // ── voice-store ────────────────────────────────────────────
  ttsMode: "inbound",
  sttProvider: "whisper-api",
  ttsProvider: null,
  ttsSpeed: 1.0,
  piperVoice: null,
  recording: false,
  talkModeActive: false,
  talkPhase: "idle",

  voiceStatus: null,
  models: [],

  setTtsMode: (mode) => set({ ttsMode: mode }),
  setRecording: (recording) => set({ recording }),
  setTalkModeActive: (active) =>
    set({ talkModeActive: active, talkPhase: active ? "listening" : "idle" }),
  setTalkPhase: (phase) => set({ talkPhase: phase }),

  audioUrls: {},
  setAudioUrl: (messageId, url) =>
    set((s) => {
      const entries = Object.entries(s.audioUrls);
      const MAX_CACHED_AUDIO = 20;
      const updated = { ...s.audioUrls, [messageId]: url };
      if (entries.length >= MAX_CACHED_AUDIO) {
        const toRemove = entries.slice(0, entries.length - MAX_CACHED_AUDIO + 1);
        for (const [key, oldUrl] of toRemove) {
          if (oldUrl.startsWith("blob:")) URL.revokeObjectURL(oldUrl);
          delete updated[key];
        }
      }
      return { audioUrls: updated };
    }),
  lastPlayedAudioId: null,
  setLastPlayedAudioId: (id) => set({ lastPlayedAudioId: id }),

  fetchVoiceConfig: async () => {
    try {
      const res = await fetch("/api/voice/config", { credentials: "same-origin" });
      if (!res.ok) return;
      const json = await res.json();
      set({
        ttsMode: json.data.ttsMode ?? "inbound",
        sttProvider: json.data.sttProvider ?? "whisper-api",
        ttsProvider: json.data.ttsProvider ?? null,
        ttsSpeed: json.data.ttsSpeed ?? 1.0,
        piperVoice: json.data.piperVoice ?? null,
      });
    } catch (err) {
      console.error("[voice] fetch config failed:", err);
    }
  },

  fetchVoiceStatus: async () => {
    try {
      const res = await fetch("/api/voice/status", { credentials: "same-origin" });
      if (!res.ok) return;
      const json = await res.json();
      set({ voiceStatus: json });
    } catch (err) {
      console.error("[voice] fetch status failed:", err);
    }
  },

  fetchModels: async () => {
    try {
      const res = await fetch("/api/voice/models", { credentials: "same-origin" });
      if (!res.ok) return;
      const json = await res.json();
      set({ models: json.models ?? [] });
    } catch (err) {
      console.error("[voice] fetch models failed:", err);
    }
  },

  updateSTTProvider: async (provider) => {
    const prev = get().sttProvider;
    set({ sttProvider: provider });
    try {
      const res = await fetch("/api/voice/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ sttProvider: provider }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      set({ sttProvider: prev });
      console.error("[voice] update STT provider failed:", err);
    }
  },

  updateTTSProvider: async (provider) => {
    const prev = get().ttsProvider;
    set({ ttsProvider: provider });
    try {
      const res = await fetch("/api/voice/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ttsProvider: provider }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      set({ ttsProvider: prev });
      console.error("[voice] update TTS provider failed:", err);
    }
  },

  updateTTSMode: async (mode) => {
    const prev = get().ttsMode;
    set({ ttsMode: mode });
    try {
      const res = await fetch("/api/voice/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ttsMode: mode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      set({ ttsMode: prev });
      console.error("[voice] update TTS mode failed:", err);
    }
  },

  updateTTSSpeed: async (speed) => {
    const prev = get().ttsSpeed;
    set({ ttsSpeed: speed });
    try {
      const res = await fetch("/api/voice/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ttsSpeed: speed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      set({ ttsSpeed: prev });
      console.error("[voice] update TTS speed failed:", err);
    }
  },

  updatePiperVoice: async (modelId) => {
    const prev = get().piperVoice;
    set({ piperVoice: modelId });
    try {
      const res = await fetch("/api/voice/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ piperVoice: modelId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      set({ piperVoice: prev });
      console.error("[voice] update Piper voice failed:", err);
    }
  },

  startModelDownload: async (modelId) => {
    if (voiceActivePolls.has(modelId)) return;

    try {
      await fetch(`/api/voice/models/${modelId}/download`, {
        method: "POST",
        credentials: "same-origin",
      });

      const stopPolling = () => {
        const interval = voiceActivePolls.get(modelId);
        if (interval) { clearInterval(interval); voiceActivePolls.delete(modelId); }
      };

      const poll = setInterval(async () => {
        try {
          const res = await fetch(`/api/voice/models/${modelId}/status`, {
            credentials: "same-origin",
          });
          if (!res.ok) { stopPolling(); return; }
          const progress = await res.json();
          set((s) => ({
            models: s.models.map((m) =>
              m.id === modelId ? { ...m, status: progress.status, progress } : m
            ),
          }));
          if (progress.status === "ready" || progress.status === "error") {
            stopPolling();
            get().fetchVoiceStatus();
          }
        } catch {
          stopPolling();
        }
      }, 2000);
      voiceActivePolls.set(modelId, poll);
    } catch (err) {
      console.error("[voice] start download failed:", err);
      set((s) => ({
        models: s.models.map((m) =>
          m.id === modelId ? { ...m, status: "error", progress: { status: "error", percent: 0, error: "Failed to start download" } } : m
        ),
      }));
    }
  },
}));
