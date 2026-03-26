import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MediaArtifact } from "@chvor/shared";
import { getMediaRetentionDays } from "../db/config-store.ts";

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024; // 20 MB

let mediaDirCreated = false;

export function getMediaDir(): string {
  return join(homedir(), ".chvor", "media");
}

function ensureMediaDir(): void {
  if (mediaDirCreated) return;
  const dir = getMediaDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  mediaDirCreated = true;
}

export const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
};

export function mimeToExt(mimeType: string): string {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[base] ?? "bin";
}

function mimeToMediaType(mimeType: string): MediaArtifact["mediaType"] {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("audio/")) return "audio";
  if (base.startsWith("video/")) return "video";
  return "file";
}

function storeBuffer(
  buffer: Buffer,
  mimeType: string,
  filename?: string,
): MediaArtifact {
  if (buffer.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`Media artifact too large (${buffer.length} bytes, max ${MAX_ARTIFACT_BYTES})`);
  }

  ensureMediaDir();

  const id = randomUUID();
  const ext = mimeToExt(mimeType);
  const diskFilename = `${id}.${ext}`;
  const filePath = join(getMediaDir(), diskFilename);

  writeFileSync(filePath, buffer);

  return {
    id,
    url: `/api/media/${diskFilename}`,
    mimeType: mimeType.split(";")[0].trim(),
    mediaType: mimeToMediaType(mimeType),
    filename: filename ?? diskFilename,
    sizeBytes: buffer.length,
  };
}

export function storeMediaFromBase64(
  base64: string,
  mimeType: string,
  filename?: string,
): MediaArtifact {
  return storeBuffer(Buffer.from(base64, "base64"), mimeType, filename);
}

export function storeMediaFromBuffer(
  buffer: Buffer,
  mimeType: string,
  filename?: string,
): MediaArtifact {
  return storeBuffer(buffer, mimeType, filename);
}

// ── Media cleanup ────────────────────────────────────────────────

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Remove media files older than the configured retention period. */
function cleanupExpiredMedia(): void {
  try {
    const retentionDays = getMediaRetentionDays();
    if (retentionDays <= 0) return; // 0 = keep forever

    const dir = getMediaDir();
    if (!existsSync(dir)) return;

    const ttlMs = retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let removed = 0;

    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      const stat = statSync(path);
      if (now - stat.mtimeMs > ttlMs) {
        unlinkSync(path);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[media-store] cleaned up ${removed} expired file(s)`);
    }
  } catch (err) {
    console.error("[media-store] cleanup error:", err);
  }
}

/** Start periodic media cleanup. Also runs immediately. */
export function startMediaCleanup(): void {
  cleanupExpiredMedia();
  cleanupTimer = setInterval(cleanupExpiredMedia, CLEANUP_INTERVAL_MS);
}

/** Stop periodic media cleanup. */
export function stopMediaCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
