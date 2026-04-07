// apps/server/src/lib/voice/tts-edge.ts
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { TTSProvider, TTSResult } from "./tts-provider.ts";
import type { AudioFormat } from "../../channels/channel.ts";

export class EdgeTTSProvider implements TTSProvider {
  name = "edge";

  async synthesize(
    text: string,
    opts?: { voice?: string; format?: AudioFormat }
  ): Promise<TTSResult> {
    let EdgeTTS: any;
    try { ({ EdgeTTS } = await import("node-edge-tts")); }
    catch { throw new Error("Edge TTS not available (node-edge-tts not installed)"); }

    const voice = opts?.voice ?? "en-US-AriaNeural";
    const tmpPath = join(tmpdir(), `chvor-edge-tts-${randomUUID()}.mp3`);

    try {
      const tts = new EdgeTTS({ voice, rate: "+0%" });
      await tts.ttsPromise(text, tmpPath);

      const audio = new Uint8Array(await readFile(tmpPath));
      // Edge TTS always outputs MP3 regardless of requested format
      return { audio, format: "mp3" };
    } finally {
      // Clean up temp file
      await unlink(tmpPath).catch(() => {});
    }
  }
}
