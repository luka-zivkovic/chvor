import { Hono } from "hono";
import type { MediaModelType, MediaPipelineConfig } from "@chvor/shared";
import {
  getMediaPipelineConfig,
  setMediaPipelineConfig,
  getAllMediaModelConfigs,
  getMediaModelConfig,
  setMediaModelConfig,
  clearMediaModelConfig,
  getMediaRetentionDays,
  setMediaRetentionDays,
} from "../db/config-store.ts";

const mediaConfig = new Hono();

// --- Pipeline config (per-type limits & enable/disable) ---

mediaConfig.get("/pipeline", (c) => {
  return c.json({ data: getMediaPipelineConfig() });
});

mediaConfig.patch("/pipeline", async (c) => {
  try {
    const body = (await c.req.json()) as Partial<MediaPipelineConfig>;
    const updated = setMediaPipelineConfig(body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// --- Media model routing config ---

const VALID_MEDIA_TYPES: MediaModelType[] = ["image-understanding", "video-understanding", "image-generation"];

mediaConfig.get("/models", (c) => {
  return c.json({ data: getAllMediaModelConfigs() });
});

mediaConfig.get("/models/:type", (c) => {
  const type = c.req.param("type") as MediaModelType;
  if (!VALID_MEDIA_TYPES.includes(type)) {
    return c.json({ error: `Invalid media model type. Must be one of: ${VALID_MEDIA_TYPES.join(", ")}` }, 400);
  }
  return c.json({ data: getMediaModelConfig(type) });
});

mediaConfig.put("/models/:type", async (c) => {
  const type = c.req.param("type") as MediaModelType;
  if (!VALID_MEDIA_TYPES.includes(type)) {
    return c.json({ error: `Invalid media model type. Must be one of: ${VALID_MEDIA_TYPES.join(", ")}` }, 400);
  }
  try {
    const body = (await c.req.json()) as { providerId: string; model: string };
    if (!body.providerId || !body.model) {
      return c.json({ error: "providerId and model are required" }, 400);
    }
    const updated = setMediaModelConfig(type, { providerId: body.providerId, model: body.model });
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

mediaConfig.delete("/models/:type", (c) => {
  const type = c.req.param("type") as MediaModelType;
  if (!VALID_MEDIA_TYPES.includes(type)) {
    return c.json({ error: `Invalid media model type. Must be one of: ${VALID_MEDIA_TYPES.join(", ")}` }, 400);
  }
  clearMediaModelConfig(type);
  return c.json({ data: null });
});

// --- Media retention policy ---

mediaConfig.get("/retention", (c) => {
  return c.json({ data: { retentionDays: getMediaRetentionDays() } });
});

mediaConfig.patch("/retention", async (c) => {
  let body: { retentionDays?: number };
  try {
    body = (await c.req.json()) as { retentionDays?: number };
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    if (body.retentionDays == null || typeof body.retentionDays !== "number") {
      return c.json({ error: "retentionDays (number) is required. 0 = keep forever." }, 400);
    }
    const updated = setMediaRetentionDays(body.retentionDays);
    return c.json({ data: { retentionDays: updated } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default mediaConfig;
