/**
 * Unified OAuth routes — handles both direct OAuth (PKCE) and Composio connections.
 */

import { Hono } from "hono";
import { OAUTH_PROVIDERS } from "../lib/provider-registry.ts";
import { getDirectOAuthProvider } from "../lib/oauth-providers.ts";
import {
  generateAuthUrl,
  getPendingFlow,
  removePendingFlow,
  exchangeCode,
  refreshAccessToken,
  type OAuthProviderConfig,
} from "../lib/oauth-engine.ts";
import {
  initiateConnection as composioInitiate,
  listConnectedAccounts as composioListConnected,
  disconnectAccount as composioDisconnect,
} from "../lib/composio-client.ts";
import {
  listCredentials,
  getCredentialData,
  createCredential,
  updateCredential,
  deleteCredential,
} from "../db/credential-store.ts";
import type { OAuthConnection, OAuthMethod } from "@chvor/shared";
import { assertSafeUrl } from "../lib/url-safety.ts";

const oauth = new Hono();

const PORT = Number(process.env.PORT ?? 9147);
const CALLBACK_URL = process.env.OAUTH_CALLBACK_URL ?? `http://localhost:${PORT}/api/oauth/callback`;

// ── Helpers ─────────────────────────────────────────────────────

/** Look up clientSecret from the provider's setup credential (not from the token credential). */
export function getClientSecretForProvider(providerId: string): string | undefined {
  const providerDef = OAUTH_PROVIDERS.find((p) => p.id === providerId);
  if (!providerDef?.setupCredentialType) return undefined;
  const creds = listCredentials();
  const cred = creds.find((c) => c.type === providerDef.setupCredentialType);
  if (!cred) return undefined;
  const data = getCredentialData(cred.id);
  if (!data) return undefined;
  return (data.data as Record<string, string>).clientSecret;
}

function hasComposioKey(): boolean {
  const creds = listCredentials();
  return creds.some((c) => c.type === "composio");
}

function getDirectOAuthCredentials(
  providerDef: (typeof OAUTH_PROVIDERS)[0],
): { clientId: string; clientSecret?: string } | null {
  if (!providerDef.setupCredentialType) return null;
  const creds = listCredentials();
  const cred = creds.find((c) => c.type === providerDef.setupCredentialType);
  if (!cred) return null;
  const data = getCredentialData(cred.id);
  if (!data) return null;
  const d = data.data as Record<string, string>;
  if (!d.clientId) return null;
  return { clientId: d.clientId, clientSecret: d.clientSecret };
}

function getDirectOAuthConnections(): OAuthConnection[] {
  const creds = listCredentials();
  return creds
    .filter((c) => c.type.startsWith("oauth-token-"))
    .map((c) => {
      const data = getCredentialData(c.id);
      const d = (data?.data ?? {}) as Record<string, string>;
      const platform = c.type.replace("oauth-token-", "");
      const expiresAt = d.expiresAt;
      let status: OAuthConnection["status"] = "active";
      if (expiresAt && new Date(expiresAt) < new Date()) {
        status = d.refreshToken ? "expired" : "failed";
      }
      return {
        id: c.id,
        platform,
        method: "direct" as OAuthMethod,
        status,
        connectedAt: c.createdAt,
        credentialId: c.id,
      };
    });
}

// ── GET /providers — list all OAuth providers with status ────────

oauth.get("/providers", async (c) => {
  const directConns = getDirectOAuthConnections();
  let composioConns: OAuthConnection[] = [];

  if (hasComposioKey()) {
    try {
      const accounts = await composioListConnected();
      composioConns = accounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        method: "composio" as OAuthMethod,
        status: a.status === "active" ? "active" : "pending",
        connectedAt: a.connectedAt,
      }));
    } catch (err) {
      console.warn("[oauth] Composio unavailable:", err instanceof Error ? err.message : err);
    }
  }

  const allConnections = [...directConns, ...composioConns];

  const providers = OAUTH_PROVIDERS.map((p) => ({
    ...p,
    connected: allConnections.some((c) => c.platform === p.id && c.status === "active"),
    hasSetupCredentials: p.method === "direct"
      ? getDirectOAuthCredentials(p) !== null
      : hasComposioKey(),
  }));

  return c.json({
    providers,
    connections: allConnections,
    hasComposioKey: hasComposioKey(),
  });
});

