import type {
  PersonaConfig,
  UpdatePersonaRequest,
  PulseConfig,
  UpdatePulseRequest,
  RetentionConfig,
  UpdateRetentionRequest,
  BrainConfig,
  UpdateBrainConfigRequest,
  CommunicationStyle,
  ExampleResponse,
  ModelRole,
  ModelRoleConfig,
  ModelRolesConfig,
  RoleFallbackEntry,
  EmbeddingConfig,
  ShellConfig,
  ShellApprovalMode,
  UpdateShellConfigRequest,
  FilesystemConfig,
  UpdateFilesystemConfigRequest,
  TrustedCommandsConfig,
  ChannelPolicy,
  UpdateChannelPolicyRequest,
  ChannelType,
  SessionLifecycleConfig,
  UpdateSessionLifecycleRequest,
  SessionResetPolicy,
  ChatType,
  MediaModelType,
  MediaModelConfig,
  MediaPipelineConfig,
  MediaTypeConfig,
} from "@chvor/shared";
import { getDb } from "./database.ts";
import os from "node:os";

const DEFAULTS: Record<string, string> = {
  "persona.profile":
    "You are a helpful, direct assistant. You prefer concise answers and ask clarifying questions when a request is ambiguous.",
  "persona.directives": "",
  "persona.onboarded": "false",
  "persona.tone": "",
  "persona.boundaries": "",
  "persona.communicationStyle": "",
  "persona.exampleResponses": "[]",
};

export function getConfig(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setConfig(key: string, value: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, now);
}

function parseExampleResponses(raw: string | null): ExampleResponse[] | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length > 0 ? arr : undefined;
  } catch {
    return undefined;
  }
}

// --- Persona config ---

export function getPersona(): PersonaConfig {
  return {
    profile: getConfig("persona.profile") ?? DEFAULTS["persona.profile"],
    directives:
      getConfig("persona.directives") ?? DEFAULTS["persona.directives"],
    onboarded: (getConfig("persona.onboarded") ?? "false") === "true",
    name: getConfig("persona.name") || undefined,
    timezone: getConfig("persona.timezone") || undefined,
    language: getConfig("persona.language") || undefined,
    aiName: getConfig("persona.aiName") || undefined,
    userNickname: getConfig("persona.userNickname") || undefined,
    tone: getConfig("persona.tone") || undefined,
    boundaries: getConfig("persona.boundaries") || undefined,
    communicationStyle: (getConfig("persona.communicationStyle") as CommunicationStyle) || undefined,
    exampleResponses: parseExampleResponses(getConfig("persona.exampleResponses")),
    emotionsEnabled: (getConfig("persona.emotionsEnabled") ?? "false") === "true",
    advancedEmotionsEnabled: (getConfig("persona.advancedEmotionsEnabled") ?? "false") === "true",
    personalityPresetId: getConfig("persona.personalityPresetId") || undefined,
  };
}

export function updatePersona(updates: UpdatePersonaRequest): PersonaConfig {
  if (updates.profile !== undefined) {
    setConfig("persona.profile", updates.profile);
  }
  if (updates.directives !== undefined) {
    setConfig("persona.directives", updates.directives);
  }
  if (updates.onboarded !== undefined) {
    setConfig("persona.onboarded", String(updates.onboarded));
  }
  if (updates.name !== undefined) {
    setConfig("persona.name", updates.name);
  }
  if (updates.timezone !== undefined) {
    setConfig("persona.timezone", updates.timezone);
  }
  if (updates.language !== undefined) {
    setConfig("persona.language", updates.language);
  }
  if (updates.aiName !== undefined) {
    setConfig("persona.aiName", updates.aiName);
  }
  if (updates.userNickname !== undefined) {
    setConfig("persona.userNickname", updates.userNickname);
  }
  if (updates.tone !== undefined) {
    setConfig("persona.tone", updates.tone);
  }
  if (updates.boundaries !== undefined) {
    setConfig("persona.boundaries", updates.boundaries);
  }
  if (updates.communicationStyle !== undefined) {
    setConfig("persona.communicationStyle", updates.communicationStyle);
  }
  if (updates.exampleResponses !== undefined) {
    setConfig("persona.exampleResponses", JSON.stringify(updates.exampleResponses));
  }
  if (updates.emotionsEnabled !== undefined) {
    setConfig("persona.emotionsEnabled", String(updates.emotionsEnabled));
  }
  if (updates.advancedEmotionsEnabled !== undefined) {
    setConfig("persona.advancedEmotionsEnabled", String(updates.advancedEmotionsEnabled));
  }
  if (updates.personalityPresetId !== undefined) {
    setConfig("persona.personalityPresetId", updates.personalityPresetId);
  }
  return getPersona();
}

