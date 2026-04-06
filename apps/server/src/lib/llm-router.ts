import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";
import type { ModelRole, MediaModelType } from "@chvor/shared";
import { listCredentials, getCredentialData } from "../db/credential-store.ts";
import { getRoleConfig, getLLMPreference, getRoleFallbacks, getMediaModelConfig } from "../db/config-store.ts";
import {
  DEFAULT_LIGHTWEIGHT,
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  MODEL_MAX_TOKENS,
  DEFAULT_MAX_TOKENS,
  LLM_PROVIDERS,
  IMAGE_GEN_PROVIDERS,
} from "./provider-registry.ts";
import { assertLocalUrl, assertSafeUrl } from "./url-safety.ts";
import { getDynamicContextWindow, getDynamicMaxTokens } from "./dynamic-model-meta.ts";

// ── Public types ─────────────────────────────────────────────────

export interface LLMConfig {
  providerId: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export type ResolvedConfig = LLMConfig;

// ── Context window lookup ────────────────────────────────────────

export function getContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? getDynamicContextWindow(model) ?? DEFAULT_CONTEXT_WINDOW;
}

export function getMaxTokens(model: string): number {
  return MODEL_MAX_TOKENS[model] ?? getDynamicMaxTokens(model) ?? DEFAULT_MAX_TOKENS;
}

// ── Model creation ──────────────────────────────────────────────

export function createModel(config: LLMConfig): LanguageModelV1 {
  if (!config.model?.trim()) {
    throw new Error(`No model selected for provider "${config.providerId}". Please select a model in Brain → Models.`);
  }
  switch (config.providerId) {
    case "anthropic": {
      const provider = createAnthropic({ apiKey: config.apiKey });
      return provider(config.model);
    }
    case "openai": {
      const provider = createOpenAI({ apiKey: config.apiKey });
      return provider(config.model);
    }
    case "deepseek": {
      // Use OpenAI-compatible endpoint (DeepSeek API is OpenAI-compatible)
      // Avoids @ai-sdk/deepseek which returns LanguageModelV2 incompatible with ai@4
      const provider = createOpenAI({
        apiKey: config.apiKey,
        baseURL: "https://api.deepseek.com",
      });
      return provider(config.model);
    }
    case "minimax": {
      // MiniMax exposes an Anthropic-compatible endpoint
      const provider = createAnthropic({
        apiKey: config.apiKey,
        baseURL: "https://api.minimax.io/anthropic/v1",
      });
      return provider(config.model);
    }
    case "openrouter": {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        baseURL: "https://openrouter.ai/api/v1",
      });
      return provider(config.model);
    }
    case "google": {
      const provider = createGoogleGenerativeAI({ apiKey: config.apiKey });
      return provider(config.model);
    }
    case "groq": {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        baseURL: "https://api.groq.com/openai/v1",
      });
      return provider(config.model);
    }
    case "mistral": {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        baseURL: "https://api.mistral.ai/v1",
      });
      return provider(config.model);
    }
    case "ollama": {
      const base = config.baseUrl || "http://localhost:11434/v1";
      assertLocalUrl(base, "Ollama");
      const provider = createOpenAI({
        apiKey: config.apiKey || "ollama",
        baseURL: base,
      });
      return provider(config.model);
    }
    case "lmstudio": {
      const base = config.baseUrl || "http://localhost:1234/v1";
      assertLocalUrl(base, "LM Studio");
      const provider = createOpenAI({
        apiKey: config.apiKey || "lmstudio",
        baseURL: base,
      });
      return provider(config.model);
    }
    case "vllm": {
      const base = config.baseUrl || "http://localhost:8000/v1";
      assertLocalUrl(base, "vLLM");
      const provider = createOpenAI({
        apiKey: config.apiKey || "vllm",
        baseURL: base,
      });
      return provider(config.model);
    }
    case "ollama-cloud": {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        baseURL: "https://ollama.com/v1",
      });
      return provider(config.model);
    }
    case "custom-llm": {
      if (!config.baseUrl) throw new Error("Custom LLM requires a baseUrl");
      assertSafeUrl(config.baseUrl, "Custom LLM baseUrl");
      const provider = createOpenAI({
        apiKey: config.apiKey || "none",
        baseURL: config.baseUrl,
      });
      return provider(config.model);
    }
    default:
      throw new Error(`Unknown LLM provider: ${config.providerId}`);
  }
}

// ── Credential resolution ────────────────────────────────────────

