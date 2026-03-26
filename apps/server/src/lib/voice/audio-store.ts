// apps/server/src/lib/voice/audio-store.ts
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AUDIO_DIR = join(tmpdir(), "chvor-tts");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureDir(): void {
  if (!existsSync(AUDIO_DIR)) {
    mkdirSync(AUDIO_DIR, { recursive: true });
  }
}

/** Save audio data and return the file ID (without extension). */
export async function saveAudio(data: Uint8Array, ext: string): Promise<string> {
  ensureDir();
  const id = randomUUID();
  const filename = `${id}.${ext}`;
  await writeFile(join(AUDIO_DIR, filename), data);
  return id;
}

/** Read audio file by ID. Returns null if not found or ID is invalid. */
export function readAudio(id: string): { data: Buffer; ext: string } | null {
  if (!UUID_RE.test(id)) return null;
  ensureDir();
  const files = readdirSync(AUDIO_DIR);
  const match = files.find((f) => f.startsWith(id));
  if (!match) return null;
  const ext = match.split(".").pop() ?? "mp3";
  return { data: readFileSync(join(AUDIO_DIR, match)), ext };
}

/** Build the public URL path for an audio file. */
export function audioUrl(id: string, ext: string): string {
  return `/audio/${id}.${ext}`;
}

/** Remove expired audio files. */
function cleanup(): void {
  try {
    ensureDir();
    const now = Date.now();
    for (const file of readdirSync(AUDIO_DIR)) {
      const path = join(AUDIO_DIR, file);
      const stat = statSync(path);
      if (now - stat.mtimeMs > TTL_MS) {
        unlinkSync(path);
      }
    }
  } catch (err) {
    console.error("[audio-store] cleanup error:", err);
  }
}

/** Start periodic cleanup. Also runs immediately to purge stale files from previous runs. */
export function startAudioCleanup(): void {
  cleanup();
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
}

/** Stop periodic cleanup. */
export function stopAudioCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
