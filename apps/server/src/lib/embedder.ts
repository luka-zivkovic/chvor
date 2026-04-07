import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { getEmbeddingPreference, getConfig, setConfig } from "../db/config-store.ts";
import { listCredentials, getCredentialData } from "../db/credential-store.ts";

const _require = createRequire(import.meta.url);

// Normalize to forward slashes — HuggingFace Transformers can choke on Windows backslashes
const MODEL_CACHE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../data/models",
).replace(/\\/g, "/");

/**
 * Custom cache replacing HF Transformers' built-in FileCache.
 * The built-in FileCache has a race condition: fileStream.close() isn't awaited
 * in put(), so match() can't find the file. This uses writeFileSync instead.
 * (Same fix applied in stt-whisper-local.ts.)
 */
function createModelCache(basePath: string) {
  return {
    async match(request: string): Promise<Response | undefined> {
      const filePath = join(basePath, request);
      if (existsSync(filePath) && statSync(filePath).size > 0) {
        return new Response(readFileSync(filePath));
      }
      return undefined;
    },
    async put(request: string, response: Response): Promise<void> {
      const filePath = join(basePath, request);
      mkdirSync(dirname(filePath), { recursive: true });
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(filePath, buffer);
    },
  };
}

// ── Local model download tracking ────────────────────────────────

export type LocalModelStatus = "not_downloaded" | "downloading" | "ready" | "error";

export interface LocalModelProgress {
  status: LocalModelStatus;
  percent: number;
  error?: string;
  onnxAvailable: boolean;
}

let localModelProgress: LocalModelProgress = {
  status: "not_downloaded",
  percent: 0,
  onnxAvailable: false,
};

function checkOnnxRuntime(): boolean {
  try {
    _require.resolve("onnxruntime-node");
    return true;
  } catch {
    return false;
  }
}

/** Check if HuggingFace Transformers has cached the model files. */
function isLocalModelCached(): boolean {
  // Custom cache layout: {cache_dir}/Xenova/all-MiniLM-L6-v2/onnx/model.onnx
  const modelPath = join(MODEL_CACHE_DIR, "Xenova/all-MiniLM-L6-v2/onnx/model.onnx");
  // Also check legacy HF cache layout
  const legacyPath = `${MODEL_CACHE_DIR}/models--Xenova--all-MiniLM-L6-v2/refs/main`;
  return existsSync(modelPath) || existsSync(legacyPath);
}

export function getLocalModelStatus(): LocalModelStatus {
  if (localModelProgress.status === "downloading") return "downloading";
  if (localModelProgress.status === "error") return "error";
  // If the provider is already loaded, it's ready
  if (currentProvider?.providerId === "local" && currentProvider.isAvailable()) return "ready";
  // Check disk cache
  return isLocalModelCached() ? "ready" : "not_downloaded";
}

export function getLocalModelProgress(): LocalModelProgress {
  const onnxAvailable = checkOnnxRuntime();
  const status = getLocalModelStatus();
  return { ...localModelProgress, status, onnxAvailable };
}

/**
 * Start downloading the local embedding model. Fire-and-forget — caller polls progress.
 * After successful download, initializes the embedder + triggers backfill.
 */