// --- LLM preference ---

export interface LLMPreference {
  providerId: string;
  model: string;
}

export function getLLMPreference(): LLMPreference | null {
  const providerId = getConfig("llm.providerId");
  const model = getConfig("llm.model");
  if (!providerId || !model) return null;
  return { providerId, model };
}

export function setLLMPreference(providerId: string, model: string): LLMPreference {
  setConfig("llm.providerId", providerId);
  setConfig("llm.model", model);
  return { providerId, model };
}

// --- Model role config ---

export function getRoleConfig(role: ModelRole): ModelRoleConfig | null {
  const providerId = getConfig(`llm.role.${role}.providerId`);
  const model = getConfig(`llm.role.${role}.model`);

  // Migration: if primary has no role config but legacy keys exist, use those
  if (!providerId && role === "primary") {
    const legacy = getLLMPreference();
    if (legacy) {
      // Persist migration
      setRoleConfig("primary", legacy.providerId, legacy.model);
      return legacy;
    }
  }

  if (!providerId || !model) return null;
  return { providerId, model };
}

export function setRoleConfig(role: ModelRole, providerId: string, model: string): ModelRoleConfig {
  setConfig(`llm.role.${role}.providerId`, providerId);
  setConfig(`llm.role.${role}.model`, model);
  // Keep legacy keys in sync for primary
  if (role === "primary") {
    setLLMPreference(providerId, model);
  }
  return { providerId, model };
}

export function clearRoleConfig(role: ModelRole): void {
  const db = getDb();
  db.prepare("DELETE FROM config WHERE key = ?").run(`llm.role.${role}.providerId`);
  db.prepare("DELETE FROM config WHERE key = ?").run(`llm.role.${role}.model`);
}

export function getAllRoleConfigs(): ModelRolesConfig {
  return {
    primary: getRoleConfig("primary"),
    reasoning: getRoleConfig("reasoning"),
    lightweight: getRoleConfig("lightweight"),
    heartbeat: getRoleConfig("heartbeat"),
  };
}

// --- Model fallback chains ---

