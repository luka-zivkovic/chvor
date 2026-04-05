import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Gateway } from "./gateway/gateway.ts";
import { WSManager } from "./gateway/ws.ts";
import { WebChatChannel } from "./channels/web-chat.ts";
import { TelegramChannel } from "./channels/telegram.ts";
import credentials from "./routes/credentials.ts";
import providers from "./routes/providers.ts";
import skills from "./routes/skills.ts";
import tools from "./routes/tools.ts";
import workspaces from "./routes/workspaces.ts";
import { mcpManager } from "./lib/mcp-manager.ts";
import schedules from "./routes/schedules.ts";
import webhooksRoute from "./routes/webhooks.ts";
import memories from "./routes/memories.ts";
import knowledge from "./routes/knowledge.ts";
import { listStuckResources } from "./db/knowledge-store.ts";
import { ingestResource } from "./lib/knowledge-ingestor.ts";
import persona from "./routes/persona.ts";
import { initScheduler, shutdownScheduler } from "./lib/scheduler.ts";
import { initWebhookExecutor } from "./lib/webhook-executor.ts";
import pulseRoute from "./routes/pulse.ts";
import { initPulse, shutdownPulse } from "./lib/pulse-engine.ts";
import { initDaemon, shutdownDaemon } from "./lib/daemon-engine.ts";
import sessionsRoute from "./routes/sessions.ts";
import llmConfig from "./routes/llm-config.ts";
import modelsConfig from "./routes/models-config.ts";
import { cleanupOrphanedWebSessions } from "./db/session-store.ts";
import { DiscordChannel } from "./channels/discord.ts";
import { SlackChannel } from "./channels/slack.ts";
import { WhatsAppChannel } from "./channels/whatsapp.ts";
import { MatrixChannel } from "./channels/matrix.ts";
import { deleteSensitiveMemories } from "./db/memory-store.ts";
import { chvorAuth } from "./middleware/auth.ts";
import authRoute from "./routes/auth.ts";
import backupRoute from "./routes/backup.ts";
import { isAuthEnabled } from "./db/auth-store.ts";
import { validateSession } from "./db/auth-store.ts";
import { validateApiKey } from "./db/api-key-store.ts";
import { startBackupScheduler, stopBackupScheduler } from "./lib/backup-scheduler.ts";
import { initEmbedder } from "./lib/embedder.ts";
import { backfillEmbeddings } from "./lib/embedding-backfill.ts";
import retentionRoute from "./routes/retention.ts";
import sessionLifecycleRoute from "./routes/session-lifecycle.ts";
import brainConfigRoute from "./routes/brain-config.ts";
import shellConfigRoute from "./routes/shell-config.ts";
import securityConfigRoute from "./routes/security-config.ts";
import templateRoutes from "./routes/templates.ts";
import { runRetentionCleanup, startPeriodicCleanup, stopPeriodicCleanup, startDailyResetCheck, stopDailyResetCheck } from "./lib/session-cleanup.ts";
import { startBrowserSweep, stopBrowserSweep, shutdownAllBrowsers } from "./lib/browser-manager.ts";
import voiceRoute from "./routes/voice.ts";
import whatsappRoute from "./routes/whatsapp.ts";
import activityRoute from "./routes/activity.ts";
import emotionsRoute from "./routes/emotions.ts";
import channelPolicyRoute from "./routes/channel-policy.ts";
import mediaConfigRoute from "./routes/media-config.ts";
import registryRoute from "./routes/registry.ts";
import pcControlRoute from "./routes/pc-control.ts";
import socialRoute from "./routes/social.ts";
import oauthRoute from "./routes/oauth.ts";
import sandboxRoute from "./routes/sandbox.ts";
import daemonRoute from "./routes/daemon.ts";
import { initDocker } from "./lib/sandbox.ts";
import { startOAuthTokenRefresh, stopOAuthTokenRefresh } from "./lib/oauth-token-refresh.ts";
import { handlePcAgentConnection, handlePcAgentMessage, handlePcAgentClose, onPcAgentEvent, onPcFrame, shutdownPcAgents, initLocalBackend } from "./lib/pc-control.ts";
import { getPcControlEnabled } from "./db/config-store.ts";
import { initActivityTable } from "./db/activity-store.ts";
import { initA2UIDb } from "./db/a2ui-store.ts";
import { initDb, closeDb } from "./db/database.ts";
import a2uiRoute from "./routes/a2ui.ts";
import { readAudio, startAudioCleanup, stopAudioCleanup } from "./lib/voice/audio-store.ts";
import { getMediaDir, storeMediaFromBuffer, startMediaCleanup, stopMediaCleanup } from "./lib/media-store.ts";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveApproval } from "./lib/native-tools.ts";
import { rotateOldLogs } from "./lib/error-logger.ts";
import { initManifest, shutdownManifest } from "./lib/health-manifest.ts";
import { initKeepAwake, shutdownKeepAwake } from "./lib/keep-awake.ts";
import { startSkillWatcher, stopSkillWatcher } from "./lib/skill-watcher.ts";
import { startAutoUpdate, stopAutoUpdate } from "./lib/registry-updater.ts";
import { startMemoryDecay, stopMemoryDecay } from "./lib/memory-decay.ts";
import { startConsolidation, stopConsolidation } from "./lib/memory-consolidation.ts";
import { initJobRunner, stopAllPeriodicJobs } from "./lib/job-runner.ts";
import { reloadAll } from "./lib/capability-loader.ts";
import { homedir } from "node:os";

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