// ── POST /initiate — start an OAuth flow ─────────────────────────

oauth.post("/initiate", async (c) => {
  const { provider: providerId } = await c.req.json<{ provider: string }>();
  const providerDef = OAUTH_PROVIDERS.find((p) => p.id === providerId);
  if (!providerDef) {
    return c.json({ error: `Unknown OAuth provider: ${providerId}` }, 400);
  }

  if (providerDef.method === "composio") {
    // --- Composio flow ---
    if (!hasComposioKey()) {
      return c.json({ error: "Composio API key required. Add it in Settings > Integrations." }, 400);
    }
    try {
      const result = await composioInitiate(
        providerDef.composioToolkit!,
        CALLBACK_URL,
      );
      return c.json({
        redirectUrl: result.redirectUrl,
        connectionId: result.connectedAccountId,
        method: "composio",
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // --- Direct OAuth flow ---
  const directConfig = getDirectOAuthProvider(providerId);
  if (!directConfig) {
    return c.json({ error: `No direct OAuth config for: ${providerId}` }, 400);
  }

  const appCreds = getDirectOAuthCredentials(providerDef);
  if (!appCreds) {
    return c.json({
      error: `No ${providerDef.name} app credentials configured. Add your Client ID${directConfig.requiresSecret ? " and Client Secret" : ""} first.`,
      needsSetup: true,
      setupCredentialType: providerDef.setupCredentialType,
    }, 400);
  }

  const { authUrl, state } = generateAuthUrl(
    directConfig,
    appCreds.clientId,
    appCreds.clientSecret,
    CALLBACK_URL,
  );

  return c.json({
    redirectUrl: authUrl,
    connectionId: state,
    method: "direct",
  });
});

// ── GET /callback — OAuth callback handler ───────────────────────

oauth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  // Handle Composio callbacks (they use 'status' param)
  const composioStatus = c.req.query("status");
  if (composioStatus) {
    const success = composioStatus === "success" || composioStatus === "active";
    return c.html(callbackHtml(success, success ? "Account Connected!" : "Connection Failed"));
  }

  // Handle direct OAuth callbacks
  if (error) {
    return c.html(callbackHtml(false, `OAuth error: ${error}`));
  }

  if (!code || !state) {
    return c.html(callbackHtml(false, "Missing authorization code or state parameter."));
  }

  const flow = getPendingFlow(state);
  if (!flow) {
    return c.html(callbackHtml(false, "OAuth session expired. Please try again."));
  }

  // Inline provider (synthesized-OAuth wizard) takes precedence over the
  // built-in registry — that's how user-supplied OAuth services work.
  const providerConfig = flow.inlineProvider ?? getDirectOAuthProvider(flow.providerId);
  if (!providerConfig) {
    removePendingFlow(state);
    return c.html(callbackHtml(false, `Unknown provider: ${flow.providerId}`));
  }

  try {
    const tokens = await exchangeCode(providerConfig, code, flow);
    removePendingFlow(state);

    // Store tokens as a credential. For synthesized OAuth the credentialType
    // comes from the flow (the AI's chosen slug, e.g. "quickbooks") so the
    // synthesized-caller can find the credential by the same key it requested.
    const credType = flow.credentialType ?? `oauth-token-${flow.providerId}`;
    const existingCreds = listCredentials();
    const existing = existingCreds.find((cr) => cr.type === credType);

    const credData: Record<string, string> = {
      accessToken: tokens.accessToken,
      provider: flow.providerId,
      clientId: flow.clientId,
    };
    if (tokens.refreshToken) credData.refreshToken = tokens.refreshToken;
    if (tokens.expiresAt) credData.expiresAt = tokens.expiresAt;
    if (tokens.scope) credData.scope = tokens.scope;
    // For synthesized OAuth we *do* persist clientSecret + token/auth URLs so
    // the refresh path can run without a separate setup credential.
    if (flow.inlineProvider) {
      if (flow.clientSecret) credData.clientSecret = flow.clientSecret;
      credData.tokenUrl = flow.inlineProvider.tokenUrl;
      credData.authUrl = flow.inlineProvider.authUrl;
      if (flow.inlineProvider.scopes.length) {
        credData.scopes = flow.inlineProvider.scopes.join(" ");
      }
    }

    const friendlyName = flow.inlineProviderName
      ?? OAUTH_PROVIDERS.find((p) => p.id === flow.providerId)?.name
      ?? flow.providerId;

    if (existing) {
      updateCredential(existing.id, existing.name, credData);
    } else {
      createCredential(
        `${friendlyName} (OAuth)`,
        credType,
        credData,
      );
    }

    return c.html(callbackHtml(true, "Account Connected!"));
  } catch (err) {
    removePendingFlow(state);
    const msg = err instanceof Error ? err.message : String(err);
    return c.html(callbackHtml(false, `Token exchange failed: ${msg}`));
  }
});

// ── GET /connections — list all OAuth connections ─────────────────

oauth.get("/connections", async (c) => {
  const directConns = getDirectOAuthConnections();
  let composioConns: OAuthConnection[] = [];

  if (hasComposioKey()) {
    try {
      const accounts = await composioListConnected();
      composioConns = accounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        method: "composio" as OAuthMethod,
        status: a.status === "active" ? "active" : "pending",
        connectedAt: a.connectedAt,
      }));
    } catch (err) {
      console.warn("[oauth] Composio list failed:", err instanceof Error ? err.message : err);
    }
  }

  return c.json([...directConns, ...composioConns]);
});