export function getRoleFallbacks(role: ModelRole): RoleFallbackEntry[] {
  const raw = getConfig(`llm.role.${role}.fallbacks`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export function setRoleFallbacks(role: ModelRole, fallbacks: RoleFallbackEntry[]): void {
  setConfig(`llm.role.${role}.fallbacks`, JSON.stringify(fallbacks));
}

export function getAllRoleFallbacks(): Record<string, RoleFallbackEntry[]> {
  const roles: ModelRole[] = ["primary", "reasoning", "lightweight", "heartbeat"];
  const result: Record<string, RoleFallbackEntry[]> = {};
  for (const role of roles) {
    result[role] = getRoleFallbacks(role);
  }
  return result;
}

// --- Embedding preference ---

export function getEmbeddingPreference(): EmbeddingConfig {
  return {
    providerId: getConfig("embedding.providerId") ?? "local",
    model: getConfig("embedding.model") ?? "Xenova/all-MiniLM-L6-v2",
    dimensions: (() => { const v = parseInt(getConfig("embedding.dimensions") ?? "384", 10); return Number.isNaN(v) ? 384 : v; })(),
  };
}

export function setEmbeddingPreference(pref: EmbeddingConfig): EmbeddingConfig {
  setConfig("embedding.providerId", pref.providerId);
  setConfig("embedding.model", pref.model);
  setConfig("embedding.dimensions", String(pref.dimensions));
  return pref;
}

// --- Capability enabled/disabled ---

// Bundled skills that ship disabled by default (user must opt-in)
const DEFAULT_DISABLED = new Set(["brainstorming", "code-review", "writing-helper", "claude-code", "a2ui"]);

export function isCapabilityEnabled(kind: "skill" | "tool", id: string): boolean {
  const val = getConfig(`${kind}.enabled.${id}`);
  if (val === undefined || val === null) {
    return !DEFAULT_DISABLED.has(id);
  }
  return val !== "false";
}

export function setCapabilityEnabled(kind: "skill" | "tool", id: string, enabled: boolean): boolean {
  setConfig(`${kind}.enabled.${id}`, String(enabled));
  return enabled;
}

// --- Extended Thinking ---

export interface ExtendedThinkingConfig {
  enabled: boolean;
  budgetTokens: number;
}

export function getExtendedThinking(): ExtendedThinkingConfig {
  return {
    enabled: (getConfig("thinking.enabled") ?? "false") === "true",
    budgetTokens: Math.max(1000, Math.min(100000,
      parseInt(getConfig("thinking.budgetTokens") ?? "10000", 10)
    )),
  };
}

export function setExtendedThinking(enabled: boolean, budgetTokens?: number): ExtendedThinkingConfig {
  setConfig("thinking.enabled", String(enabled));
  if (budgetTokens !== undefined) {
    const clamped = Math.max(1000, Math.min(100000, budgetTokens));
    setConfig("thinking.budgetTokens", String(clamped));
  }
  return getExtendedThinking();
}

// --- Pulse config ---

export function getPulseConfig(): PulseConfig {
  return {
    enabled: (getConfig("pulse.enabled") ?? "false") === "true",
    intervalMinutes: parseInt(getConfig("pulse.intervalMinutes") ?? "30", 10),
    lastRunAt: getConfig("pulse.lastRunAt") || null,
    lastResult: getConfig("pulse.lastResult") || null,
    lastError: getConfig("pulse.lastError") || null,
  };
}

export function updatePulseConfig(updates: UpdatePulseRequest): PulseConfig {
  if (updates.enabled !== undefined) {
    setConfig("pulse.enabled", String(updates.enabled));
  }
  if (updates.intervalMinutes !== undefined) {
    setConfig("pulse.intervalMinutes", String(updates.intervalMinutes));
  }
  return getPulseConfig();
}

export function recordPulseRun(
  result: string | null,
  error: string | null
): void {
  setConfig("pulse.lastRunAt", new Date().toISOString());
  setConfig("pulse.lastResult", result ? result.slice(0, 2000) : "");
  setConfig("pulse.lastError", error ?? "");
}

// --- Retention config ---

export function getRetentionConfig(): RetentionConfig {
  return {
    sessionMaxAgeDays: parseInt(getConfig("retention.sessionMaxAgeDays") ?? "30", 10),
    archiveBeforeDelete: (getConfig("retention.archiveBeforeDelete") ?? "true") === "true",
  };
}

export function updateRetentionConfig(updates: UpdateRetentionRequest): RetentionConfig {
  if (updates.sessionMaxAgeDays !== undefined) {
    const days = Math.max(0, Math.floor(updates.sessionMaxAgeDays));
    setConfig("retention.sessionMaxAgeDays", String(days));
  }
  if (updates.archiveBeforeDelete !== undefined) {
    setConfig("retention.archiveBeforeDelete", String(updates.archiveBeforeDelete));
  }
  return getRetentionConfig();
}

// --- Brain config ---

export function getBrainConfig(): BrainConfig {
  return {
    maxToolRounds: parseInt(getConfig("brain.maxToolRounds") ?? "30", 10) || 30,
    memoryBatchSize: parseInt(getConfig("brain.memoryBatchSize") ?? "3", 10) || 3,
    lowTokenMode: (getConfig("brain.lowTokenMode") ?? "false") === "true",
  };
}

// --- Self-Healing config ---

export function getSelfHealingEnabled(): boolean {
  return (getConfig("selfHealing.enabled") ?? "true") === "true";
}

export function setSelfHealingEnabled(enabled: boolean): boolean {
  setConfig("selfHealing.enabled", String(enabled));
  return enabled;
}

// --- PC Control config ---

export function getPcControlEnabled(): boolean {
  return (getConfig("pcControl.enabled") ?? "true") === "true";
}

export function setPcControlEnabled(enabled: boolean): boolean {
  setConfig("pcControl.enabled", String(enabled));
  return enabled;
}

export function updateBrainConfig(updates: UpdateBrainConfigRequest): BrainConfig {
  if (updates.maxToolRounds !== undefined) {
    const clamped = Math.max(1, Math.min(100, Math.floor(updates.maxToolRounds)));
    setConfig("brain.maxToolRounds", String(clamped));
  }
  if (updates.memoryBatchSize !== undefined) {
    const clamped = Math.max(1, Math.min(20, Math.floor(updates.memoryBatchSize)));
    setConfig("brain.memoryBatchSize", String(clamped));
  }
  if (updates.lowTokenMode !== undefined) {
    setConfig("brain.lowTokenMode", String(updates.lowTokenMode));
  }
  return getBrainConfig();
}

// --- Cognitive Memory config ---

export interface CognitiveMemoryConfig {
  decayEnabled: boolean;
  consolidationEnabled: boolean;
  preloadingEnabled: boolean;
  strengthThreshold: number;
  maxRetrievalCount: number;
}

export function getCognitiveMemoryConfig(): CognitiveMemoryConfig {
  return {
    decayEnabled: (getConfig("memory.decayEnabled") ?? "true") === "true",
    consolidationEnabled: (getConfig("memory.consolidationEnabled") ?? "true") === "true",
    preloadingEnabled: (getConfig("memory.preloadingEnabled") ?? "true") === "true",
    strengthThreshold: (() => { const v = parseFloat(getConfig("memory.strengthThreshold") ?? ""); return Number.isNaN(v) ? 0.05 : v; })(),
    maxRetrievalCount: (() => { const v = parseInt(getConfig("memory.maxRetrievalCount") ?? "", 10); return Number.isNaN(v) ? 20 : v; })(),
  };
}

export function updateCognitiveMemoryConfig(updates: Partial<CognitiveMemoryConfig>): CognitiveMemoryConfig {
  if (updates.decayEnabled !== undefined) setConfig("memory.decayEnabled", String(updates.decayEnabled));
  if (updates.consolidationEnabled !== undefined) setConfig("memory.consolidationEnabled", String(updates.consolidationEnabled));
  if (updates.preloadingEnabled !== undefined) setConfig("memory.preloadingEnabled", String(updates.preloadingEnabled));
  if (updates.strengthThreshold !== undefined) {
    setConfig("memory.strengthThreshold", String(Math.max(0, Math.min(1, updates.strengthThreshold))));
  }
  if (updates.maxRetrievalCount !== undefined) {
    setConfig("memory.maxRetrievalCount", String(Math.max(1, Math.min(50, Math.floor(updates.maxRetrievalCount)))));
  }
  return getCognitiveMemoryConfig();
}

// --- Shell config ---

const VALID_APPROVAL_MODES: ShellApprovalMode[] = ["always_approve", "moderate_plus", "dangerous_only", "block_all"];

export function getShellConfig(): ShellConfig {
  const mode = getConfig("shell.approvalMode") as ShellApprovalMode | null;
  return {
    approvalMode: mode && VALID_APPROVAL_MODES.includes(mode) ? mode : "moderate_plus",
  };
}

export function updateShellConfig(updates: UpdateShellConfigRequest): ShellConfig {
  if (updates.approvalMode !== undefined && VALID_APPROVAL_MODES.includes(updates.approvalMode)) {
    setConfig("shell.approvalMode", updates.approvalMode);
  }
  return getShellConfig();
}

// --- Channel policy (access control) ---

const DEFAULT_CHANNEL_POLICY: ChannelPolicy = {
  dm: { mode: "open", allowlist: [] },
  group: { mode: "open", allowlist: [] },
  groupSenderFilter: { enabled: false, allowlist: [] },
};

export function getChannelPolicy(channelType: ChannelType): ChannelPolicy {
  const raw = getConfig(`channel.${channelType}.policy`);
  if (!raw) return structuredClone(DEFAULT_CHANNEL_POLICY);
  try {
    const parsed = JSON.parse(raw);
    return {
      dm: { ...DEFAULT_CHANNEL_POLICY.dm, ...parsed.dm },
      group: { ...DEFAULT_CHANNEL_POLICY.group, ...parsed.group },
      groupSenderFilter: { ...DEFAULT_CHANNEL_POLICY.groupSenderFilter, ...parsed.groupSenderFilter },
    };
  } catch {
    return structuredClone(DEFAULT_CHANNEL_POLICY);
  }
}

export function updateChannelPolicy(
  channelType: ChannelType,
  updates: UpdateChannelPolicyRequest
): ChannelPolicy {
  const current = getChannelPolicy(channelType);
  if (updates.dm) {
    if (updates.dm.mode !== undefined) current.dm.mode = updates.dm.mode;
    if (updates.dm.allowlist !== undefined) current.dm.allowlist = updates.dm.allowlist;
  }
  if (updates.group) {
    if (updates.group.mode !== undefined) current.group.mode = updates.group.mode;
    if (updates.group.allowlist !== undefined) current.group.allowlist = updates.group.allowlist;
  }
  if (updates.groupSenderFilter) {
    if (updates.groupSenderFilter.enabled !== undefined)
      current.groupSenderFilter.enabled = updates.groupSenderFilter.enabled;
    if (updates.groupSenderFilter.allowlist !== undefined)
      current.groupSenderFilter.allowlist = updates.groupSenderFilter.allowlist;
  }
  setConfig(`channel.${channelType}.policy`, JSON.stringify(current));
  return current;
}

// --- Session lifecycle config ---

const DEFAULT_RESET_POLICY: SessionResetPolicy = {
  idleTimeoutMinutes: 0,
  dailyResetHour: null,
  maxMessages: 0,
};

const DEFAULT_LIFECYCLE_CONFIG: SessionLifecycleConfig = {
  defaultPolicy: { ...DEFAULT_RESET_POLICY },
  chatTypePolicies: {},
  resetTriggers: ["/new", "/reset"],
};

export function getSessionLifecycleConfig(): SessionLifecycleConfig {
  const raw = getConfig("session.lifecycle");
  if (!raw) return structuredClone(DEFAULT_LIFECYCLE_CONFIG);
  try {
    const parsed = JSON.parse(raw);
    return {
      defaultPolicy: { ...DEFAULT_RESET_POLICY, ...parsed.defaultPolicy },
      chatTypePolicies: parsed.chatTypePolicies ?? {},
      resetTriggers: Array.isArray(parsed.resetTriggers) ? parsed.resetTriggers : DEFAULT_LIFECYCLE_CONFIG.resetTriggers,
    };
  } catch {
    return structuredClone(DEFAULT_LIFECYCLE_CONFIG);
  }
}

export function updateSessionLifecycleConfig(
  updates: UpdateSessionLifecycleRequest
): SessionLifecycleConfig {
  const current = getSessionLifecycleConfig();

  if (updates.defaultPolicy) {
    if (updates.defaultPolicy.idleTimeoutMinutes !== undefined) {
      current.defaultPolicy.idleTimeoutMinutes = Math.max(0, Math.floor(updates.defaultPolicy.idleTimeoutMinutes));
    }
    if (updates.defaultPolicy.dailyResetHour !== undefined) {
      const h = updates.defaultPolicy.dailyResetHour;
      current.defaultPolicy.dailyResetHour = h === null ? null : Math.max(0, Math.min(23, Math.floor(h)));
    }
    if (updates.defaultPolicy.maxMessages !== undefined) {
      current.defaultPolicy.maxMessages = Math.max(0, Math.floor(updates.defaultPolicy.maxMessages));
    }
  }

  if (updates.chatTypePolicies) {
    const validTypes: ChatType[] = ["dm", "group", "thread"];
    for (const ct of validTypes) {
      const patch = updates.chatTypePolicies[ct];
      if (!patch) continue;
      const existing = current.chatTypePolicies[ct] ?? { ...DEFAULT_RESET_POLICY };
      if (patch.idleTimeoutMinutes !== undefined) {
        existing.idleTimeoutMinutes = Math.max(0, Math.floor(patch.idleTimeoutMinutes));
      }
      if (patch.dailyResetHour !== undefined) {
        const h = patch.dailyResetHour;
        existing.dailyResetHour = h === null ? null : Math.max(0, Math.min(23, Math.floor(h)));
      }
      if (patch.maxMessages !== undefined) {
        existing.maxMessages = Math.max(0, Math.floor(patch.maxMessages));
      }
      current.chatTypePolicies[ct] = existing;
    }
  }

  if (updates.resetTriggers !== undefined) {
    current.resetTriggers = updates.resetTriggers.filter((t) => typeof t === "string" && t.trim().length > 0);
  }

  setConfig("session.lifecycle", JSON.stringify(current));
  return current;
}

/** Resolve the effective reset policy for a given chat type */
export function resolveResetPolicy(chatType?: "dm" | "group" | "thread"): SessionResetPolicy {
  const config = getSessionLifecycleConfig();
  if (chatType && config.chatTypePolicies[chatType]) {
    return config.chatTypePolicies[chatType]!;
  }
  return config.defaultPolicy;
}

// --- Media pipeline config ---

const DEFAULT_MEDIA_PIPELINE: MediaPipelineConfig = {
  image: { enabled: true, maxSizeBytes: 10 * 1024 * 1024 },  // 10 MB
  video: { enabled: true, maxSizeBytes: 20 * 1024 * 1024 },  // 20 MB
  audio: { enabled: true, maxSizeBytes: 10 * 1024 * 1024 },  // 10 MB
};

export function getMediaPipelineConfig(): MediaPipelineConfig {
  const raw = getConfig("media.pipeline");
  if (!raw) return structuredClone(DEFAULT_MEDIA_PIPELINE);
  try {
    const parsed = JSON.parse(raw);
    return {
      image: { ...DEFAULT_MEDIA_PIPELINE.image, ...parsed.image },
      video: { ...DEFAULT_MEDIA_PIPELINE.video, ...parsed.video },
      audio: { ...DEFAULT_MEDIA_PIPELINE.audio, ...parsed.audio },
    };
  } catch {
    return structuredClone(DEFAULT_MEDIA_PIPELINE);
  }
}

export function setMediaPipelineConfig(updates: Partial<MediaPipelineConfig>): MediaPipelineConfig {
  const current = getMediaPipelineConfig();
  if (updates.image) Object.assign(current.image, updates.image);
  if (updates.video) Object.assign(current.video, updates.video);
  if (updates.audio) Object.assign(current.audio, updates.audio);
  setConfig("media.pipeline", JSON.stringify(current));
  return current;
}

// --- Media model config (per media-type model routing) ---

export function getMediaModelConfig(type: MediaModelType): MediaModelConfig | null {
  const providerId = getConfig(`media.model.${type}.providerId`);
  const model = getConfig(`media.model.${type}.model`);
  if (!providerId || !model) return null;
  return { providerId, model };
}

export function setMediaModelConfig(type: MediaModelType, config: MediaModelConfig): MediaModelConfig {
  setConfig(`media.model.${type}.providerId`, config.providerId);
  setConfig(`media.model.${type}.model`, config.model);
  return config;
}

export function clearMediaModelConfig(type: MediaModelType): void {
  const db = getDb();
  db.prepare("DELETE FROM config WHERE key = ?").run(`media.model.${type}.providerId`);
  db.prepare("DELETE FROM config WHERE key = ?").run(`media.model.${type}.model`);
}

export function getAllMediaModelConfigs(): Record<MediaModelType, MediaModelConfig | null> {
  return {
    "image-understanding": getMediaModelConfig("image-understanding"),
    "video-understanding": getMediaModelConfig("video-understanding"),
    "image-generation": getMediaModelConfig("image-generation"),
  };
}

// ── Security: Localhost access ──────────────────────────────────────

/** Whether the AI is allowed to fetch localhost / private network URLs. Default: false (blocked). */
export function getAllowLocalhost(): boolean {
  return (getConfig("security.allowLocalhost") ?? "false") === "true";
}

export function setAllowLocalhost(allow: boolean): boolean {
  setConfig("security.allowLocalhost", String(allow));
  return allow;
}

// ── Filesystem access config ──────────────────────────────────────

export function getFilesystemConfig(): FilesystemConfig {
  const parseEnabled = getConfig("filesystem.enabled");
  const parseReadOnly = getConfig("filesystem.readOnly");
  const rawPaths = getConfig("filesystem.allowedPaths");

  let allowedPaths: string[];
  if (!rawPaths) {
    allowedPaths = [os.homedir()];
  } else {
    try {
      const arr = JSON.parse(rawPaths);
      allowedPaths = Array.isArray(arr) ? arr : [os.homedir()];
    } catch {
      allowedPaths = [os.homedir()];
    }
  }

  return {
    enabled: (parseEnabled ?? "true") === "true",
    readOnly: (parseReadOnly ?? "false") === "true",
    allowedPaths,
  };
}

export function updateFilesystemConfig(updates: UpdateFilesystemConfigRequest): FilesystemConfig {
  if (updates.enabled !== undefined) setConfig("filesystem.enabled", String(updates.enabled));
  if (updates.readOnly !== undefined) setConfig("filesystem.readOnly", String(updates.readOnly));
  if (updates.allowedPaths !== undefined) setConfig("filesystem.allowedPaths", JSON.stringify(updates.allowedPaths));
  return getFilesystemConfig();
}

// ── Trusted commands (Always Allow) ──────────────────────────────

function parseTrustedArray(key: string): string[] {
  const raw = getConfig(key);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function getTrustedCommands(): TrustedCommandsConfig {
  return {
    shell: parseTrustedArray("trusted.shell"),
    pc: parseTrustedArray("trusted.pc"),
  };
}

const MAX_TRUSTED_PATTERNS = 100;

export function addTrustedCommand(kind: "shell" | "pc", pattern: string): TrustedCommandsConfig {
  const current = getTrustedCommands();
  const arr = kind === "shell" ? current.shell : current.pc;
  if (arr.includes(pattern)) return current;
  if (arr.length >= MAX_TRUSTED_PATTERNS) {
    throw new Error(`Too many trusted ${kind} patterns (max ${MAX_TRUSTED_PATTERNS})`);
  }
  arr.push(pattern);
  setConfig(`trusted.${kind}`, JSON.stringify(arr));
  return getTrustedCommands();
}

export function removeTrustedCommand(kind: "shell" | "pc", pattern: string): TrustedCommandsConfig {
  const current = getTrustedCommands();
  const arr = kind === "shell" ? current.shell : current.pc;
  const filtered = arr.filter((p) => p !== pattern);
  setConfig(`trusted.${kind}`, JSON.stringify(filtered));
  return getTrustedCommands();
}

/** Check if a command matches a trusted pattern. */
export function isTrustedCommand(command: string, isPc: boolean): boolean {
  const trusted = getTrustedCommands();
  if (isPc) {
    const cleaned = command.replace(/^PC (Task|shell):\s*/i, "");
    const firstWord = cleaned.split(/\s+/)[0]?.toLowerCase() ?? "";
    return trusted.pc.some((p) => p.toLowerCase() === firstWord);
  }
  // Shell: match "binary subcommand" pattern (first 2 tokens, case-insensitive)
  const parts = command.trim().split(/\s+/);
  for (let len = Math.min(parts.length, 2); len >= 1; len--) {
    const candidate = parts.slice(0, len).join(" ").toLowerCase();
    if (trusted.shell.includes(candidate)) return true;
  }
  return false;
}

// ── Media retention ──────────────────────────────────────────────

/** Get media retention period in days. 0 = keep forever. Default: 7. */
export function getMediaRetentionDays(): number {
  const raw = getConfig("media.retentionDays");
  if (raw == null) return 7;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 7 : Math.max(0, parsed);
}

/** Set media retention period in days. 0 = keep forever. */
export function setMediaRetentionDays(days: number): number {
  const clamped = Math.max(0, Math.floor(days));
  setConfig("media.retentionDays", String(clamped));
  return clamped;
}

// ── Instruction overrides ───────────────────────────────────────

/** Get a user-defined instruction override for a skill or tool. Returns null if no override exists. */
export function getInstructionOverride(kind: "skill" | "tool", id: string): string | null {
  return getConfig(`${kind}.instructions.override.${id}`);
}

/** Save a user-defined instruction override for a skill or tool. */
export function setInstructionOverride(kind: "skill" | "tool", id: string, instructions: string): void {
  setConfig(`${kind}.instructions.override.${id}`, instructions);
}

/** Clear a user-defined instruction override, restoring original instructions. */
export function clearInstructionOverride(kind: "skill" | "tool", id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM config WHERE key = ?").run(`${kind}.instructions.override.${id}`);
}

/** Get all instruction overrides (for template export). */
export function getAllInstructionOverrides(): Array<{ kind: "skill" | "tool"; id: string; instructions: string }> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT key, value FROM config WHERE key LIKE 'skill.instructions.override.%' OR key LIKE 'tool.instructions.override.%'"
  ).all() as { key: string; value: string }[];
  return rows.map((r) => {
    // key format: "{kind}.instructions.override.{id}"
    // Use fixed prefix lengths for robust parsing (skill.instructions.override. = 28, tool.instructions.override. = 27)
    const isSkill = r.key.startsWith("skill.");
    const kind = isSkill ? "skill" as const : "tool" as const;
    const prefixLen = isSkill ? "skill.instructions.override.".length : "tool.instructions.override.".length;
    const id = r.key.slice(prefixLen);
    return { kind, id, instructions: r.value };
  });
}
