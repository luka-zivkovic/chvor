// apps/server/src/lib/voice/tts-elevenlabs.ts
import type { TTSProvider, TTSResult } from "./tts-provider.ts";
import type { AudioFormat } from "../../channels/channel.ts";
import { getApiKey } from "./tts-provider.ts";

const FORMAT_MAP: Record<AudioFormat, string> = {
  mp3: "mp3_44100_128",
  opus: "opus_16000",
  ogg: "opus_16000",
  wav: "pcm_44100",
};

export class ElevenLabsTTSProvider implements TTSProvider {
  name = "elevenlabs";

  // Note: ElevenLabs API does not support a speed parameter — opts.speed is accepted but ignored
  async synthesize(
    text: string,
    opts?: { voice?: string; format?: AudioFormat; speed?: number }
  ): Promise<TTSResult> {
    const apiKey = getApiKey("elevenlabs");
    if (!apiKey) throw new Error("ElevenLabs API key not found");

    const voiceId = opts?.voice ?? "21m00Tcm4TlvDq8ikWAM";
    const format = opts?.format ?? "mp3";
    const outputFormat = FORMAT_MAP[format] ?? "mp3_44100_128";

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
        }),
        signal: AbortSignal.timeout(30_000),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const arrayBuf = await res.arrayBuffer();
    return { audio: new Uint8Array(arrayBuf), format };
  }
}
