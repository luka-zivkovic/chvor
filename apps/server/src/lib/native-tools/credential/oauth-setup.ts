import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  recordPendingIntent,
  markIntentResumed,
  markIntentCancelled,
  findResumableForCredential,
} from "../../pending-intent.ts";
import type { NativeToolContext, NativeToolHandler, NativeToolResult } from "../types.ts";

// ---------------------------------------------------------------------------
// Request OAuth setup (Track 0.6 — synthesized OAuth wizard)
// ---------------------------------------------------------------------------
//
// When research_integration reports authScheme=oauth2 for a service that
// isn't in OAUTH_PROVIDERS, the AI calls this tool instead of
// request_credential. It opens a 3-step wizard on the client:
//   1. Show the redirect URL the user must register with the provider.
//   2. Collect client_id / client_secret / scopes.
//   3. Pop the OAuth window, capture the callback, store tokens.

export const REQUEST_OAUTH_SETUP_NAME = "native__request_oauth_setup";

const pendingOAuthWizards = new Map<
  string,
  { resolve: (response: import("@chvor/shared").OAuthSynthesizedWizardResponse) => void }
>();

export const requestOAuthSetupToolDef = tool({
  description:
    "[Request OAuth Setup] Launch a 3-step wizard for OAuth services not in the built-in registry " +
    "(e.g. QuickBooks, custom enterprise SaaS). Call this — NOT request_credential — when " +
    "research_integration returned authScheme='oauth2' and source='ai-research'. The user is walked " +
    "through registering Chvor's redirect URL with the provider, pasting client_id/secret, and " +
    "completing the OAuth dance. Returns once tokens are captured (or the user cancels).",
  parameters: z.object({
    credentialType: z.string().describe(
      "Stable lowercase slug used as the credential type, e.g. 'quickbooks'. Reuse research_integration's credentialType.",
    ),
    providerName: z.string().describe("Human-readable service name shown in the wizard (e.g. 'QuickBooks')."),
    authUrl: z.string().optional().describe(
      "OAuth authorization URL (e.g. 'https://appcenter.intuit.com/connect/oauth2'). User can edit before launch.",
    ),
    tokenUrl: z.string().optional().describe(
      "OAuth token-exchange URL. User can edit before launch.",
    ),
    scopes: z.array(z.string()).optional().describe(
      "Default OAuth scopes (e.g. ['com.intuit.quickbooks.accounting']). User can edit before launch.",
    ),
    helpText: z.string().optional().describe(
      "One-line guidance, typically the URL of the provider's developer portal.",
    ),
  }),
});

