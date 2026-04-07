// apps/server/src/lib/voice/tts-piper.ts
//
// Local TTS via Piper ONNX models + onnxruntime-node (optional dep).
// Supports multiple downloadable voice models with configurable speed.

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { TTSProvider, TTSResult } from "./tts-provider.ts";
import type { AudioFormat } from "../../channels/channel.ts";
import { getModelsDir, VOICE_MODELS } from "./model-manager.ts";
import { getConfig } from "../../db/config-store.ts";

interface PiperConfig {
  audio: { sample_rate: number };
  num_symbols: number;
  phoneme_id_map: Record<string, number[]>;
  inference: { noise_scale: number; length_scale: number; noise_w: number };
}

// ── WAV encoder ─────────────────────────────────────────────────

function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = pcm.length;
  const bytesPerSample = 2; // 16-bit
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples (float → int16)
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ── Phonemizer ──────────────────────────────────────────────────

/** Convert text to phoneme IDs using Piper's character-level phoneme_id_map. */
function textToPhonemeIds(text: string, map: Record<string, number[]>): number[] {
  const PAD = map["_"]?.[0] ?? 0;
  const BOS = map["^"]?.[0] ?? 1;
  const EOS = map["$"]?.[0] ?? 2;

  const ids: number[] = [BOS];
  for (const char of text.toLowerCase()) {
    const mapped = map[char];
    if (mapped && mapped.length > 0) {
      ids.push(mapped[0]);
      ids.push(PAD); // intersperse pad for better prosody
    }
  }
  ids.push(EOS);
  return ids;
}

// ── Provider ────────────────────────────────────────────────────

interface CachedSession {
  session: any;
  config: PiperConfig;
}

export class PiperTTSProvider implements TTSProvider {
  name = "piper";
  private sessions = new Map<string, CachedSession>();
  private initFailed = new Set<string>();
  private initPromises = new Map<string, Promise<CachedSession | null>>();

  /** Resolve which Piper model to use: configured > first available. */
  private resolveModelId(): string | null {
    const configured = getConfig("voice.tts.piperVoice");
    if (configured) return configured;
    // Fall back to first downloaded Piper model
    const dir = getModelsDir();
    const piperModels = VOICE_MODELS.filter((m) => m.type === "tts" && m.id.startsWith("piper-"));
    for (const m of piperModels) {
      if (m.files.length > 0 && m.files.every((f) => existsSync(join(dir, f.filename)))) {
        return m.id;
      }
    }
    return null;
  }

  /** Clear failure state so a model can be retried. */
  resetForRetry(modelId?: string): void {
    if (modelId) {
      this.initFailed.delete(modelId);
      this.initPromises.delete(modelId);
    } else {
      this.initFailed.clear();
      this.initPromises.clear();
    }
  }

  /** Load an ONNX session for a specific model. */
  private async loadModel(modelId: string): Promise<CachedSession | null> {
    if (this.sessions.has(modelId)) return this.sessions.get(modelId)!;
    if (this.initFailed.has(modelId)) return null;
    if (this.initPromises.has(modelId)) return this.initPromises.get(modelId)!;

    // Store promise in map BEFORE starting async work to prevent duplicate loads
    const promise = this.doLoadModel(modelId);
    this.initPromises.set(modelId, promise);
    return promise;
  }

  private async doLoadModel(modelId: string): Promise<CachedSession | null> {
    try {
      const def = VOICE_MODELS.find((m) => m.id === modelId);
      if (!def || def.files.length < 2) throw new Error(`Unknown Piper model: ${modelId}`);

      const dir = getModelsDir();
      const onnxFile = def.files.find((f) => f.filename.endsWith(".onnx") && !f.filename.endsWith(".json"));
      const configFile = def.files.find((f) => f.filename.endsWith(".json"));
      if (!onnxFile || !configFile) throw new Error(`Invalid model files for ${modelId}`);

      const modelPath = join(dir, onnxFile.filename);
      const configPath = join(dir, configFile.filename);

      if (!existsSync(modelPath) || !existsSync(configPath)) {
        throw new Error("Piper model not downloaded");
      }

      const config: PiperConfig = JSON.parse(readFileSync(configPath, "utf8"));
      const ort = await import("onnxruntime-node");
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
      });

      const cached = { session, config };
      this.sessions.set(modelId, cached);
      console.log(`[tts:piper] loaded model: ${modelId}`);
      return cached;
    } catch (err) {
      this.initFailed.add(modelId);
      console.error(`[tts:piper] failed to load ${modelId}:`, err instanceof Error ? err.message : err);
      return null;
    } finally {
      this.initPromises.delete(modelId);
    }
  }

  async synthesize(
    text: string,
    opts?: { voice?: string; format?: AudioFormat; speed?: number }
  ): Promise<TTSResult> {
    const modelId = this.resolveModelId();
    if (!modelId) throw new Error("Piper TTS not available");

    const cached = await this.loadModel(modelId);
    if (!cached) throw new Error("Piper TTS not available");

    const { session, config } = cached;
    const ort = await import("onnxruntime-node");
    const phonemeIds = textToPhonemeIds(text, config.phoneme_id_map);

    // Speed: lower length_scale = faster speech
    const speed = Math.max(0.5, Math.min(2.0, opts?.speed ?? 1.0));
    const lengthScale = config.inference.length_scale / speed;

    // Build ONNX tensors
    const input = new ort.Tensor("int64", BigInt64Array.from(phonemeIds.map(BigInt)), [1, phonemeIds.length]);
    const inputLengths = new ort.Tensor("int64", BigInt64Array.from([BigInt(phonemeIds.length)]), [1]);
    const scales = new ort.Tensor(
      "float32",
      Float32Array.from([config.inference.noise_scale, lengthScale, config.inference.noise_w]),
      [3]
    );

    const result = await session.run({ input, input_lengths: inputLengths, scales });

    const outputTensor = result["output"] ?? result[Object.keys(result)[0]];
    const pcm = new Float32Array(outputTensor.data);

    const sampleRate = config.audio.sample_rate;
    const wav = encodeWav(pcm, sampleRate);

    return { audio: wav, format: "wav" as AudioFormat };
  }
}
