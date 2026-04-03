/**
 * Background job that periodically refreshes expiring OAuth tokens.
 * Runs every 30 minutes, refreshes tokens expiring within 10 minutes.
 */

import { listCredentials, getCredentialData, updateCredential } from "../db/credential-store.ts";
import { getDirectOAuthProvider } from "./oauth-providers.ts";
import { refreshAccessToken } from "./oauth-engine.ts";

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const EXPIRY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes before expiry

let intervalId: ReturnType<typeof setInterval> | null = null;

async function refreshExpiringTokens(): Promise<void> {
  const creds = listCredentials();
  const oauthCreds = creds.filter((c) => c.type.startsWith("oauth-token-"));

  const now = Date.now();

  for (const cred of oauthCreds) {
    try {
      const data = getCredentialData(cred.id);
      if (!data) continue;

      const d = data.data as Record<string, string>;
      if (!d.refreshToken || !d.expiresAt || !d.provider) continue;

      const expiresAt = new Date(d.expiresAt).getTime();
      if (expiresAt - now > EXPIRY_THRESHOLD_MS) continue; // not expiring soon

      const providerConfig = getDirectOAuthProvider(d.provider);
      if (!providerConfig) continue;

      console.log(`[oauth-refresh] refreshing token for ${d.provider} (expires ${d.expiresAt})`);

      const tokens = await refreshAccessToken(
        providerConfig,
        d.refreshToken,
        d.clientId,
        d.clientSecret,
      );

      const updated: Record<string, string> = {
        ...d,
        accessToken: tokens.accessToken,
      };
      if (tokens.refreshToken) updated.refreshToken = tokens.refreshToken;
      if (tokens.expiresAt) updated.expiresAt = tokens.expiresAt;

      updateCredential(cred.id, cred.name, updated);
      console.log(`[oauth-refresh] refreshed ${d.provider} token, new expiry: ${tokens.expiresAt}`);
    } catch (err) {
      console.error(`[oauth-refresh] failed to refresh ${cred.type}:`, err instanceof Error ? err.message : err);
    }
  }
}

export function startOAuthTokenRefresh(): void {
  if (intervalId) return;
  // Run once on startup after a short delay
  setTimeout(() => {
    refreshExpiringTokens().catch(() => {});
  }, 5000);
  intervalId = setInterval(() => {
    refreshExpiringTokens().catch(() => {});
  }, REFRESH_INTERVAL_MS);
  console.log("[oauth-refresh] token refresh scheduler started (every 30m)");
}

export function stopOAuthTokenRefresh(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
