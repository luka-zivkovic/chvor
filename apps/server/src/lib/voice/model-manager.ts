// apps/server/src/lib/voice/model-manager.ts
//
// Manages voice model downloads for local STT (Whisper) and TTS (Piper).
// Models are stored at ~/.chvor/models/voice/.

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync, statSync, unlinkSync, createWriteStream, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getLocalWhisperProvider } from "./stt-whisper-local.ts";

// ── Model catalog ─────────────────────────────────────────────────

export interface VoiceModelFile {
  url: string;
  filename: string;
  sizeEstimate: number; // bytes
}

export interface VoiceModelMeta {
  language?: string;
  locale?: string;
  gender?: "male" | "female";
  quality?: "low" | "medium" | "high";
}

export interface VoiceModelDef {
  id: string;
  name: string;
  type: "stt" | "tts";
  description: string;
  sizeEstimate: string; // human-readable, e.g. "~40MB"
  files: VoiceModelFile[];
  meta?: VoiceModelMeta;
}

export type ModelStatus = "not_downloaded" | "downloading" | "ready" | "error";

export interface ModelProgress {
  status: ModelStatus;
  percent: number;
  error?: string;
}

const HF_BASE = "https://huggingface.co";
const PIPER_BASE = `${HF_BASE}/rhasspy/piper-voices/resolve/main`;

/** Helper to create a Piper voice model definition. */
function piperVoice(
  id: string, name: string, description: string,
  lang: string, locale: string, voiceName: string, quality: "low" | "medium" | "high",
  gender: "male" | "female", sizeEstimate: string, onnxSize: number,
): VoiceModelDef {
  const filename = `${locale}-${voiceName}-${quality}`;
  return {
    id, name, type: "tts", description, sizeEstimate,
    meta: { language: lang, locale, gender, quality },
    files: [
      { url: `${PIPER_BASE}/${lang.substring(0, 2)}/${locale}/${voiceName}/${quality}/${filename}.onnx`, filename: `${filename}.onnx`, sizeEstimate: onnxSize },
      { url: `${PIPER_BASE}/${lang.substring(0, 2)}/${locale}/${voiceName}/${quality}/${filename}.onnx.json`, filename: `${filename}.onnx.json`, sizeEstimate: 50_000 },
    ],
  };
}

export const VOICE_MODELS: VoiceModelDef[] = [
  {
    id: "whisper-tiny-en",
    name: "Whisper Tiny (English)",
    type: "stt",
    description: "Fast local speech-to-text. English only. ~40MB download. Runs on CPU.",
    sizeEstimate: "~40MB",
    files: [],
  },

  // ── English voices ────────────────────────────────────────────
  piperVoice("piper-lessac-medium", "Lessac", "Natural American male voice. Clear and warm.", "en", "en_US", "lessac", "medium", "male", "~30MB", 29_000_000),
  piperVoice("piper-lessac-high", "Lessac (High Quality)", "Premium American male voice. Best quality, slower.", "en", "en_US", "lessac", "high", "male", "~60MB", 58_000_000),
  piperVoice("piper-amy-medium", "Amy", "British female voice. Warm and professional.", "en", "en_GB", "amy", "medium", "female", "~30MB", 29_000_000),
  piperVoice("piper-ryan-medium", "Ryan", "American male voice. Casual and friendly.", "en", "en_US", "ryan", "medium", "male", "~30MB", 29_000_000),
  piperVoice("piper-alba-medium", "Alba", "British female voice. Calm and clear.", "en", "en_GB", "alba", "medium", "female", "~30MB", 29_000_000),
  piperVoice("piper-danny-low", "Danny", "British male voice. Lightweight and fast.", "en", "en_GB", "danny", "low", "male", "~15MB", 15_000_000),

  // ── European voices ───────────────────────────────────────────
  piperVoice("piper-thorsten-medium", "Thorsten", "German male voice. Natural speech.", "de", "de_DE", "thorsten", "medium", "male", "~30MB", 29_000_000),
  piperVoice("piper-siwis-medium", "Siwis", "French female voice. Expressive and clear.", "fr", "fr_FR", "siwis", "medium", "female", "~30MB", 29_000_000),
  piperVoice("piper-riccardo-medium", "Riccardo", "Italian male voice. Warm and natural.", "it", "it_IT", "riccardo", "medium", "male", "~30MB", 29_000_000),
  piperVoice("piper-mls-medium", "MLS", "Spanish male voice. Clear pronunciation.", "es", "es_ES", "mls_9972", "medium", "male", "~30MB", 29_000_000),

  // ── Other languages ───────────────────────────────────────────
  piperVoice("piper-tugao-medium", "Tugão", "Portuguese (Brazil) male voice.", "pt", "pt_BR", "faber", "medium", "male", "~30MB", 29_000_000),
  piperVoice("piper-karlsson-medium", "Karlsson", "Swedish male voice. Clear and natural.", "sv", "sv_SE", "nst", "medium", "male", "~30MB", 29_000_000),
];

// ── State ─────────────────────────────────────────────────────────

const downloads = new Map<string, ModelProgress>();

// ── Helpers ───────────────────────────────────────────────────────

export function getModelsDir(): string {
  return join(homedir(), ".chvor", "models", "voice");
}