import { setWSInstance } from "./gateway/ws-instance.ts";

// --- Gateway setup ---
const wsManager = new WSManager();
setWSInstance(wsManager);
const gateway = new Gateway();
const webChat = new WebChatChannel(wsManager);

const telegram = new TelegramChannel();
const discord = new DiscordChannel();
const slack = new SlackChannel();
const whatsappChannel = new WhatsAppChannel();
const matrix = new MatrixChannel();

gateway.registerChannel(webChat);
gateway.registerChannel(telegram);
gateway.registerChannel(discord);
gateway.registerChannel(slack);
gateway.registerChannel(whatsappChannel);
gateway.registerChannel(matrix);

// Wire WhatsApp QR + status events to broadcast via WebSocket
whatsappChannel.onQR((qrDataUrl) => {
  wsManager.broadcast({ type: "whatsapp.qr", data: { qrDataUrl } });
});
whatsappChannel.onStatus((status, phoneNumber) => {
  wsManager.broadcast({ type: "whatsapp.status", data: { status, phoneNumber } });
});

// Forward gateway events — execution events broadcast to all, everything else targeted only
gateway.on("event", (event: import("@chvor/shared").GatewayServerEvent, targetClientId?: string) => {
  if (event.type === "execution.event") {
    // Execution events always broadcast (canvas animations)
    wsManager.broadcast(event);
  } else if (targetClientId) {
    // Targeted event from a web client — send to that client only
    wsManager.sendTo(targetClientId, event);
  } else {
    // No target client — non-web channel (telegram/discord/slack/whatsapp).
    // Drop to prevent chat/voice events leaking to Canvas clients.
    return;
  }
});

// Route WS client messages to the right channel
wsManager.onClientMessage((clientId, event) => {
  switch (event.type) {
    case "session.init": {
      const sessionId = event.data.sessionId;
      if (!wsManager.setSessionId(clientId, sessionId)) {
        wsManager.sendTo(clientId, { type: "error", data: { message: "Invalid session ID format" } });
        break;
      }
      wsManager.sendTo(clientId, { type: "session.ack", data: { sessionId } });
      break;
    }
    case "chat.send": {
      const sessionId = wsManager.getSessionId(clientId);
      webChat.handleClientMessage(
        clientId,
        event.data.text,
        event.data.workspaceId,
        sessionId ?? undefined,
        event.data.inputModality,
        event.data.media
      );
      break;
    }
    case "chat.stop": {
      const sessionId = wsManager.getSessionId(clientId);
      if (sessionId) {
        gateway.abortSession(`web:${sessionId}:default`);
      }
      break;
    }
    case "canvas.subscribe":
      // TODO Phase 4: track per-workspace subscriptions
      break;
    case "command.respond": {
      const resolved = resolveApproval(event.data.requestId, event.data.approved, !!event.data.alwaysAllow);
      if (!resolved) {
        wsManager.sendTo(clientId, {
          type: "error",
          data: { message: "No pending approval with that ID (may have timed out)" },
        });
      }
      break;
    }
  }
});

// --- Middleware ---
app.use("/*", cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : "http://localhost:5173",
  credentials: true,
}));

// Serve media artifacts BEFORE auth — <img> tags can't send Authorization headers
app.get("/api/media/:filename", async (c) => {
  const filename = c.req.param("filename");
  if (!/^[a-f0-9-]+\.\w+$/.test(filename)) {
    return c.json({ error: "Invalid filename" }, 400);
  }
  const safe = basename(filename);
  const filePath = join(getMediaDir(), safe);
  if (!existsSync(filePath)) {
    return c.json({ error: "Not found" }, 404);
  }
  const data = await readFile(filePath);
  const ext = safe.split(".").pop() ?? "";
  const contentTypes: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", mp3: "audio/mpeg", wav: "audio/wav",
    ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf",
    json: "application/json", txt: "text/plain",
  };
  const ct = contentTypes[ext] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": ct,
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  };
  if (ext === "svg") {
    headers["Content-Security-Policy"] = "sandbox";
  }
  return new Response(data, { headers });
});

