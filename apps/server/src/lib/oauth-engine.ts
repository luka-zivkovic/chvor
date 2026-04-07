/**
 * Generic OAuth2 PKCE flow handler for direct OAuth connections.
 * Handles authorization URL generation, code exchange, and token refresh.
 * Tokens are stored via the credential-store with AES-256-GCM encryption.
 */

import { randomBytes, createHash } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────

export interface OAuthProviderConfig {
  id: string;
  name: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra query params for the auth URL (e.g. access_type=offline) */
  extraAuthParams?: Record<string, string>;
  /** Extra body params for token exchange */
  extraTokenParams?: Record<string, string>;
  /** Whether client_secret is required even with PKCE */
  requiresSecret?: boolean;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // ISO date
  tokenType?: string;
  scope?: string;
}

export interface PendingOAuthFlow {
  providerId: string;
  codeVerifier: string;
  state: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  createdAt: number;
}

// ── In-memory store for pending flows (10-min TTL) ─────────────────

const pendingFlows = new Map<string, PendingOAuthFlow>();

// Clean up expired flows periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, flow] of pendingFlows) {
    if (now - flow.createdAt > 10 * 60 * 1000) {
      pendingFlows.delete(key);
    }
  }
}, 60_000);

// ── PKCE utilities ─────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  return randomBytes(32)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9\-._~]/g, "")
    .slice(0, 128);
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// ── Flow management ────────────────────────────────────────────────

/**
 * Generate an OAuth authorization URL with PKCE.
 * Stores the pending flow in memory for callback resolution.
 */
export function generateAuthUrl(
  provider: OAuthProviderConfig,
  clientId: string,
  clientSecret: string | undefined,
  redirectUri: string,
): { authUrl: string; state: string } {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Store for callback
  pendingFlows.set(state, {
    providerId: provider.id,
    codeVerifier,
    state,
    clientId,
    clientSecret,
    redirectUri,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: provider.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...provider.extraAuthParams,
  });

  return {
    authUrl: `${provider.authUrl}?${params.toString()}`,
    state,
  };
}

/**
 * Look up a pending flow by state parameter.
 */
export function getPendingFlow(state: string): PendingOAuthFlow | undefined {
  return pendingFlows.get(state);
}

/**
 * Remove a pending flow after successful exchange.
 */
export function removePendingFlow(state: string): void {
  pendingFlows.delete(state);
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(
  provider: OAuthProviderConfig,
  code: string,
  flow: PendingOAuthFlow,
): Promise<OAuthTokens> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.codeVerifier,
    ...provider.extraTokenParams,
  };

  if (flow.clientSecret) {
    body.client_secret = flow.clientSecret;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  // Reddit requires Basic auth for token exchange
  if (provider.id === "reddit") {
    const basic = Buffer.from(`${flow.clientId}:${flow.clientSecret ?? ""}`).toString("base64");
    headers["Authorization"] = `Basic ${basic}`;
  }

  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string | undefined,
    expiresAt: data.expires_in
      ? new Date(Date.now() + (data.expires_in as number) * 1000).toISOString()
      : undefined,
    tokenType: data.token_type as string | undefined,
    scope: data.scope as string | undefined,
  };
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshAccessToken(
  provider: OAuthProviderConfig,
  refreshToken: string,
  clientId: string,
  clientSecret?: string,
): Promise<OAuthTokens> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    ...provider.extraTokenParams,
  };

  if (clientSecret) {
    body.client_secret = clientSecret;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (provider.id === "reddit") {
    const basic = Buffer.from(`${clientId}:${clientSecret ?? ""}`).toString("base64");
    headers["Authorization"] = `Basic ${basic}`;
  }

  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
    expiresAt: data.expires_in
      ? new Date(Date.now() + (data.expires_in as number) * 1000).toISOString()
      : undefined,
    tokenType: data.token_type as string | undefined,
    scope: data.scope as string | undefined,
  };
}
