import posthog from "posthog-js";
import { api } from "./api";

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST as string | undefined;

declare const __APP_VERSION__: string;

let initialized = false;
let initPromise: Promise<void> | null = null;

function doInit(distinctId: string): void {
  if (!POSTHOG_KEY || !POSTHOG_HOST) return;

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    autocapture: false,
    capture_pageview: false,
    persistence: "memory",
    disable_session_recording: true,
    ip: false,
    property_denylist: [
      "$current_url",
      "$pathname",
      "$host",
      "$referrer",
      "$referring_domain",
    ],
  });

  posthog.identify(distinctId);

  posthog.register({
    app_version: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "unknown",
    deployment: "window" in globalThis && "__TAURI_INTERNALS__" in window
      ? "desktop"
      : "web",
  });

  initialized = true;
}

/**
 * Initialize analytics. Safe to call multiple times — only the first call
 * does work. PostHog is NOT initialized when analytics is disabled (no
 * network calls at all).
 */
export async function initAnalytics(): Promise<void> {
  if (initialized || initPromise) return;
  if (import.meta.env.DEV || !POSTHOG_KEY || !POSTHOG_HOST) return;

  initPromise = (async () => {
    try {
      const config = await api.telemetry.get();
      if (!config.enabled) return; // Don't init PostHog at all when disabled
      doInit(config.distinctId);
    } catch {
      // Analytics should never break the app
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Toggle analytics on/off. When enabling for the first time, lazily
 * initializes PostHog.
 */
export async function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  if (enabled && !initialized) {
    // Lazy init: user just opted in for the first time
    try {
      const config = await api.telemetry.get();
      doInit(config.distinctId);
    } catch {
      return;
    }
  }

  if (!initialized) return;

  if (enabled) {
    posthog.opt_in_capturing();
  } else {
    posthog.opt_out_capturing();
  }
}

export function trackEvent(
  name: string,
  properties?: Record<string, string | number | boolean>,
): void {
  if (!initialized) return;
  try {
    posthog.capture(name, properties);
  } catch {
    // Analytics should never break the app
  }
}