export function resolveCredential(providerId: string): { apiKey: string; baseUrl?: string } {
  const providerDef = LLM_PROVIDERS.find((p) => p.id === providerId)
    ?? IMAGE_GEN_PROVIDERS.find((p) => p.id === providerId);
  if (!providerDef) throw new Error(`Unknown provider: ${providerId}`);

  const creds = listCredentials();
  const match = creds.find(
    (c) => c.type === providerDef.credentialType && c.testStatus !== "failed"
  );
  if (!match) throw new Error(`No credential for provider: ${providerId}`);

  const full = getCredentialData(match.id);
  if (!full) throw new Error(`Failed to decrypt credential for: ${providerId}`);
  return {
    apiKey: full.data.apiKey || ("isLocal" in providerDef && providerDef.isLocal ? providerDef.id : ""),
    baseUrl: full.data.baseUrl,
  };
}

// ── Role-based config resolution ─────────────────────────────────

// Derived from the central provider registry — keeps auto-detect in sync
const PROVIDER_MAP: Record<string, { credType: string; defaultModel: string }> = Object.fromEntries(
  LLM_PROVIDERS.map((p) => [
    p.id,
    { credType: p.credentialType, defaultModel: p.models[0]?.id ?? "" },
  ])
);

/**
 * Resolve which LLM provider + model + apiKey to use for a given role.
 *
 * Default chain:
 *   Primary → required (env vars → stored preference → auto-detect)
 *   Reasoning → explicit config or fall back to primary
 *   Lightweight → explicit config or provider's cheap model or primary
 *   Heartbeat → explicit config or lightweight fallback
 */
export function resolveRoleConfig(role: ModelRole): ResolvedConfig {
  // Try explicit role config first (skip for primary — handled below)
  if (role !== "primary") {
    const explicit = getRoleConfig(role);
    if (explicit) {
      try {
        const cred = resolveCredential(explicit.providerId);
        return { ...explicit, apiKey: cred.apiKey, baseUrl: cred.baseUrl };
      } catch {
        // Credential missing for this role — fall through to defaults
      }
    }
  }

  // Default chain for non-primary roles
  if (role === "reasoning") {
    return resolveRoleConfig("primary");
  }

  if (role === "lightweight") {
    const primary = resolveRoleConfig("primary");
    const cheapModel = DEFAULT_LIGHTWEIGHT[primary.providerId];
    if (cheapModel) {
      return { ...primary, model: cheapModel };
    }
    return primary;
  }

  if (role === "heartbeat") {
    return resolveRoleConfig("lightweight");
  }

  // Primary resolution
  return resolvePrimaryConfig();
}

/**
 * Resolve primary config: env vars → stored role → legacy preference → auto-detect.
 */
function resolvePrimaryConfig(): ResolvedConfig {
  // 1. Env var override
  const envProvider = process.env.CHVOR_PROVIDER ?? "";
  const envModel = process.env.CHVOR_MODEL ?? "";
  if (envProvider && PROVIDER_MAP[envProvider]) {
    const cred = resolveCredential(envProvider);
    return {
      providerId: envProvider,
      model: envModel || PROVIDER_MAP[envProvider].defaultModel,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
    };
  }

  // 2. Stored role config
  const roleConfig = getRoleConfig("primary");
  if (roleConfig) {
    try {
      const cred = resolveCredential(roleConfig.providerId);
      return { ...roleConfig, apiKey: cred.apiKey, baseUrl: cred.baseUrl };
    } catch { /* fall through */ }
  }

  // 3. Legacy preference
  const pref = getLLMPreference();
  if (pref && PROVIDER_MAP[pref.providerId]) {
    try {
      const cred = resolveCredential(pref.providerId);
      return { ...pref, apiKey: cred.apiKey, baseUrl: cred.baseUrl };
    } catch { /* fall through */ }
  }

  // 4. Auto-detect: first available LLM credential
  const creds = listCredentials();
  for (const [pid, { credType, defaultModel }] of Object.entries(PROVIDER_MAP)) {
    const match = creds.find((c) => c.type === credType);
    if (match) {
      const full = getCredentialData(match.id);
      if (full) {
        const isLocal = LLM_PROVIDERS.find(p => p.id === pid)?.isLocal;
        return { providerId: pid, model: defaultModel, apiKey: full.data.apiKey || (isLocal ? pid : ""), baseUrl: full.data.baseUrl };
      }
    }
  }

  throw new Error("No LLM credentials configured. Add one in Settings.");
}