function ensureModelsDir(): string {
  const dir = getModelsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Public API ────────────────────────────────────────────────────

export function getModelDef(modelId: string): VoiceModelDef | undefined {
  return VOICE_MODELS.find((m) => m.id === modelId);
}

/**
 * Check if a model's files are fully downloaded.
 * For whisper-tiny-en (HF-managed), we check the local provider's availability.
 */
export function getModelStatus(modelId: string): ModelStatus {
  const inProgress = downloads.get(modelId);
  if (inProgress && inProgress.status === "downloading") return "downloading";
  if (inProgress && inProgress.status === "error") return "error";

  const def = getModelDef(modelId);
  if (!def) return "not_downloaded";

  // Whisper: check via local provider
  if (modelId === "whisper-tiny-en") {
    const provider = getLocalWhisperProvider();
    return provider.isAvailable() ? "ready" : "not_downloaded";
  }

  // Piper: check if all files exist on disk
  const dir = getModelsDir();
  const allExist = def.files.length > 0 && def.files.every((f) => {
    const path = join(dir, f.filename);
    return existsSync(path) && statSync(path).size > 0;
  });
  return allExist ? "ready" : "not_downloaded";
}

export function getDownloadProgress(modelId: string): ModelProgress {
  return downloads.get(modelId) ?? { status: getModelStatus(modelId), percent: 0 };
}

/**
 * Start downloading a model. Returns immediately; progress tracked in memory.
 */
export async function startDownload(modelId: string): Promise<void> {
  const def = getModelDef(modelId);
  if (!def) throw new Error(`Unknown model: ${modelId}`);

  // Prevent concurrent downloads of the same model
  const existing = downloads.get(modelId);
  if (existing?.status === "downloading") return;
  if (getModelStatus(modelId) === "ready") return;

  // Set status before any async work to prevent concurrent calls from passing the guard
  downloads.set(modelId, { status: "downloading", percent: 0 });

  try {
    // Whisper: trigger HF Transformers auto-download via provider init
    if (modelId === "whisper-tiny-en") {
      const { getLocalWhisperProvider } = await import("./stt-whisper-local.ts");
      const provider = getLocalWhisperProvider();
      // Reset failure state so a previous failed attempt doesn't block retry
      provider.resetForRetry();
      // Simulate progress since HF doesn't give us a granular callback
      const progressInterval = setInterval(() => {
        const p = downloads.get(modelId);
        if (p && p.status === "downloading" && p.percent < 90) {
          downloads.set(modelId, { status: "downloading", percent: p.percent + 5 });
        }
      }, 2000);
      try {
        await provider.init();
        clearInterval(progressInterval);
        if (provider.isAvailable()) {
          downloads.set(modelId, { status: "ready", percent: 100 });
        } else {
          const detail = provider.getLastError() ?? "Model failed to load";
          downloads.set(modelId, { status: "error", percent: 0, error: detail });
        }
      } catch (err) {
        clearInterval(progressInterval);
        downloads.set(modelId, {
          status: "error",
          percent: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Piper and other file-based models: download files directly
    const dir = ensureModelsDir();
    const totalSize = def.files.reduce((s, f) => s + f.sizeEstimate, 0);
    let downloadedBytes = 0;

    for (const file of def.files) {
      const targetPath = join(dir, file.filename);
      const tmpPath = join(dir, `${file.filename}.${randomUUID()}.tmp`);

      const res = await fetch(file.url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok || !res.body) {
        throw new Error(`Failed to download ${file.filename}: ${res.status}`);
      }

      // Stream to disk with proper cleanup on error
      const writer = createWriteStream(tmpPath, { mode: 0o600 });
      const reader = res.body.getReader();
      try {
        let done = false;
        while (!done) {
          const chunk = await reader.read();
          done = chunk.done;
          if (chunk.value) {
            const canContinue = writer.write(chunk.value);
            if (!canContinue) await new Promise<void>((r) => writer.once("drain", r));
            downloadedBytes += chunk.value.length;
            const percent = Math.min(99, Math.round((downloadedBytes / totalSize) * 100));
            downloads.set(modelId, { status: "downloading", percent });
          }
        }
        writer.end();
        await new Promise<void>((resolve, reject) => {
          writer.on("finish", resolve);
          writer.on("error", reject);
        });
      } catch (streamErr) {
        writer.destroy();
        try { unlinkSync(tmpPath); } catch { /* ignore cleanup */ }
        throw streamErr;
      }

      // Atomic rename
      renameSync(tmpPath, targetPath);
    }

    downloads.set(modelId, { status: "ready", percent: 100 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[model-manager] download failed for ${modelId}:`, msg);
    downloads.set(modelId, { status: "error", percent: 0, error: msg });
  }
}

export function deleteModel(modelId: string): boolean {
  const def = getModelDef(modelId);
  if (!def) return false;

  // Can't delete Whisper — it's managed by HF Transformers cache
  if (modelId === "whisper-tiny-en") return false;

  const dir = getModelsDir();
  let deleted = false;
  for (const file of def.files) {
    const path = join(dir, file.filename);
    try {
      if (existsSync(path)) {
        unlinkSync(path);
        deleted = true;
      }
    } catch (err) {
      console.warn(`[model-manager] failed to delete ${path}:`, err);
    }
  }
  downloads.delete(modelId);
  return deleted;
}

export function listModels(): Array<VoiceModelDef & { status: ModelStatus; progress: ModelProgress }> {
  return VOICE_MODELS.map((m) => ({
    ...m,
    status: getModelStatus(m.id),
    progress: getDownloadProgress(m.id),
  }));
}
