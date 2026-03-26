// apps/server/src/lib/voice/tts-edge.ts
import type { TTSProvider, TTSResult } from "./tts-provider.ts";
import type { AudioFormat } from "../../channels/channel.ts";

export class EdgeTTSProvider implements TTSProvider {
  name = "edge";

  async synthesize(
    text: string,
    opts?: { voice?: string; format?: AudioFormat }
  ): Promise<TTSResult> {
    const { EdgeTTS } = await import("node-edge-tts") as any;

    const voice = opts?.voice ?? "en-US-AriaNeural";

    const tts = new EdgeTTS();
    await tts.synthesize(text, voice, { rate: "+0%" });

    const chunks: Uint8Array[] = [];
    const stream = tts.toStream();

    return new Promise<TTSResult>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
      stream.on("end", () => {
        const combined = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        // Edge TTS always outputs MP3 regardless of requested format
        resolve({ audio: combined, format: "mp3" });
      });
      stream.on("error", reject);
    });
  }
}
