// apps/server/src/routes/voice.ts
import { Hono } from "hono";
import { getConfig, setConfig } from "../db/config-store.ts";
import { getSTTProvider } from "../lib/voice/stt-provider.ts";
import { getLocalWhisperProvider } from "../lib/voice/stt-whisper-local.ts";
import { getApiKey, resolveTtsProviderOrder } from "../lib/voice/tts-provider.ts";
import { listModels, getDownloadProgress, startDownload, deleteModel, getModelStatus } from "../lib/voice/model-manager.ts";

const app = new Hono();

// POST /api/voice/transcribe — browser fallback STT
app.post("/transcribe", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "Expected multipart/form-data" }, 400);
  }

  const body = await c.req.parseBody();
  const file = body["audio"];
  if (!(file instanceof File)) {
    return c.json({ error: "Missing audio file" }, 422);
  }

  // 10MB limit
  if (file.size > 10 * 1024 * 1024) {
    return c.json({ error: "Audio file too large (max 10MB)" }, 413);
  }

  const VALID_FORMATS = ["webm", "ogg", "wav", "mp3", "oga", "m4a"];
  const format = (body["format"] as string) ?? "webm";
  if (!VALID_FORMATS.includes(format)) {
    return c.json({ error: `Unsupported audio format: ${format}`, code: "INVALID_FORMAT" }, 400);
  }
  const buffer = new Uint8Array(await file.arrayBuffer());

  try {
    const provider = getSTTProvider();
    const result = await provider.transcribe(buffer, format);
    return c.json({ text: result.text, confidence: result.confidence });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[voice] transcribe error:", msg);

    if (msg.includes("API key not found")) {
      return c.json(
        { error: "OpenAI API key required for voice input", code: "STT_NO_CREDENTIAL" },
        422,
      );
    }
    if (msg.includes("not configured") || msg.includes("not available")) {
      return c.json(
        { error: "Speech-to-text is not configured", code: "STT_NOT_CONFIGURED" },
        503,
      );
    }
    return c.json(
      { error: msg.slice(0, 200), code: "STT_FAILED" },
      502,
    );
  }
});

// GET /api/voice/status — pre-flight check for voice capabilities
app.get("/status", (c) => {
  const hasOpenAIKey = getApiKey("openai") !== null;
  const hasElevenLabsKey = getApiKey("elevenlabs") !== null;
  const sttProvider = getConfig("voice.stt.provider") ?? "whisper-api";

  const localWhisper = getLocalWhisperProvider();
  const localWhisperAvailable = localWhisper.isAvailable();

  return c.json({
    stt: {
      provider: sttProvider,
      alternatives: [
        {
          id: "browser",
          name: "Web Speech API (Browser)",
          description: "Free. Works in Chrome, Edge, Safari. Requires internet.",
          available: true, // client-side only; server can't verify
          needsCredential: null,
        },
        {
          id: "whisper-api",
          name: "Whisper (OpenAI API)",
          description: "High accuracy. Requires OpenAI API key. ~$0.006/min.",
          available: hasOpenAIKey,
          needsCredential: hasOpenAIKey ? null : "openai",
        },
        {
          id: "whisper-local",
          name: "Whisper (Local)",
          description: "Runs on your computer. Free, private. ~40MB download.",
          available: localWhisperAvailable,
          modelStatus: localWhisperAvailable ? "ready" : "not_downloaded",
        },
      ],
    },
    tts: {
      provider: getConfig("voice.tts.provider") ?? null,
      order: resolveTtsProviderOrder(),
      providers: [
        {
          id: "openai",
          name: "OpenAI TTS",
          description: "High quality voices. Requires OpenAI API key. ~$0.015/1K chars.",
          available: hasOpenAIKey,
          needsCredential: hasOpenAIKey ? null : "openai",
        },
        {
          id: "elevenlabs",
          name: "ElevenLabs",
          description: "Premium voices. Requires ElevenLabs API key.",
          available: hasElevenLabsKey,
          needsCredential: hasElevenLabsKey ? null : "elevenlabs",
        },
        {
          id: "edge",
          name: "Edge TTS (Microsoft)",
          description: "Free. Good quality. Requires internet. No API key needed.",
          available: true,
          needsCredential: null,
        },
        {
          id: "piper",
          name: "Piper (Local)",
          description: "Runs on your computer. Free, private, fast. ~30MB download.",
          available: getModelStatus("piper-lessac-medium") === "ready",
          modelStatus: getModelStatus("piper-lessac-medium"),
        },
      ],
    },
  });
});

// GET /api/voice/config
app.get("/config", (c) => {
  return c.json({
    data: {
      ttsMode: getConfig("voice.tts.mode") ?? "inbound",
      ttsProvider: getConfig("voice.tts.provider") ?? null,
      ttsVoice: getConfig("voice.tts.voice") ?? null,
      ttsMaxLength: parseInt(getConfig("voice.tts.maxLength") ?? "1500", 10),
      sttProvider: getConfig("voice.stt.provider") ?? "whisper-api",
    },
  });
});

// PUT /api/voice/config
app.put("/config", async (c) => {
  const body = await c.req.json();

  if (body.ttsMode !== undefined) {
    const valid = ["off", "always", "inbound"];
    if (!valid.includes(body.ttsMode)) {
      return c.json({ error: `ttsMode must be one of: ${valid.join(", ")}` }, 400);
    }
    setConfig("voice.tts.mode", body.ttsMode);
  }
  if (body.ttsProvider !== undefined) {
    const validTts = ["openai", "elevenlabs", "edge", "piper", ""];
    if (!validTts.includes(body.ttsProvider ?? "")) {
      return c.json({ error: `ttsProvider must be one of: ${validTts.filter(Boolean).join(", ")}` }, 400);
    }
    setConfig("voice.tts.provider", body.ttsProvider ?? "");
  }
  if (body.ttsVoice !== undefined) {
    setConfig("voice.tts.voice", body.ttsVoice ?? "");
  }
  if (body.ttsMaxLength !== undefined) {
    setConfig("voice.tts.maxLength", String(Math.max(100, body.ttsMaxLength)));
  }
  if (body.sttProvider !== undefined) {
    const validStt = ["browser", "whisper-api", "whisper-local"];
    if (!validStt.includes(body.sttProvider)) {
      return c.json({ error: `sttProvider must be one of: ${validStt.join(", ")}` }, 400);
    }
    setConfig("voice.stt.provider", body.sttProvider);
  }

  return c.json({ ok: true });
});

// ── Model management ────────────────────────────────────────────

// GET /api/voice/models — list available voice models with download status
app.get("/models", (c) => {
  return c.json({ models: listModels() });
});

// GET /api/voice/models/:id/status — check download progress
app.get("/models/:id/status", (c) => {
  const id = c.req.param("id");
  return c.json(getDownloadProgress(id));
});

// POST /api/voice/models/:id/download — start downloading a model
app.post("/models/:id/download", async (c) => {
  const id = c.req.param("id");
  const status = getModelStatus(id);
  if (status === "ready") {
    return c.json({ ok: true, status: "ready" });
  }
  if (status === "downloading") {
    return c.json({ ok: true, status: "downloading" });
  }

  // Start download in background — don't await, client will poll status
  startDownload(id).catch((err) => {
    console.error(`[voice] model download failed for ${id}:`, err);
  });

  return c.json({ ok: true, status: "downloading" });
});

// DELETE /api/voice/models/:id — remove a downloaded model
app.delete("/models/:id", (c) => {
  const id = c.req.param("id");
  const deleted = deleteModel(id);
  return c.json({ ok: deleted });
});

export default app;
