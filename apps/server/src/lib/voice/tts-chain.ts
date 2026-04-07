// apps/server/src/lib/voice/tts-chain.ts
import type { TTSProvider, TTSResult, TTSProviderName } from "./tts-provider.ts";
import { resolveTtsProviderOrder, resolveOutputFormat } from "./tts-provider.ts";
import { OpenAITTSProvider } from "./tts-openai.ts";
import { ElevenLabsTTSProvider } from "./tts-elevenlabs.ts";
import { EdgeTTSProvider } from "./tts-edge.ts";
import { PiperTTSProvider } from "./tts-piper.ts";

const PROVIDER_FACTORIES: Record<TTSProviderName, () => TTSProvider> = {
  openai: () => new OpenAITTSProvider(),
  elevenlabs: () => new ElevenLabsTTSProvider(),
  edge: () => new EdgeTTSProvider(),
  piper: () => new PiperTTSProvider(),
};

// Singleton cache — avoids re-creating providers (and reloading ONNX models) per request
const providerCache: Partial<Record<TTSProviderName, TTSProvider>> = {};
function getOrCreateProvider(name: TTSProviderName): TTSProvider {
  if (!providerCache[name]) providerCache[name] = PROVIDER_FACTORIES[name]();
  return providerCache[name]!;
}

/** Evict a cached provider so it's re-created on next request (e.g. after a transient failure). */
export function evictProviderCache(name?: TTSProviderName): void {
  if (name) {
    delete providerCache[name];
  } else {
    for (const key of Object.keys(providerCache)) delete providerCache[key as TTSProviderName];
  }
}

/** Synthesize text to audio, trying providers in fallback order. */
export async function synthesizeWithFallback(
  text: string,
  channelType: string,
  voice?: string,
  speed?: number
): Promise<TTSResult> {
  const order = resolveTtsProviderOrder();
  const format = resolveOutputFormat(channelType);
  const errors: string[] = [];

  for (const name of order) {
    // Edge/Piper only output MP3/WAV — skip when OGG is required (e.g. Telegram voice)
    if ((name === "edge" || name === "piper") && format === "ogg") continue;

    try {
      const provider = getOrCreateProvider(name);
      const result = await provider.synthesize(text, { voice, format, speed });
      console.log(`[tts] synthesized ${text.length} chars via ${name} (${result.audio.length} bytes)`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${name}: ${msg}`);
      console.warn(`[tts] ${name} failed: ${msg}`);
    }
  }

  throw new Error(`All TTS providers failed:\n${errors.join("\n")}`);
}