// ── DELETE /connections/:id — disconnect ──────────────────────────

oauth.delete("/connections/:id", async (c) => {
  const id = c.req.param("id");

  // Check if it's a local credential (direct OAuth)
  const creds = listCredentials();
  const localCred = creds.find((cr) => cr.id === id);
  if (localCred && localCred.type.startsWith("oauth-token-")) {
    deleteCredential(id);
    return c.json({ disconnected: true, method: "direct" });
  }

  // Otherwise try Composio
  if (hasComposioKey()) {
    try {
      await composioDisconnect(id);
      return c.json({ disconnected: true, method: "composio" });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  return c.json({ error: "Connection not found" }, 404);
});

// ── POST /refresh/:credentialId — force token refresh ────────────

oauth.post("/refresh/:credentialId", async (c) => {
  const credId = c.req.param("credentialId");
  const data = getCredentialData(credId);
  if (!data) return c.json({ error: "Credential not found" }, 404);

  const d = data.data as Record<string, string>;
  if (!d.refreshToken || !d.provider) {
    return c.json({ error: "No refresh token available" }, 400);
  }

  const providerConfig = getDirectOAuthProvider(d.provider);
  if (!providerConfig) {
    return c.json({ error: `Unknown provider: ${d.provider}` }, 400);
  }

  try {
    const clientSecret = getClientSecretForProvider(d.provider);
    const tokens = await refreshAccessToken(
      providerConfig,
      d.refreshToken,
      d.clientId,
      clientSecret,
    );

    const updated: Record<string, string> = {
      ...d,
      accessToken: tokens.accessToken,
    };
    if (tokens.refreshToken) updated.refreshToken = tokens.refreshToken;
    if (tokens.expiresAt) updated.expiresAt = tokens.expiresAt;

    updateCredential(credId, data.cred.name, updated);
    return c.json({ refreshed: true, expiresAt: tokens.expiresAt });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Synthesized OAuth (user-supplied provider config) ───────────
//
// Track 0.6: when the AI's research_integration tool reports
// authScheme=oauth2 for a service that isn't in OAUTH_PROVIDERS, the client
// runs a 3-step wizard. These endpoints back the wizard.

interface SynthesizedOAuthInitiate {
  credentialType: string;
  providerName: string;
  clientId: string;
  clientSecret?: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  extraAuthParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
}

/** GET /redirect-url — surfaced in the wizard so the user knows what to whitelist. */
oauth.get("/synthesized/redirect-url", (c) => {
  return c.json({ redirectUrl: CALLBACK_URL });
});

/**
 * POST /synthesized/initiate — start an OAuth flow for a user-supplied provider.
 * Returns the URL to open in a popup; the existing /callback handles the rest.
 */
oauth.post("/synthesized/initiate", async (c) => {
  let body: SynthesizedOAuthInitiate;
  try {
    body = await c.req.json<SynthesizedOAuthInitiate>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const credentialType = String(body.credentialType ?? "").trim();
  const providerName = String(body.providerName ?? "").trim();
  const clientId = String(body.clientId ?? "").trim();
  const clientSecret = body.clientSecret ? String(body.clientSecret).trim() : undefined;
  const authUrl = String(body.authUrl ?? "").trim();
  const tokenUrl = String(body.tokenUrl ?? "").trim();
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.map((s) => String(s).trim()).filter(Boolean)
    : [];

  if (!credentialType || !/^[a-z0-9][a-z0-9-]*$/.test(credentialType)) {
    return c.json({ error: "credentialType must be lowercase alphanumeric/hyphen (e.g. 'quickbooks')" }, 400);
  }
  if (!providerName) return c.json({ error: "providerName is required" }, 400);
  if (!clientId) return c.json({ error: "clientId is required" }, 400);
  if (!authUrl) return c.json({ error: "authUrl is required" }, 400);
  if (!tokenUrl) return c.json({ error: "tokenUrl is required" }, 400);

  // Reject SSRF / non-HTTP(S) URLs early.
  try {
    assertSafeUrl(authUrl, "authUrl");
    assertSafeUrl(tokenUrl, "tokenUrl");
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  // Force HTTPS for the auth + token endpoints — OAuth over plain HTTP is
  // a credential leak in transit.
  if (!authUrl.startsWith("https://")) return c.json({ error: "authUrl must be https://" }, 400);
  if (!tokenUrl.startsWith("https://")) return c.json({ error: "tokenUrl must be https://" }, 400);

  const inlineProvider: OAuthProviderConfig = {
    id: credentialType,
    name: providerName,
    authUrl,
    tokenUrl,
    scopes,
    extraAuthParams: body.extraAuthParams,
    extraTokenParams: body.extraTokenParams,
    requiresSecret: !!clientSecret,
  };

  const { authUrl: redirectUrl, state } = generateAuthUrl(
    inlineProvider,
    clientId,
    clientSecret,
    CALLBACK_URL,
    {
      inlineProvider,
      inlineProviderName: providerName,
      credentialType,
    },
  );

  return c.json({
    redirectUrl,
    connectionId: state,
    method: "synthesized" as const,
    redirectUriUsed: CALLBACK_URL,
  });
});

// ── Callback HTML ────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function callbackHtml(success: boolean, message: string): string {
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chvor — ${success ? "Connected" : "Error"}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0;
      background: #181818; color: #e4e4e8;
    }
    .card {
      text-align: center; padding: 3rem; border-radius: 1rem;
      background: #222; max-width: 420px;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    p { color: #999; font-size: 0.95rem; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? "&#10003;" : "&#10007;"}</div>
    <h1>${safeMessage}</h1>
    <p>${success ? "You can close this tab and return to Chvor." : "Please try again in Chvor."}</p>
  </div>
  <script>
    // Notify the opener window that OAuth is complete.
    // Use "*" because this callback page may be served from a different origin
    // than the opener (e.g. provider redirect, or file:// in desktop app).
    // The client-side handler in OAuthConnectButton validates the inbound origin.
    if (window.opener) {
      window.opener.postMessage({ type: "chvor-oauth-callback", success: ${success} }, "*");
    }
  </script>
</body>
</html>`;
}

export default oauth;