/**
 * Create a model instance for a specific role.
 */
export function createModelForRole(role: ModelRole) {
  const config = resolveRoleConfig(role);
  return createModel(config);
}

// ── Fallback chain resolution ────────────────────────────────────

/**
 * Resolve the full fallback chain for a role: primary config + configured fallbacks.
 * Entries with missing credentials are silently skipped.
 */
export function resolveRoleChain(role: ModelRole): ResolvedConfig[] {
  const primary = resolveRoleConfig(role);
  const fallbackEntries = getRoleFallbacks(role);
  const chain: ResolvedConfig[] = [primary];

  for (const fb of fallbackEntries) {
    try {
      const cred = resolveCredential(fb.providerId);
      chain.push({
        providerId: fb.providerId,
        model: fb.model,
        apiKey: cred.apiKey,
        baseUrl: cred.baseUrl,
      });
    } catch {
      // Skip fallbacks with missing/invalid credentials
    }
  }
  return chain;
}

// ── Error classification for fallback ────────────────────────────

function extractHttpStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
    // Vercel AI SDK wraps errors with a data/responseBody property
    if (e.data && typeof e.data === "object") {
      const d = e.data as Record<string, unknown>;
      if (typeof d.status === "number") return d.status;
    }
  }
  return null;
}

/**
 * Determine if an error is transient and should trigger a fallback attempt.
 * Returns false for auth/config errors (401, 403, 400) which won't be fixed by switching models.
 */
export function isFallbackEligible(error: unknown): boolean {
  const status = extractHttpStatus(error);
  if (status !== null) {
    // Transient/capacity errors → fallback
    if ([408, 429, 500, 502, 503, 504, 529].includes(status)) return true;
    // Auth/config errors → don't fallback
    if ([400, 401, 403, 404].includes(status)) return false;
  }

  const msg = error instanceof Error ? error.message : String(error);
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND/i.test(msg)) return true;
  if (/overloaded|capacity|rate.limit|too many requests/i.test(msg)) return true;
  if (/fetch failed|network/i.test(msg)) return true;

  // Default: don't fallback on unknown errors
  return false;
}

// ── Media model resolution ───────────────────────────────────────

/**
 * Sensible defaults when no explicit media model config exists.
 * - image-understanding: falls back to primary (most models support vision)
 * - video-understanding: falls back to primary (Gemini, Claude, GPT-4o handle video)
 * - image-generation: defaults to openai/gpt-image-1
 */
const MEDIA_DEFAULTS: Record<MediaModelType, { providerId: string; model: string } | null> = {
  "image-understanding": null, // → primary model
  "video-understanding": null, // → primary model
  "image-generation": { providerId: "openai", model: "gpt-image-1" },
};

/**
 * Resolve which LLM config to use for a given media model type.
 * Checks explicit media model config, falls back to sensible defaults.
 * For understanding tasks, ultimately falls back to the primary model.
 */
export function resolveMediaConfig(type: MediaModelType): ResolvedConfig {
  // 1. Explicit media model config
  const explicit = getMediaModelConfig(type);
  if (explicit) {
    try {
      const cred = resolveCredential(explicit.providerId);
      return { ...explicit, apiKey: cred.apiKey, baseUrl: cred.baseUrl };
    } catch {
      // Credential missing — fall through
    }
  }

  // 2. Built-in default for this type
  const def = MEDIA_DEFAULTS[type];
  if (def) {
    try {
      const cred = resolveCredential(def.providerId);
      return { ...def, apiKey: cred.apiKey, baseUrl: cred.baseUrl };
    } catch {
      // Default provider not available — fall through to primary
    }
  }

  // 3. Fall back to primary model
  return resolveRoleConfig("primary");
}

// ── Backward compatibility ───────────────────────────────────────

/** @deprecated Use resolveRoleConfig("primary") instead */
export function resolveConfig(): ResolvedConfig {
  return resolveRoleConfig("primary");
}

export type ModelTier = "primary" | "lightweight";

/** @deprecated Use createModelForRole() instead */
export function createModelForTier(
  config: { providerId: string; model: string; apiKey: string },
  tier: ModelTier
) {
  if (tier === "primary") return createModel(config);
  const lightweightModel = DEFAULT_LIGHTWEIGHT[config.providerId];
  if (!lightweightModel) {
    console.warn(`[llm] no lightweight model for provider '${config.providerId}', using primary`);
    return createModel(config);
  }
  return createModel({ ...config, model: lightweightModel });
}