app.use("/api/*", chvorAuth);

// Upload media artifacts (images, video) — returns MediaArtifact JSON
// Placed AFTER chvorAuth so uploads require authentication
app.post("/api/media/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || !(file instanceof File)) {
    return c.json({ error: "Missing file field" }, 400);
  }
  const maxBytes = 20 * 1024 * 1024; // 20 MB (video limit)
  if (file.size > maxBytes) {
    return c.json({ error: `File too large (${file.size} bytes, max ${maxBytes})` }, 413);
  }
  const mimeType = file.type || "application/octet-stream";
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const artifact = storeMediaFromBuffer(buffer, mimeType, file.name || undefined);
    return c.json(artifact, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Upload failed" }, 400);
  }
});

// --- Routes ---
app.get("/api/health", (c) =>
  c.json({ ok: true, timestamp: new Date().toISOString() })
);

app.route("/api/credentials", credentials);
app.route("/api/providers", providers);
app.route("/api/skills", skills);
app.route("/api/tools", tools);
app.route("/api/workspaces", workspaces);
app.route("/api/schedules", schedules);
app.route("/api/webhooks", webhooksRoute);
app.route("/api/memories", memories);
app.route("/api/knowledge", knowledge);
app.route("/api/persona", persona);
app.route("/api/pulse", pulseRoute);
app.route("/api/sessions", sessionsRoute);
app.route("/api/config/llm", llmConfig);
app.route("/api/config/models", modelsConfig);
app.route("/api/config/retention", retentionRoute);
app.route("/api/config/brain", brainConfigRoute);
app.route("/api/config/shell", shellConfigRoute);
app.route("/api/config/security", securityConfigRoute);
app.route("/api/templates", templateRoutes);
app.route("/api/config/session-lifecycle", sessionLifecycleRoute);
app.route("/api/voice", voiceRoute);
app.route("/api/whatsapp", whatsappRoute);
app.route("/api/activity", activityRoute);
app.route("/api/emotions", emotionsRoute);
app.route("/api/channels", channelPolicyRoute);
app.route("/api/config/media", mediaConfigRoute);
app.route("/api/registry", registryRoute);
app.route("/api/a2ui", a2uiRoute);
app.route("/api/auth", authRoute);
app.route("/api/backup", backupRoute);
app.route("/api/pc", pcControlRoute);
app.route("/api/social", socialRoute);
app.route("/api/oauth", oauthRoute);
app.route("/api/config/sandbox", sandboxRoute);
app.route("/api/daemon", daemonRoute);

// Serve TTS audio files (no auth — ephemeral UUIDs)
app.get("/audio/:filename", (c) => {
  const filename = c.req.param("filename");
  const id = filename.replace(/\.[^.]+$/, ""); // strip extension
  const result = readAudio(id);
  if (!result) return c.notFound();

  const mimeMap: Record<string, string> = {
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    opus: "audio/opus",
  };
  c.header("Content-Type", mimeMap[result.ext] ?? "application/octet-stream");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(result.data as unknown as ArrayBuffer);
});

// PC Agent WebSocket endpoint
// Generate a session token if CHVOR_TOKEN is not set (unless explicitly opted out)
const pcAgentToken: string | null = (() => {
  if (process.env.CHVOR_TOKEN) return process.env.CHVOR_TOKEN;
  if (process.env.CHVOR_PC_NO_AUTH === "true") {
    console.warn("[pc-control] WARNING: CHVOR_PC_NO_AUTH=true — PC agent endpoint is unauthenticated");
    return null;
  }
  const generated = crypto.randomUUID();
  console.log(`[pc-control] No CHVOR_TOKEN set — generated session token: ${generated}`);
  console.log(`[pc-control] Use: npx @chvor/pc-agent --server ws://localhost:${process.env.PORT ?? 9147}/ws/pc-agent --token ${generated}`);
  return generated;
})();
app.get(
  "/ws/pc-agent",
  upgradeWebSocket((c) => {
    const wsToken = new URL(c.req.url).searchParams.get("token");
    const authorized = !pcAgentToken || wsToken === pcAgentToken;

    let agentId: string;
    return {
      onOpen(_, ws) {
        if (!getPcControlEnabled()) {
          ws.close(4002, "PC Control is disabled");
          return;
        }
        if (!authorized) {
          ws.close(4001, "Unauthorized");
          return;
        }
        agentId = handlePcAgentConnection(ws);
      },
      onMessage(event) {
        if (!authorized || !agentId) return;
        handlePcAgentMessage(agentId, String(event.data));
      },
      onClose() {
        if (agentId) handlePcAgentClose(agentId);
      },
    };
  })
);