export async function startLocalModelDownload(): Promise<void> {
  if (localModelProgress.status === "downloading") return;
  if (getLocalModelStatus() === "ready") return;

  const onnxAvailable = checkOnnxRuntime();
  if (!onnxAvailable) {
    localModelProgress = {
      status: "error",
      percent: 0,
      error: "onnxruntime-node is not installed. Run: pnpm add onnxruntime-node",
      onnxAvailable: false,
    };
    console.error("[embedder:local] onnxruntime-node not found — cannot download model");
    return;
  }

  localModelProgress = { status: "downloading", percent: 0, onnxAvailable: true };

  // Simulate progress since HF Transformers doesn't expose download callbacks.
  // Asymptotic curve: fast start, decelerates toward 95% — never freezes.
  const progressStart = Date.now();
  const progressInterval = setInterval(() => {
    if (localModelProgress.status === "downloading") {
      const elapsed = (Date.now() - progressStart) / 1000;
      const percent = Math.min(95, Math.round(95 * (1 - Math.exp(-elapsed / 30))));
      localModelProgress = { ...localModelProgress, percent };
    }
  }, 2000);

  try {
    mkdirSync(MODEL_CACHE_DIR, { recursive: true });
    console.log(`[embedder:local] downloading model to: ${MODEL_CACHE_DIR}`);
    const { pipeline, env } = await import("@huggingface/transformers");

    // Disable the built-in FileCache (has a race condition where
    // fileStream.close() isn't awaited in put(), so match() can't find files).
    // Use our own synchronous-write cache instead.
    env.useFSCache = false;
    env.useCustomCache = true;
    env.customCache = createModelCache(MODEL_CACHE_DIR);
    env.allowRemoteModels = true;
    env.allowLocalModels = true;

    const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "fp32",
      local_files_only: false,
    });
    clearInterval(progressInterval);
    localModelProgress = { status: "ready", percent: 100, onnxAvailable: true };
    console.log("[embedder:local] model downloaded successfully");

    // Auto-initialize the embedder now that the model is available
    const localProvider = new LocalEmbeddingProvider();
    localProvider._setPipeline(pipe);
    currentProvider = localProvider;
    console.log("[embedder:local] embedder initialized after download");
  } catch (err) {
    clearInterval(progressInterval);
    const msg = err instanceof Error ? err.message : String(err);
    localModelProgress = { status: "error", percent: 0, error: msg, onnxAvailable: true };
    console.error("[embedder:local] download failed:", msg);
  }
}

// ── Provider interface ───────────────────────────────────────────

interface EmbeddingProvider {
  readonly dimensions: number;
  readonly providerId: string;
  init(): Promise<void>;
  embed(text: string): Promise<Float32Array>;
  isAvailable(): boolean;
}

