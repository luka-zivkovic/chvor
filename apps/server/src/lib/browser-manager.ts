import { Stagehand, AISdkClient } from "@browserbasehq/stagehand";
import { lookup } from "node:dns/promises";
import { resolveRoleConfig, createModel } from "./llm-router.ts";
import { getAllowLocalhost } from "../db/config-store.ts";

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

// ---------------------------------------------------------------------------
// SSRF protection — shared with native-tools.ts validateFetchUrl
// ---------------------------------------------------------------------------

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
];

function isPrivateIp(address: string): boolean {
  return PRIVATE_IP_RANGES.some((r) => r.test(address));
}

// ---------------------------------------------------------------------------
// Chromium hardening flags
// ---------------------------------------------------------------------------

const CHROMIUM_HARDENING_ARGS = [
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--js-flags=--max-old-space-size=512",
  "--disable-background-networking",
  "--disable-default-apps",
  "--no-first-run",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isHeadless(): boolean {
  return process.env.CHVOR_BROWSER_HEADLESS !== "false";
}

/**
 * Install a Playwright route handler that intercepts every outgoing request,
 * resolves the target hostname, and aborts requests to private/internal IPs.
 * This prevents SSRF via redirects, JS-initiated navigation, iframes, and XHR.
 */
async function installSsrfGuard(stagehand: Stagehand): Promise<void> {
  await stagehand.page.route("**/*", async (route) => {
    if (getAllowLocalhost()) {
      await route.continue();
      return;
    }

    const url = route.request().url();

    // Skip data: and blob: URLs (no network involved)
    if (url.startsWith("data:") || url.startsWith("blob:")) {
      await route.continue();
      return;
    }

    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Malformed URL — let browser handle the error
      await route.continue();
      return;
    }

    try {
      const { address } = await lookup(hostname);
      if (isPrivateIp(address)) {
        console.warn(`[browser-ssrf] blocked request to private IP ${address} (${hostname}) from ${url}`);
        await route.abort("blockedbyclient");
        return;
      }
    } catch {
      // DNS resolution failed — let the browser handle the network error naturally
      await route.continue();
      return;
    }

    await route.continue();
  });
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

  // Capacity check BEFORE starting init — count both active AND initializing sessions.
  // The current request isn't in either map yet, so use >= to reserve a slot for it.
  if (sessions.size + initializing.size >= MAX_CONCURRENT) {
    // Try to evict the oldest active (fully initialized) session
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
    } else {
      // All slots are occupied by in-flight initializations — nothing to evict
      throw new Error(
        `Browser capacity reached (${MAX_CONCURRENT} concurrent sessions). Try again shortly.`
      );
    }
  }

  const promise = initBrowser(sessionId);
  initializing.set(sessionId, promise);

  try {
    const session = await promise;
    return session.stagehand;
  } finally {
    initializing.delete(sessionId);
  }
}

async function initBrowser(sessionId: string): Promise<BrowserSession> {
  const config = resolveRoleConfig("primary");

  // Use AISdkClient to support ALL Chvor providers (not just the 4 that
  // Stagehand natively maps). createModel() returns a Vercel AI SDK
  // LanguageModelV1 for any configured provider — OpenAI, Anthropic, Google,
  // Groq, DeepSeek, Mistral, Ollama, LM Studio, vLLM, OpenRouter, custom, etc.
  const model = createModel(config);
  const llmClient = new AISdkClient({ model });

  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: {
      headless: isHeadless(),
      args: CHROMIUM_HARDENING_ARGS,
    },
    llmClient,
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

  // Install network-level SSRF guard — intercepts ALL requests including
  // redirects, JS-initiated navigations, iframes, and XHR/fetch from the page.
  await installSsrfGuard(stagehand);

  console.log(
    `[browser-manager] browser started for session ${sessionId} (headless=${isHeadless()}, provider=${config.providerId}, model=${config.model})`
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
