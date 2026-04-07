// apps/server/src/lib/voice/stt-provider.ts
import { getApiKey } from "./tts-provider.ts";
import { getConfig } from "../../db/config-store.ts";
import { getLocalWhisperProvider } from "./stt-whisper-local.ts";

export type STTProviderName = "whisper-api" | "whisper-local" | "browser";

export interface STTResult {
  text: string;
  confidence?: number;
}

export interface STTProvider {
  transcribe(audio: Uint8Array, format: string): Promise<STTResult>;
}

export class WhisperSTTProvider implements STTProvider {
  async transcribe(audio: Uint8Array, format: string): Promise<STTResult> {
    const apiKey = getApiKey("openai");
    if (!apiKey) throw new Error("OpenAI API key not found for Whisper STT");

    const ext = format.replace("oga", "ogg");
    const blob = new Blob([audio as Uint8Array<ArrayBuffer>], { type: `audio/${ext}` });
    const form = new FormData();
    form.append("file", blob, `audio.${ext}`);
    form.append("model", "whisper-1");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Whisper STT failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as { text: string };
    return { text: json.text };
  }
}

let whisperInstance: WhisperSTTProvider | null = null;
export function getWhisperProvider(): WhisperSTTProvider {
  if (!whisperInstance) whisperInstance = new WhisperSTTProvider();
  return whisperInstance;
}

/**
 * Resolve the active STT provider based on config.
 * Falls back gracefully: whisper-local → whisper-api → error.
 */
export function getSTTProvider(): STTProvider {
  const configured = (getConfig("voice.stt.provider") ?? "whisper-api") as STTProviderName;

  if (configured === "whisper-local") {
    const local = getLocalWhisperProvider();
    if (local.isAvailable()) return local;
    // Fall back to API if local model isn't ready
    console.warn("[stt] local Whisper not available, falling back to API");
    const apiKey = getApiKey("openai");
    if (apiKey) return getWhisperProvider();
    throw new Error("Local Whisper STT model not available and no OpenAI API key configured");
  }

  if (configured === "whisper-api") {
    return getWhisperProvider();
  }

  // "browser" — server-side STT shouldn't be called for browser mode,
  // but if it is (e.g. Telegram), fall back to whatever is available
  const local = getLocalWhisperProvider();
  if (local.isAvailable()) return local;
  const apiKey = getApiKey("openai");
  if (apiKey) return getWhisperProvider();
  throw new Error("No STT provider configured. Set up voice in Settings.");
}