// ── Local HuggingFace provider ───────────────────────────────────

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly providerId = "local";
  private pipeline: any = null;
  private failed = false;
  private initPromise: Promise<void> | null = null;

  /** Allow injecting an already-loaded pipeline (from download flow). */
  _setPipeline(pipe: any): void {
    this.pipeline = pipe;
    this.failed = false;
  }

  async init(): Promise<void> {
    if (this.pipeline || this.failed) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Only load if model is already cached — no auto-download
        if (!isLocalModelCached()) {
          console.log("[embedder:local] model not downloaded, skipping init");
          return;
        }
        const onnxAvailable = checkOnnxRuntime();
        if (!onnxAvailable) {
          this.failed = true;
          console.error("[embedder:local] onnxruntime-node not installed, cannot load model");
          return;
        }
        const start = Date.now();
        mkdirSync(MODEL_CACHE_DIR, { recursive: true });
        console.log(`[embedder:local] cache dir: ${MODEL_CACHE_DIR}`);
        const { pipeline, env } = await import("@huggingface/transformers");

        env.useFSCache = false;
        env.useCustomCache = true;
        env.customCache = createModelCache(MODEL_CACHE_DIR);
        env.allowLocalModels = true;

        this.pipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
          dtype: "fp32",
          local_files_only: true, // Only use cached files — download handled by startLocalModelDownload
        });
        localModelProgress = { status: "ready", percent: 100, onnxAvailable: true };
        console.log(`[embedder:local] model loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      } catch (err) {
        this.failed = true;
        console.error("[embedder:local] failed to load model:", err);
      }
    })();
    return this.initPromise;
  }

  async embed(text: string): Promise<Float32Array> {
    if (this.failed) throw new Error("Local embedder unavailable");
    if (!this.pipeline) await this.init();
    if (!this.pipeline) throw new Error("Local embedder unavailable");
    const output = await this.pipeline(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  }

  isAvailable(): boolean {
    return this.pipeline !== null && !this.failed;
  }
}

// ── OpenAI embedding provider ────────────────────────────────────

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "openai";
  dimensions: number;
  private apiKey: string;
  private model: string;
  private ready = false;

  constructor(model: string, dimensions: number, apiKey: string) {
    this.model = model;
    this.dimensions = dimensions;
    this.apiKey = apiKey;
  }

  async init(): Promise<void> {
    this.ready = true;
    console.log(`[embedder:openai] ready (model: ${this.model}, dims: ${this.dimensions})`);
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: text, model: this.model }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "unknown error");
      throw new Error(`OpenAI embedding failed: ${err}`);
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return new Float32Array(json.data[0].embedding);
  }

  isAvailable(): boolean {
    return this.ready;
  }
}

// ── Voyage AI embedding provider ─────────────────────────────────

class VoyageAIEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "voyageai";
  dimensions: number;
  private apiKey: string;
  private model: string;
  private ready = false;

  constructor(model: string, dimensions: number, apiKey: string) {
    this.model = model;
    this.dimensions = dimensions;
    this.apiKey = apiKey;
  }

  async init(): Promise<void> {
    this.ready = true;
    console.log(`[embedder:voyageai] ready (model: ${this.model}, dims: ${this.dimensions})`);
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: [text], model: this.model }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "unknown error");
      throw new Error(`VoyageAI embedding failed: ${err}`);
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return new Float32Array(json.data[0].embedding);
  }

  isAvailable(): boolean {
    return this.ready;
  }
}

// ── Cohere embedding provider ────────────────────────────────────

class CohereEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "cohere";
  dimensions: number;
  private apiKey: string;
  private model: string;
  private ready = false;

  constructor(model: string, dimensions: number, apiKey: string) {
    this.model = model;
    this.dimensions = dimensions;
    this.apiKey = apiKey;
  }

  async init(): Promise<void> {
    this.ready = true;
    console.log(`[embedder:cohere] ready (model: ${this.model}, dims: ${this.dimensions})`);
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch("https://api.cohere.com/v2/embed", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        texts: [text],
        model: this.model,
        input_type: "search_document",
        embedding_types: ["float"],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "unknown error");
      throw new Error(`Cohere embedding failed: ${err}`);
    }
    const json = (await res.json()) as { embeddings: { float: number[][] } };
    return new Float32Array(json.embeddings.float[0]);
  }

  isAvailable(): boolean {
    return this.ready;
  }
}

// ── Google embedding provider ───────────────────────────────────

class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "google";
  dimensions: number;
  private apiKey: string;
  private model: string;
  private ready = false;

  constructor(model: string, dimensions: number, apiKey: string) {
    this.model = model;
    this.dimensions = dimensions;
    this.apiKey = apiKey;
  }

  async init(): Promise<void> {
    this.ready = true;
    console.log(`[embedder:google] ready (model: ${this.model}, dims: ${this.dimensions})`);
  }

  async embed(text: string): Promise<Float32Array> {
    const url = `https://generativelanguage.googleapis.com/v1/models/${this.model}:embedContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "unknown error");
      throw new Error(`Google embedding failed: ${err}`);
    }
    const json = (await res.json()) as { embedding: { values: number[] } };
    return new Float32Array(json.embedding.values);
  }

  isAvailable(): boolean {
    return this.ready;
  }
}

// ── Facade (singleton) ───────────────────────────────────────────

let currentProvider: EmbeddingProvider | null = null;
let initPromise: Promise<void> | null = null;

function resolveEmbeddingApiKey(credentialType: string): string {
  const creds = listCredentials();
  const match = creds.find((c) => c.type === credentialType);
  if (!match) throw new Error(`No credential for embedding provider: ${credentialType}`);
  const full = getCredentialData(match.id);
  if (!full) throw new Error(`Failed to decrypt credential for: ${credentialType}`);
  return full.data.apiKey;
}

