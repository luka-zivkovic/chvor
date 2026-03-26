import { Stagehand } from "@browserbasehq/stagehand";
import { resolveConfig } from "./llm-router.ts";

interface BrowserSession {
  stagehand: Stagehand;
  lastUsed: number;
}

const sessions = new Map<string, BrowserSession>();
const initializing = new Map<string, Promise<BrowserSession>>();

const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const SWEEP_INTERVAL = 60 * 1000; // 60 seconds
const MAX_CONCURRENT = 3;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function isHeadless(): boolean {
  return process.env.CHVOR_BROWSER_HEADLESS !== "false";
}

/** Map Chvor provider ID to Stagehand's "provider/model" format. */
function toStagehandModel(providerId: string, model: string): string {
  // Stagehand expects "provider/model" format (e.g. "anthropic/claude-sonnet-4-6")
  if (model.includes("/")) return model; // already prefixed
  const PROVIDER_PREFIX: Record<string, string> = {
    openai: "openai",
    anthropic: "anthropic",
    "google-ai": "google",
    groq: "groq",
  };
  const prefix = PROVIDER_PREFIX[providerId];
  if (!prefix) {
    throw new Error(
      `Unsupported provider "${providerId}" for browser agent. Supported: ${Object.keys(PROVIDER_PREFIX).join(", ")}`
    );
  }
  return `${prefix}/${model}`;
}

/**
 * Get or create a Stagehand browser session for the given session ID.
 * Concurrent calls for the same session are deduplicated.
 */
export async function getBrowser(sessionId: string): Promise<Stagehand> {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.stagehand;
  }

  // Dedup: return in-flight init if one exists
  const inflight = initializing.get(sessionId);
  if (inflight) {
    const session = await inflight;
    session.lastUsed = Date.now();
    return session.stagehand;
  }

  // Register the init promise BEFORE eviction to prevent double-init race
  const promise = initBrowser(sessionId);
  initializing.set(sessionId, promise);

  // Evict oldest if at capacity
  if (sessions.size >= MAX_CONCURRENT) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, s] of sessions) {
      if (s.lastUsed < oldestTime) {
        oldestTime = s.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId) {
      console.log(`[browser-manager] evicting oldest session: ${oldestId}`);
      await closeBrowser(oldestId);
    }
  }

  try {
    const session = await promise;
    return session.stagehand;
  } finally {
    initializing.delete(sessionId);
  }
}

async function initBrowser(sessionId: string): Promise<BrowserSession> {
  const config = resolveConfig();
  const stagehandModel = toStagehandModel(config.providerId, config.model);

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: {
      headless: isHeadless(),
    },
    modelName: stagehandModel,
    modelClientOptions: {
      apiKey: config.apiKey,
    },
  });

  try {
    await stagehand.init();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("Executable doesn't exist") ||
      msg.includes("ENOENT")
    ) {
      throw new Error(
        "Browser engine (Chromium) not found. " +
          "Run `npx playwright install chromium` to install it, then try again."
      );
    }
    throw err;
  }
  console.log(
    `[browser-manager] browser started for session ${sessionId} (headless=${isHeadless()}, model=${stagehandModel})`
  );

  const session: BrowserSession = { stagehand, lastUsed: Date.now() };
  sessions.set(sessionId, session);
  return session;
}

/** Close and clean up a single browser session. */
export async function closeBrowser(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  try {
    await session.stagehand.close();
    console.log(`[browser-manager] closed browser for session ${sessionId}`);
  } catch (err) {
    console.error(`[browser-manager] error closing browser for ${sessionId}:`, err);
  }
}

/** Get count of active browser sessions (for diagnosis tool). */
export function getActiveBrowserCount(): number {
  return sessions.size;
}

/** Close all browser sessions (for server shutdown). */
export async function shutdownAllBrowsers(): Promise<void> {
  const ids = [...sessions.keys()];
  if (ids.length === 0) return;
  console.log(`[browser-manager] shutting down ${ids.length} browser(s)...`);
  await Promise.allSettled(ids.map((id) => closeBrowser(id)));
}

/** Start periodic sweep to close inactive browser sessions. */
export function startBrowserSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    // Snapshot IDs first to avoid mutating the map during iteration
    const toClose = [...sessions.entries()]
      .filter(([, s]) => now - s.lastUsed > INACTIVITY_TIMEOUT)
      .map(([id]) => id);
    for (const id of toClose) {
      console.log(`[browser-manager] sweeping inactive session: ${id}`);
      closeBrowser(id).catch((err) =>
        console.error("[browser-manager] sweep close error:", err)
      );
    }
  }, SWEEP_INTERVAL);
}

/** Stop the periodic browser sweep. */
export function stopBrowserSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
