// apps/server/src/lib/voice/stt-whisper-local.ts
//
// Local Whisper STT via @huggingface/transformers (already a dep).
// Follows the same lazy-init + dedup-promise pattern as embedder.ts.

import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { STTResult, STTProvider } from "./stt-provider.ts";

const MODEL_CACHE_DIR = join(homedir(), ".chvor", "models", "voice");
const MODEL_ID = "onnx-community/whisper-tiny.en";

/**
 * Custom cache that replaces HF Transformers' built-in FileCache.
 * The built-in FileCache has a bug: fileStream.close() isn't awaited in put(),
 * so the subsequent match() call can't find the file (race condition on Windows).
 * This implementation uses writeFileSync to avoid the race entirely.
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

class LocalWhisperSTTProvider implements STTProvider {
  private pipeline: any = null;
  private failed = false;
  private lastError: string | null = null;
  private initPromise: Promise<void> | null = null;

  /** Reset failure state so init() can be retried. */
  resetForRetry(): void {
    this.failed = false;
    this.lastError = null;
    this.initPromise = null;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  async init(): Promise<void> {
    if (this.pipeline || this.failed) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const start = Date.now();
        mkdirSync(MODEL_CACHE_DIR, { recursive: true });
        console.log(`[stt:local] cache dir: ${MODEL_CACHE_DIR}`);
        const { pipeline, env } = await import("@huggingface/transformers");

        // Disable the built-in FileCache (has a race condition on Windows where
        // fileStream.close() isn't awaited in put(), so match() can't find files).
        // Use our own synchronous-write cache instead.
        // NOTE: These are global env settings — they intentionally affect all HF
        // Transformers consumers in this process (currently only this module).
        env.useFSCache = false;
        env.useCustomCache = true;
        env.customCache = createModelCache(MODEL_CACHE_DIR);
        env.allowRemoteModels = true;
        env.allowLocalModels = true;

        this.pipeline = await pipeline("automatic-speech-recognition", MODEL_ID, {
          dtype: "fp32",
          local_files_only: false,
          progress_callback: (progress: { status: string; file?: string; progress?: number }) => {
            if (progress.status === "download") {
              console.log(`[stt:local] downloading ${progress.file}...`);
            }
          },
        });
        console.log(`[stt:local] model loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      } catch (err) {
        this.failed = true;
        this.lastError = err instanceof Error ? err.message : String(err);
        console.error("[stt:local] failed to load model:", err);
      }
    })();
    return this.initPromise;
  }

  async transcribe(audio: Uint8Array, format: string): Promise<STTResult> {
    if (this.failed) throw new Error("Local Whisper STT not available");
    if (!this.pipeline) await this.init();
    if (!this.pipeline) throw new Error("Local Whisper STT not available");

    // Write audio to a temp file — HF Transformers pipeline can read file paths
    const ext = format.replace("oga", "ogg");
    const tmpPath = join(tmpdir(), `chvor-stt-${randomUUID()}.${ext}`);
    try {
      writeFileSync(tmpPath, audio, { mode: 0o600 });
      const result = await this.pipeline(tmpPath, {
        return_timestamps: false,
        chunk_length_s: 30,
      });
      return { text: result.text?.trim() ?? "" };
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
    }
  }

  isAvailable(): boolean {
    return this.pipeline !== null && !this.failed;
  }

  isInitializing(): boolean {
    return this.initPromise !== null && !this.pipeline && !this.failed;
  }
}

let instance: LocalWhisperSTTProvider | null = null;

export function getLocalWhisperProvider(): LocalWhisperSTTProvider {
  if (!instance) instance = new LocalWhisperSTTProvider();
  return instance;
}