// Broadcast PC agent connect/disconnect events to UI clients
onPcAgentEvent((event, agent) => {
  if (event === "connected") {
    wsManager.broadcast({ type: "pc.connected", data: agent });
  } else {
    wsManager.broadcast({ type: "pc.disconnected", data: { id: agent.id } });
  }
});

// Stream PC screenshots to UI clients (throttle: max 1 frame/sec per agent)
const lastFrameTime = new Map<string, number>();
onPcFrame((agentId, screenshot) => {
  const now = Date.now();
  const last = lastFrameTime.get(agentId) ?? 0;
  if (now - last < 1000) return; // skip if <1s since last broadcast
  lastFrameTime.set(agentId, now);
  wsManager.broadcast({
    type: "pc.frame",
    data: { agentId, screenshot: screenshot.data, width: screenshot.width, height: screenshot.height, mimeType: screenshot.mimeType ?? "image/jpeg" },
  });
});

// WebSocket endpoint
app.get(
  "/ws",
  upgradeWebSocket((c) => {
    // Auth check: cookie first, then ?token= query param
    let authorized = !isAuthEnabled();
    if (!authorized) {
      const cookieHeader = c.req.header("Cookie") ?? "";
      const cookieMatch = cookieHeader.match(/chvor_session=([^;]+)/);
      const cookieToken = cookieMatch?.[1];
      const queryToken = new URL(c.req.url).searchParams.get("token");
      const authToken = cookieToken || queryToken;
      if (authToken) {
        if (authToken.startsWith("chvor_")) {
          authorized = validateApiKey(authToken).valid;
        } else {
          authorized = validateSession(authToken).valid;
        }
      }
    }

    let clientId: string;
    return {
      onOpen(_, ws) {
        if (!authorized) {
          ws.close(4001, "Unauthorized");
          return;
        }
        clientId = wsManager.handleConnection(ws);
      },
      onMessage(event) {
        if (!authorized) return;
        wsManager.handleMessage(clientId, String(event.data));
      },
      onClose() {
        if (clientId) wsManager.handleClose(clientId);
      },
    };
  })
);

// --- Static file serving (production) ---
if (process.env.NODE_ENV === "production") {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const clientDist = resolve(__dirname, "../../client/dist");

  // Serve static assets
  app.get("/*", async (c, next) => {
    const urlPath = new URL(c.req.url).pathname;
    // Skip API routes, WebSocket, and audio routes
    if (urlPath.startsWith("/api") || urlPath.startsWith("/ws") || urlPath.startsWith("/audio")) {
      return next();
    }
    const filePath = join(clientDist, urlPath === "/" ? "index.html" : urlPath);
    if (existsSync(filePath)) {
      const data = await readFile(filePath);
      const ext = filePath.split(".").pop() ?? "";
      const mimeTypes: Record<string, string> = {
        html: "text/html", js: "application/javascript", css: "text/css",
        json: "application/json", png: "image/png", jpg: "image/jpeg",
        jpeg: "image/jpeg", svg: "image/svg+xml", ico: "image/x-icon",
        woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
      };
      return new Response(data, {
        headers: {
          "Content-Type": mimeTypes[ext] ?? "application/octet-stream",
          "Cache-Control": ext === "html" ? "no-cache" : "public, max-age=31536000, immutable",
        },
      });
    }
    // SPA fallback — serve index.html for unmatched routes
    const html = await readFile(join(clientDist, "index.html"));
    return new Response(html, {
      headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
    });
  });
}

// --- Start ---
const port = parseInt(process.env.PORT ?? "9147", 10);

// Warn if no LLM provider is configured
const hasLLM = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY;
if (!hasLLM) {
  console.warn("[chvor] No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY in .env");
}

// Initialize database adapter (required for PostgreSQL; lazy-inits for SQLite)
await initDb();

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`[chvor] server running at http://localhost:${port}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[chvor] Port ${port} is already in use. Another instance may be running, or another application is using this port.`);
    console.error(`[chvor] Try a different port: PORT=<number> chvor start`);
    process.exit(1);
  }
  throw err;
});

injectWebSocket(server);

gateway.startAll();