export const handleRequestOAuthSetup: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> => {
  const credentialType = String(args.credentialType ?? "").trim().toLowerCase();
  const providerName = String(args.providerName ?? "").trim();
  const authUrl = args.authUrl ? String(args.authUrl) : undefined;
  const tokenUrl = args.tokenUrl ? String(args.tokenUrl) : undefined;
  const scopes = Array.isArray(args.scopes)
    ? (args.scopes as unknown[]).map((s) => String(s)).filter(Boolean)
    : undefined;
  const helpText = args.helpText ? String(args.helpText) : undefined;

  if (!credentialType || !/^[a-z0-9][a-z0-9-]*$/.test(credentialType)) {
    return {
      content: [{
        type: "text",
        text: "OAuth setup failed: credentialType must be a lowercase alphanumeric/hyphen slug (e.g. 'quickbooks').",
      }],
    };
  }
  if (!providerName) {
    return {
      content: [{
        type: "text",
        text: "OAuth setup failed: providerName is required.",
      }],
    };
  }

  // Non-web channels can't run a browser-based OAuth flow; redirect to dashboard.
  const channelType = context?.channelType;
  if (channelType && channelType !== "web") {
    return {
      content: [{
        type: "text",
        text: `OAuth requires a browser. Please open the Chvor web dashboard, go to Settings > Integrations, and add your ${providerName} OAuth connection.`,
      }],
    };
  }

  const { getWSInstance } = await import("../../../gateway/ws-instance.ts");
  const ws = getWSInstance();
  if (!ws) {
    return {
      content: [{
        type: "text",
        text: `OAuth setup failed: no active WebSocket connection. Open the Chvor web dashboard and add your ${providerName} OAuth connection via Settings > Integrations.`,
      }],
    };
  }

  // Compute the redirect URI hint so the user can register it with the provider.
  const port = Number(process.env.PORT ?? 9147);
  const redirectUriHint = process.env.OAUTH_CALLBACK_URL ?? `http://localhost:${port}/api/oauth/callback`;

  const requestId = randomUUID();

  // Track 0.5 hookup: capture the original user intent so the wizard
  // result can resume the task without the user re-prompting.
  let pendingIntentId: string | null = null;
  if (context?.sessionId && context?.latestUserText) {
    try {
      const intent = recordPendingIntent({
        sessionId: context.sessionId,
        channelId: context.channelId,
        originalText: context.latestUserText,
        waitingForCredentialType: credentialType,
        waitingForCredentialRequestId: requestId,
      });
      pendingIntentId = intent.id;
    } catch (err) {
      console.warn(
        "[request_oauth_setup] recordPendingIntent failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const wizardEvent: import("@chvor/shared").GatewayServerEvent = {
    type: "oauth.synthesized.wizard",
    data: {
      requestId,
      credentialType,
      providerName,
      authUrl,
      tokenUrl,
      scopes,
      helpText,
      redirectUriHint,
      timestamp: new Date().toISOString(),
    },
  };

  if (context?.originClientId) {
    ws.sendTo(context.originClientId, wizardEvent);
  } else {
    ws.broadcast(wizardEvent);
  }

  // 15-min timeout — OAuth flows can involve account creation, paid plans, etc.
  const TIMEOUT_MS = 15 * 60_000;
  const response = await new Promise<import("@chvor/shared").OAuthSynthesizedWizardResponse>((resolve) => {
    const timer = setTimeout(() => {
      pendingOAuthWizards.delete(requestId);
      resolve({ requestId, cancelled: true });
    }, TIMEOUT_MS);
    pendingOAuthWizards.set(requestId, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
    });
  });

  if (response.cancelled) {
    if (pendingIntentId) {
      try { markIntentCancelled(pendingIntentId); } catch { /* non-critical */ }
    }
    return {
      content: [{
        type: "text",
        text: `OAuth setup for ${providerName} was cancelled. The user can retry from Settings > Integrations.`,
      }],
    };
  }
  if (!response.connected) {
    return {
      content: [{
        type: "text",
        text: `OAuth setup for ${providerName} did not complete. The user can retry from Settings > Integrations.`,
      }],
    };
  }

  // Token storage already happened server-side in the /callback handler.
  // Surface the resumption directive (Track 0.5) so the AI continues the task.
  let resumptionMsg = "";
  if (context?.sessionId) {
    try {
      const resumable = findResumableForCredential({
        sessionId: context.sessionId,
        credentialType,
      });
      const target = resumable ?? (pendingIntentId
        ? { id: pendingIntentId, originalText: context.latestUserText ?? "" }
        : null);
      if (target && target.originalText) {
        markIntentResumed(target.id);
        resumptionMsg = ` The user's original request was: "${target.originalText}". Continue handling it now using the newly-saved OAuth credential — do not wait for them to re-ask.`;
      }
    } catch (err) {
      console.warn(
        "[request_oauth_setup] resumption check failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Invalidate caches so the new credential is picked up immediately.
  try {
    const { invalidateToolCache } = await import("../../tool-builder.ts");
    invalidateToolCache();
  } catch { /* non-critical */ }

  return {
    content: [{
      type: "text",
      text: `OAuth setup for ${providerName} (${credentialType}) completed — access + refresh tokens stored.` +
        ` Next step: call native__synthesize_tool with credentialType="${credentialType}" and authScheme="oauth2" to register callable endpoints.` +
        resumptionMsg,
    }],
  };
};

/** Called by the gateway when the client posts oauth.synthesized.respond. */
export function resolveOAuthWizard(
  requestId: string,
  response: import("@chvor/shared").OAuthSynthesizedWizardResponse,
): boolean {
  const pending = pendingOAuthWizards.get(requestId);
  if (!pending) return false;
  pendingOAuthWizards.delete(requestId);
  pending.resolve(response);
  return true;
}
