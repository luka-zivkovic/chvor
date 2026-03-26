// apps/server/src/lib/voice/tts-openai.ts
import type { TTSProvider, TTSResult } from "./tts-provider.ts";
import type { AudioFormat } from "../../channels/channel.ts";
import { getApiKey } from "./tts-provider.ts";

const FORMAT_MAP: Record<AudioFormat, string> = {
  mp3: "mp3",
  opus: "opus",
  ogg: "opus",
  wav: "wav",
};

export class OpenAITTSProvider implements TTSProvider {
  name = "openai";

  async synthesize(
    text: string,
    opts?: { voice?: string; format?: AudioFormat }
  ): Promise<TTSResult> {
    const apiKey = getApiKey("openai");
    if (!apiKey) throw new Error("OpenAI API key not found");

    const voice = opts?.voice ?? "alloy";
    const format = opts?.format ?? "mp3";

    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice,
        response_format: FORMAT_MAP[format] ?? "mp3",
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI TTS failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const arrayBuf = await res.arrayBuffer();
    return { audio: new Uint8Array(arrayBuf), format };
  }
}
