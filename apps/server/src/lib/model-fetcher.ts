import type { ModelDef } from "@chvor/shared";
import { LLM_PROVIDERS } from "./provider-registry.ts";
import { resolveCredential } from "./llm-router.ts";
import { setDynamicContextWindow, setDynamicMaxTokens } from "./dynamic-model-meta.ts";

// ── In-memory cache ─────────────────────────────────────────────

interface CacheEntry {
  models: ModelDef[];
  fetchedAt: number;
}

const modelCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Dedup concurrent fetches for the same provider
const inFlightFetches = new Map<string, Promise<{ models: ModelDef[]; source: "api" | "static" }>>();

export function clearModelCache(providerId?: string): void {
  if (providerId) {
    modelCache.delete(providerId);
  } else {
    modelCache.clear();
  }
}

// ── Public API ──────────────────────────────────────────────────

export async function fetchModelsForProvider(
  providerId: string
): Promise<{ models: ModelDef[]; source: "api" | "static" }> {
  // Check cache first
  const cached = modelCache.get(providerId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { models: cached.models, source: "api" }; // served from local cache, originally fetched from API
  }

  // Dedup: if a fetch is already in flight for this provider, reuse it
  const existing = inFlightFetches.get(providerId);
  if (existing) return existing;

  const promise = _fetchModelsForProvider(providerId);
  inFlightFetches.set(providerId, promise);
  return promise.finally(() => inFlightFetches.delete(providerId));
}

async function _fetchModelsForProvider(
  providerId: string
): Promise<{ models: ModelDef[]; source: "api" | "static" }> {
  const providerDef = LLM_PROVIDERS.find((p) => p.id === providerId);
  if (!providerDef) {
    return { models: [], source: "static" };
  }

  // Build a static lookup for enrichment
  const staticModels = new Map(providerDef.models.map((m) => [m.id, m]));

  // Check if a dynamic fetcher exists before resolving credentials
  const fetcher = FETCHERS[providerId];
  if (!fetcher) {
    return { models: providerDef.models, source: "static" };
  }

  try {
    const cred = resolveCredential(providerId);
    const rawModels = await fetcher(cred);

    // Enrich fetched models with static metadata where available
    const enriched = rawModels.map((m) => {
      const staticM = staticModels.get(m.id);
      if (staticM) {
        return {
          ...m,
          contextWindow: m.contextWindow || staticM.contextWindow,
          maxTokens: m.maxTokens || staticM.maxTokens,
          cost: m.cost ?? staticM.cost,
          capabilities: m.capabilities?.length ? m.capabilities : staticM.capabilities,
        };
      }
      return m;
    });

    // Register dynamic models for context window / max token lookups
    for (const m of enriched) {
      if (m.contextWindow) {
        setDynamicContextWindow(m.id, m.contextWindow);
      }
      if (m.maxTokens) {
        setDynamicMaxTokens(m.id, m.maxTokens);
      }
    }

    // Cache the result
    modelCache.set(providerId, { models: enriched, fetchedAt: Date.now() });
    return { models: enriched, source: "api" };
  } catch (err) {
    console.warn(`[model-fetcher] Failed to fetch models for ${providerId}:`, err);
    // Fallback to static models
    return { models: providerDef.models, source: "static" };
  }
}

// ── Per-provider fetchers ───────────────────────────────────────

type Credential = { apiKey: string; baseUrl?: string };
type Fetcher = (cred: Credential) => Promise<ModelDef[]>;

async function fetchJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Anthropic ───────────────────────────────────────────────────

const fetchAnthropic: Fetcher = async (cred) => {
  const data = await fetchJson("https://api.anthropic.com/v1/models", {
    "x-api-key": cred.apiKey,
    "anthropic-version": "2023-06-01",
  });
  return (data.data ?? [])
    .filter((m: any) => m.type === "model")
    .map((m: any) => ({
      id: m.id,
      name: m.display_name ?? m.id,
      contextWindow: 0,
      supportsStreaming: true,
    }));
};

// ── OpenAI ──────────────────────────────────────────────────────

const OPENAI_CHAT_PREFIXES = ["gpt-", "o1-", "o3-", "o4-", "chatgpt-"];

const fetchOpenAI: Fetcher = async (cred) => {
  const data = await fetchJson("https://api.openai.com/v1/models", {
    Authorization: `Bearer ${cred.apiKey}`,
  });
  return (data.data ?? [])
    .filter((m: any) => OPENAI_CHAT_PREFIXES.some((p) => m.id.startsWith(p)))
    .map((m: any) => ({
      id: m.id,
      name: m.id,
      contextWindow: 0,
      supportsStreaming: true,
    }))
    .sort((a: ModelDef, b: ModelDef) => a.id.localeCompare(b.id));
};

// ── DeepSeek ────────────────────────────────────────────────────

const fetchDeepSeek: Fetcher = async (cred) => {
  const data = await fetchJson("https://api.deepseek.com/models", {
    Authorization: `Bearer ${cred.apiKey}`,
  });
  return (data.data ?? []).map((m: any) => ({
    id: m.id,
    name: m.id,
    contextWindow: 0,
    supportsStreaming: true,
  }));
};

// ── Google Gemini ───────────────────────────────────────────────

