import type {
  MediaModelType,
  MediaModelConfig,
  MediaPipelineConfig,
} from "@chvor/shared";
import { getDb } from "../database.ts";
import { getConfig, setConfig } from "./base.ts";

// --- Media pipeline config ---

const DEFAULT_MEDIA_PIPELINE: MediaPipelineConfig = {
  image: { enabled: true, maxSizeBytes: 10 * 1024 * 1024 },  // 10 MB
  video: { enabled: true, maxSizeBytes: 20 * 1024 * 1024 },  // 20 MB
  audio: { enabled: true, maxSizeBytes: 10 * 1024 * 1024 },  // 10 MB
};

export function getMediaPipelineConfig(): MediaPipelineConfig {
  const raw = getConfig("media.pipeline");
  if (!raw) return structuredClone(DEFAULT_MEDIA_PIPELINE);
  try {
    const parsed = JSON.parse(raw);
    return {
      image: { ...DEFAULT_MEDIA_PIPELINE.image, ...parsed.image },
      video: { ...DEFAULT_MEDIA_PIPELINE.video, ...parsed.video },
      audio: { ...DEFAULT_MEDIA_PIPELINE.audio, ...parsed.audio },
    };
  } catch {
    return structuredClone(DEFAULT_MEDIA_PIPELINE);
  }
}

export function setMediaPipelineConfig(updates: Partial<MediaPipelineConfig>): MediaPipelineConfig {
  const current = getMediaPipelineConfig();
  if (updates.image) Object.assign(current.image, updates.image);
  if (updates.video) Object.assign(current.video, updates.video);
  if (updates.audio) Object.assign(current.audio, updates.audio);
  setConfig("media.pipeline", JSON.stringify(current));
  return current;
}

// --- Media model config (per media-type model routing) ---

export function getMediaModelConfig(type: MediaModelType): MediaModelConfig | null {
  const providerId = getConfig(`media.model.${type}.providerId`);
  const model = getConfig(`media.model.${type}.model`);
  if (!providerId || !model) return null;
  return { providerId, model };
}

export function setMediaModelConfig(type: MediaModelType, config: MediaModelConfig): MediaModelConfig {
  setConfig(`media.model.${type}.providerId`, config.providerId);
  setConfig(`media.model.${type}.model`, config.model);
  return config;
}

export function clearMediaModelConfig(type: MediaModelType): void {
  const db = getDb();
  db.prepare("DELETE FROM config WHERE key = ?").run(`media.model.${type}.providerId`);
  db.prepare("DELETE FROM config WHERE key = ?").run(`media.model.${type}.model`);
}

export function getAllMediaModelConfigs(): Record<MediaModelType, MediaModelConfig | null> {
  return {
    "image-understanding": getMediaModelConfig("image-understanding"),
    "video-understanding": getMediaModelConfig("video-understanding"),
    "image-generation": getMediaModelConfig("image-generation"),
  };
}

// ── Media retention ──────────────────────────────────────────────

/** Get media retention period in days. 0 = keep forever. Default: 7. */
export function getMediaRetentionDays(): number {
  const raw = getConfig("media.retentionDays");
  if (raw == null) return 7;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 7 : Math.max(0, parsed);
}

/** Set media retention period in days. 0 = keep forever. */
export function setMediaRetentionDays(days: number): number {
  const clamped = Math.max(0, Math.floor(days));
  setConfig("media.retentionDays", String(clamped));
  return clamped;
}
