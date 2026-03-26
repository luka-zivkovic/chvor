// apps/server/src/lib/voice/tts-piper.ts
//
// Local TTS via Piper ONNX models + onnxruntime-node (optional dep).
// Character-level phonemization using Piper's phoneme_id_map from the model config.

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { TTSProvider, TTSResult } from "./tts-provider.ts";
import type { AudioFormat } from "../../channels/channel.ts";
import { getModelsDir } from "./model-manager.ts";

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
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true); // bits per sample

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

export class PiperTTSProvider implements TTSProvider {
  name = "piper";
  private session: any = null;
  private config: PiperConfig | null = null;
  private initPromise: Promise<void> | null = null;
  private failed = false;

  async init(): Promise<void> {
    if (this.session || this.failed) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const dir = getModelsDir();
        const modelPath = join(dir, "en_US-lessac-medium.onnx");
        const configPath = join(dir, "en_US-lessac-medium.onnx.json");

        if (!existsSync(modelPath) || !existsSync(configPath)) {
          throw new Error("Piper model not downloaded");
        }

        this.config = JSON.parse(readFileSync(configPath, "utf8"));

        const ort = await import("onnxruntime-node");
        this.session = await ort.InferenceSession.create(modelPath, {
          executionProviders: ["cpu"],
        });

        console.log("[tts:piper] model loaded");
      } catch (err) {
        this.failed = true;
        console.error("[tts:piper] failed to load:", err instanceof Error ? err.message : err);
      }
    })();
    return this.initPromise;
  }

  isAvailable(): boolean {
    return this.session !== null && !this.failed;
  }

  async synthesize(
    text: string,
    opts?: { voice?: string; format?: AudioFormat }
  ): Promise<TTSResult> {
    if (!this.session) await this.init();
    if (!this.session || !this.config) {
      throw new Error("Piper TTS not available");
    }

    const ort = await import("onnxruntime-node");
    const phonemeIds = textToPhonemeIds(text, this.config.phoneme_id_map);

    // Build ONNX tensors
    const input = new ort.Tensor("int64", BigInt64Array.from(phonemeIds.map(BigInt)), [1, phonemeIds.length]);
    const inputLengths = new ort.Tensor("int64", BigInt64Array.from([BigInt(phonemeIds.length)]), [1]);
    const scales = new ort.Tensor(
      "float32",
      Float32Array.from([
        this.config.inference.noise_scale,
        this.config.inference.length_scale,
        this.config.inference.noise_w,
      ]),
      [3]
    );

    const result = await this.session.run({ input, input_lengths: inputLengths, scales });

    // Output is "output" tensor with shape [1, 1, num_samples]
    const outputTensor = result["output"] ?? result[Object.keys(result)[0]];
    const pcm = new Float32Array(outputTensor.data);

    const sampleRate = this.config.audio.sample_rate;
    const wav = encodeWav(pcm, sampleRate);

    // Piper outputs WAV. Format is always "wav" — browsers can play it.
    return { audio: wav, format: "wav" as AudioFormat };
  }
}