const fetchGoogle: Fetcher = async (cred) => {
  const data = await fetchJson(
    "https://generativelanguage.googleapis.com/v1/models",
    { "x-goog-api-key": cred.apiKey }
  );
  return (data.models ?? [])
    .filter((m: any) =>
      m.supportedGenerationMethods?.includes("generateContent")
    )
    .map((m: any) => {
      const id = (m.name ?? "").replace(/^models\//, "");
      return {
        id,
        name: m.displayName ?? id,
        contextWindow: m.inputTokenLimit ?? 0,
        supportsStreaming: true,
        maxTokens: m.outputTokenLimit,
      };
    });
};

// ── Groq ────────────────────────────────────────────────────────

const fetchGroq: Fetcher = async (cred) => {
  const data = await fetchJson("https://api.groq.com/openai/v1/models", {
    Authorization: `Bearer ${cred.apiKey}`,
  });
  return (data.data ?? [])
    .filter((m: any) => m.id && !m.id.includes("whisper") && !m.id.includes("tts"))
    .map((m: any) => ({
      id: m.id,
      name: m.id,
      contextWindow: m.context_window ?? 0,
      supportsStreaming: true,
    }));
};

// ── Mistral ─────────────────────────────────────────────────────

const fetchMistral: Fetcher = async (cred) => {
  const data = await fetchJson("https://api.mistral.ai/v1/models", {
    Authorization: `Bearer ${cred.apiKey}`,
  });
  return (data.data ?? [])
    .filter((m: any) => m.capabilities?.completion_chat)
    .map((m: any) => ({
      id: m.id,
      name: m.id,
      contextWindow: m.max_context_length ?? 0,
      supportsStreaming: true,
      maxTokens: m.max_context_length ? Math.min(m.max_context_length, 32768) : undefined,
    }));
};

// ── OpenRouter ──────────────────────────────────────────────────

const fetchOpenRouter: Fetcher = async (cred) => {
  const data = await fetchJson("https://openrouter.ai/api/v1/models", {
    Authorization: `Bearer ${cred.apiKey}`,
  });
  return (data.data ?? [])
    .map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextWindow: m.context_length ?? 0,
      supportsStreaming: true,
    }));
};

// ── Ollama (local) ──────────────────────────────────────────────

const fetchOllama: Fetcher = async (cred) => {
  const base = (cred.baseUrl ?? "http://localhost:11434/v1").replace(/\/v1\/?$/, "");
  const data = await fetchJson(`${base}/api/tags`, {});
  return (data.models ?? []).map((m: any) => ({
    id: m.name ?? m.model,
    name: m.name ?? m.model,
    contextWindow: 0,
    supportsStreaming: true,
  }));
};

// ── Ollama Cloud ────────────────────────────────────────────────

const fetchOllamaCloud: Fetcher = async (cred) => {
  const data = await fetchJson("https://ollama.com/api/tags", {
    Authorization: `Bearer ${cred.apiKey}`,
  });
  return (data.models ?? []).map((m: any) => ({
    id: m.name ?? m.model,
    name: m.name ?? m.model,
    contextWindow: 0,
    supportsStreaming: true,
  }));
};

// ── LM Studio ───────────────────────────────────────────────────

const fetchLMStudio: Fetcher = async (cred) => {
  const base = (cred.baseUrl ?? "http://localhost:1234/v1").replace(/\/$/, "");
  const data = await fetchJson(`${base}/models`, {});
  return (data.data ?? []).map((m: any) => ({
    id: m.id,
    name: m.id,
    contextWindow: 0,
    supportsStreaming: true,
  }));
};

// ── vLLM ────────────────────────────────────────────────────────

const fetchVLLM: Fetcher = async (cred) => {
  const base = (cred.baseUrl ?? "http://localhost:8000/v1").replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (cred.apiKey) headers["Authorization"] = `Bearer ${cred.apiKey}`;
  const data = await fetchJson(`${base}/models`, headers);
  return (data.data ?? []).map((m: any) => ({
    id: m.id,
    name: m.id,
    contextWindow: 0,
    supportsStreaming: true,
  }));
};

// ── Custom LLM (OpenAI-compatible) ──────────────────────────────

const fetchCustomLLM: Fetcher = async (cred) => {
  if (!cred.baseUrl) return [];
  const base = cred.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (cred.apiKey) headers["Authorization"] = `Bearer ${cred.apiKey}`;
  const data = await fetchJson(`${base}/models`, headers);
  return (data.data ?? []).map((m: any) => ({
    id: m.id,
    name: m.id,
    contextWindow: 0,
    supportsStreaming: true,
  }));
};

// ── Fetcher registry ────────────────────────────────────────────

const FETCHERS: Record<string, Fetcher> = {
  anthropic: fetchAnthropic,
  openai: fetchOpenAI,
  deepseek: fetchDeepSeek,
  google: fetchGoogle,
  groq: fetchGroq,
  mistral: fetchMistral,
  openrouter: fetchOpenRouter,
  ollama: fetchOllama,
  "ollama-cloud": fetchOllamaCloud,
  lmstudio: fetchLMStudio,
  vllm: fetchVLLM,
  "custom-llm": fetchCustomLLM,
  // minimax: no public models endpoint — uses static list
};