function createProvider(config: { providerId: string; model: string; dimensions: number }): EmbeddingProvider | null {
  switch (config.providerId) {
    case "none":
      return null;
    case "local":
      return new LocalEmbeddingProvider();
    case "openai": {
      const apiKey = resolveEmbeddingApiKey("openai");
      return new OpenAIEmbeddingProvider(config.model, config.dimensions, apiKey);
    }
    case "voyageai": {
      const apiKey = resolveEmbeddingApiKey("voyageai");
      return new VoyageAIEmbeddingProvider(config.model, config.dimensions, apiKey);
    }
    case "cohere": {
      const apiKey = resolveEmbeddingApiKey("cohere");
      return new CohereEmbeddingProvider(config.model, config.dimensions, apiKey);
    }
    case "google": {
      const apiKey = resolveEmbeddingApiKey("google-ai");
      return new GoogleEmbeddingProvider(config.model, config.dimensions, apiKey);
    }
    default:
      console.warn(`[embedder] unknown provider '${config.providerId}', falling back to local`);
      return new LocalEmbeddingProvider();
  }
}

export async function initEmbedder(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const config = getEmbeddingPreference();
    const provider = createProvider(config);
    if (!provider) {
      currentProvider = null;
      console.log("[embedder] embedding disabled (provider: none)");
      return;
    }
    try {
      await provider.init();
      currentProvider = provider; // Atomic swap — old provider stays available until new one is ready
    } catch (err) {
      console.error(`[embedder] failed to initialize ${config.providerId}:`, err);
      if (config.providerId !== "local") {
        console.warn("[embedder] falling back to local embedder");
        const fallback = new LocalEmbeddingProvider();
        await fallback.init();
        currentProvider = fallback;
      }
    }
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

/** Re-initialize with potentially different config (after provider switch). */
export async function reinitEmbedder(): Promise<void> {
  // Wait for any in-flight init to finish before starting a new one
  if (initPromise) await initPromise;

  // Null out current provider so concurrent embed() calls fail fast
  // instead of producing wrong-dimension vectors during the switch
  const oldProvider = currentProvider;
  currentProvider = null;
  initPromise = null;

  const newConfig = getEmbeddingPreference();
  const oldDim = parseInt(getConfig("embedding.activeDimensions") ?? "384", 10);
  const newDim = newConfig.dimensions;

  await initEmbedder();

  // Re-read currentProvider after initEmbedder (TS can't track cross-function mutation)
  const provider = currentProvider as EmbeddingProvider | null;

  // If dimensions changed, the vec table and stored embeddings are invalid
  if (provider?.isAvailable() && newDim !== oldDim) {
    console.log(`[embedder] dimension change detected (${oldDim} → ${newDim}), rebuilding vector index`);
    try {
      const { rebuildVecTable } = await import("../db/database.ts");
      const { clearAllEmbeddings } = await import("../db/memory-store.ts");
      rebuildVecTable(newDim);
      clearAllEmbeddings();
      setConfig("embedding.activeDimensions", String(newDim));
      console.log("[embedder] vector index rebuilt, backfill needed");
    } catch (err) {
      console.error("[embedder] failed to rebuild vector index:", (err as Error).message);
    }
  } else if (provider?.isAvailable()) {
    setConfig("embedding.activeDimensions", String(newDim));
  }
}

export function getEmbeddingDim(): number {
  return currentProvider?.dimensions ?? 384;
}

export function isEmbedderAvailable(): boolean {
  return currentProvider?.isAvailable() ?? false;
}

export async function embed(text: string): Promise<Float32Array> {
  // Wait for any in-flight init before checking availability
  if (initPromise) await initPromise;
  if (!currentProvider?.isAvailable()) {
    throw new Error("Embedder unavailable");
  }
  return currentProvider.embed(text);
}

export function getActiveProviderId(): string {
  if (!currentProvider) {
    const config = getEmbeddingPreference();
    return config.providerId;
  }
  return currentProvider.providerId;
}