// Rotate old error logs (at startup + daily)
rotateOldLogs();
const logRotationTimer = setInterval(() => rotateOldLogs(), 24 * 60 * 60 * 1000);

// Purge any sensitive data accidentally stored as memories
const purged = deleteSensitiveMemories();
if (purged > 0) console.log(`[memory] purged ${purged} sensitive memor${purged === 1 ? "y" : "ies"}`);

// Clean up orphaned ephemeral web sessions (ws-N format) from before persistent session IDs
const cleanedOrphans = cleanupOrphanedWebSessions();
if (cleanedOrphans > 0) console.log(`[sessions] cleaned ${cleanedOrphans} orphaned web session(s)`);

// Configurable session retention (replaces hardcoded 7-day cleanup)
runRetentionCleanup().catch((err) => console.error("[retention] cleanup failed:", err));
startPeriodicCleanup();
startDailyResetCheck();

// Initialize embedder if model already cached, then backfill (fire-and-forget)
initEmbedder()
  .then(() => backfillEmbeddings())
  .then(() => {
    // Re-queue resources stuck in pending/processing from a previous crash
    const stuck = listStuckResources();
    if (stuck.length > 0) {
      console.log(`[knowledge] re-queuing ${stuck.length} stuck resource(s)`);
      for (const r of stuck) {
        ingestResource(r.id).catch((err: unknown) =>
          console.error(`[knowledge] recovery ingestion failed for ${r.id}:`, err),
        );
      }
    }
  })
  .catch((err) => console.error("[embedder] init/backfill failed:", err));
initActivityTable();
initA2UIDb();
const channelSenderFn = (ct: string, cid: string, text: string, tid?: string) =>
  gateway.sendToChannel(ct, cid, text, tid);
initScheduler(wsManager, channelSenderFn).catch((err) =>
  console.error("[scheduler] init failed:", err)
);
initWebhookExecutor(wsManager, channelSenderFn);
initDaemon(wsManager).catch((err) =>
  console.error("[daemon] init failed:", err)
);

// Initialize local PC backend if available (fire-and-forget)
initLocalBackend().catch((err) => console.error("[pc-control] local backend init failed:", err));

// Initialize Docker sandbox detection (fire-and-forget)
initDocker().catch((err) => console.error("[sandbox] Docker detection failed:", err));

startBrowserSweep();
startAudioCleanup();
startMediaCleanup();

// Initialize persistent job runner (resets stuck jobs from previous crash)
initJobRunner();
startMemoryDecay();
startConsolidation();
initManifest();
initKeepAwake();

// Hot-reload: watch skill/tool directories for .md file changes
const skillsDir = process.env.CHVOR_SKILLS_DIR || join(homedir(), ".chvor", "skills");
const toolsDir = process.env.CHVOR_TOOLS_DIR || join(homedir(), ".chvor", "tools");
startSkillWatcher([skillsDir, toolsDir], () => {
  reloadAll();
  wsManager.broadcast({ type: "skills.reloaded", data: {} });
});

// Registry auto-update: check for skill updates periodically
startAutoUpdate((event) => wsManager.broadcast(event));
startBackupScheduler();
startOAuthTokenRefresh();

// Graceful shutdown — clean up MCP child processes and browser sessions
process.on("SIGINT", async () => {
  console.log("[chvor] shutting down...");
  clearInterval(logRotationTimer);
  shutdownKeepAwake();
  shutdownScheduler();
  // Daemon shutdown moved after gateway/MCP so running tasks can still use them
  shutdownManifest();
  stopPeriodicCleanup();
  stopDailyResetCheck();
  stopBrowserSweep();
  stopOAuthTokenRefresh();
  stopAudioCleanup();
  stopSkillWatcher();
  stopAutoUpdate();
  stopMediaCleanup();
  stopAllPeriodicJobs();
  await shutdownAllBrowsers();
  shutdownPcAgents();
  shutdownDaemon();
  await gateway.stopAll();
  await mcpManager.shutdown();
  closeDb();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[chvor] shutting down...");
  clearInterval(logRotationTimer);
  shutdownKeepAwake();
  shutdownScheduler();
  shutdownManifest();
  stopPeriodicCleanup();
  stopDailyResetCheck();
  stopBrowserSweep();
  stopOAuthTokenRefresh();
  stopAudioCleanup();
  stopSkillWatcher();
  stopAutoUpdate();
  stopMediaCleanup();
  stopAllPeriodicJobs();
  await shutdownAllBrowsers();
  shutdownPcAgents();
  shutdownDaemon();
  await gateway.stopAll();
  await mcpManager.shutdown();
  closeDb();
  process.exit(0);
});
