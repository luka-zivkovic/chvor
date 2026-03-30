// apps/server/src/lib/voice/tts-provider.ts
import { listCredentials, getCredentialData } from "../../db/credential-store.ts";
import { getConfig } from "../../db/config-store.ts";
import type { AudioFormat } from "../../channels/channel.ts";

export type { AudioFormat }; // re-export for convenience

export interface TTSResult {
  audio: Uint8Array;
  format: AudioFormat;
  duration?: number;
}

export interface TTSProvider {
  name: string;
  synthesize(text: string, opts?: { voice?: string; format?: AudioFormat; speed?: number }): Promise<TTSResult>;
}

export type TTSProviderName = "openai" | "elevenlabs" | "edge" | "piper";

/** Resolve credential API key by type. Returns null if not found. */
export function getApiKey(credType: string): string | null {
  const creds = listCredentials();
  const match = creds.find((c) => c.type === credType);
  if (!match) return null;
  const full = getCredentialData(match.id);
  if (!full) return null;
  return (full.data as Record<string, string>).apiKey || null;
}

/** Build ordered list of TTS providers to try. */
export function resolveTtsProviderOrder(): TTSProviderName[] {
  const explicit = getConfig("voice.tts.provider") as TTSProviderName | null;
  const all: TTSProviderName[] = ["openai", "elevenlabs", "edge", "piper"];
  if (explicit) {
    const others = all.filter((p) => p !== explicit) as TTSProviderName[];
    return [explicit, ...others];
  }
  return all;
}

/** Resolve output format based on channel type. */
export function resolveOutputFormat(channelType: string): AudioFormat {
  if (channelType === "telegram") return "ogg";
  return "mp3";
}
