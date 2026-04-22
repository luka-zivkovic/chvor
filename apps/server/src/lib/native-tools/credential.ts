import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { insertActivity } from "../../db/activity-store.ts";
import {
  recordPendingIntent,
  markIntentResumed,
  markIntentCancelled,
  findResumableForCredential,
} from "../pending-intent.ts";
import type { NativeToolContext, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Credential management tools
// ---------------------------------------------------------------------------
// Lazy imports to avoid circular deps (same pattern as schedule tools).

// ---------------------------------------------------------------------------
// Request credential (server-triggered modal / /addkey fallback)
// ---------------------------------------------------------------------------

const REQUEST_CREDENTIAL_NAME = "native__request_credential";

const pendingCredentialRequests = new Map<
  string,
  { resolve: (response: import("@chvor/shared").CredentialResponseData) => void }
>();

const requestCredentialToolDef = tool({
  description:
    "[Request Credential] Prompt the user to enter a credential via a UI modal. " +
    "Call native__research_integration FIRST to determine the fields, then call this tool with the results. " +
    "On web channels, opens a modal dialog. On messaging channels (Telegram, Discord, etc.), " +
    "tells the user to use the web dashboard. " +
    "Supports all three integration sources: provider-registry, chvor-registry, and ai-research.",
  parameters: z.object({
    credentialType: z.string().describe(
      "The credential type / provider ID (e.g. 'anthropic', 'github', 'nocodb'). Use the value from research_integration.",
    ),
    providerName: z.string().describe(
      "Human-readable service name (e.g. 'Anthropic', 'GitHub', 'NocoDB').",
    ),
    fields: z.array(z.object({
      key: z.string().describe("Field key (e.g. 'apiKey', 'botToken')"),
      label: z.string().describe("Human-readable label (e.g. 'API Key')"),
      type: z.enum(["password", "text"]).default("password"),
      placeholder: z.string().optional(),
      helpText: z.string().optional(),
      optional: z.boolean().optional(),
    })).describe("Credential fields the user needs to fill in."),
    source: z.enum(["provider-registry", "chvor-registry", "ai-research"]).describe(
      "Where this integration was resolved from.",
    ),
    registryEntryId: z.string().optional().describe(
      "Registry entry ID if source is chvor-registry.",
    ),
    confidence: z.enum(["researched", "inferred", "fallback"]).optional().describe(
      "Confidence level for ai-research results. 'fallback' means no real info was found; the user is filling in apiKey/baseUrl manually.",
    ),
    helpText: z.string().optional().describe(
      "Optional help text shown in the modal.",
    ),
    specUrl: z.string().optional().describe(
      "OpenAPI spec URL discovered during research. Pass through verbatim from research_integration; do not invent.",
    ),
    specVerified: z.boolean().optional().describe(
      "Whether the spec URL was server-verified to be a parseable OpenAPI document. Pass through from research_integration.",
    ),
    authScheme: z.string().optional().describe(
      "Auth scheme proposed by research_integration: bearer, basic, header, query-param, oauth2. Surfaced in the modal so the user understands what they're configuring.",
    ),
    baseUrl: z.string().optional().describe(
      "Base URL of the API. Required for the modal's 'Test connection' probe to function. Pass through from research_integration.",
    ),
    probePath: z.string().optional().describe(
      "Optional GET path on baseUrl that returns 2xx with valid auth (e.g. '/v1/me'). Used by the modal's pre-save probe.",
    ),
    existingCredentialId: z.string().optional().describe(
      "If updating an existing credential, pass its ID.",
    ),
  }),
});

const handleRequestCredential: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> => {
  const credentialType = String(args.credentialType);
  const providerName = String(args.providerName);
  const fields = args.fields as Array<{ key: string; label: string; type?: string; placeholder?: string; helpText?: string; optional?: boolean }>;
  const source = String(args.source) as "provider-registry" | "chvor-registry" | "ai-research";
  const registryEntryId = args.registryEntryId ? String(args.registryEntryId) : undefined;
  const confidence = args.confidence ? String(args.confidence) as "researched" | "inferred" | "fallback" : undefined;
  const helpText = args.helpText ? String(args.helpText) : undefined;
  const specUrl = args.specUrl ? String(args.specUrl) : undefined;
  const specVerified = typeof args.specVerified === "boolean" ? args.specVerified : undefined;
  const authScheme = args.authScheme ? String(args.authScheme) : undefined;
  const baseUrl = args.baseUrl ? String(args.baseUrl) : undefined;
  const probePath = args.probePath ? String(args.probePath) : undefined;
  const existingCredentialId = args.existingCredentialId ? String(args.existingCredentialId) : undefined;

  // Non-web channels → direct to web dashboard
  const channelType = context?.channelType;
  if (channelType && channelType !== "web") {
    return {
      content: [{
        type: "text",
        text: `I need your ${providerName} credentials but can't collect them on this channel. ` +
          `Please open the Chvor web dashboard and go to Settings > Integrations to add your ${providerName} credential.`,
      }],
    };
  }

  // If source is chvor-registry with a registry entry, ensure it's installed.
  // Errors are captured (not swallowed) so the post-save message can surface them.
  let registryInstallError: string | null = null;
  if (source === "chvor-registry" && registryEntryId) {
    try {
      const { readLock, installEntry } = await import("../registry-manager.ts");
      const lock = readLock();
      if (!lock.installed[registryEntryId]) {
        await installEntry(registryEntryId, "tool");
      }
    } catch (err) {
      registryInstallError = err instanceof Error ? err.message : String(err);
      console.error(`[request_credential] Failed to install registry entry ${registryEntryId}:`, err);
    }
  }

  // Send credential.request WebSocket event
  const { getWSInstance } = await import("../../gateway/ws-instance.ts");
  const ws = getWSInstance();
  if (!ws) {
    return {
      content: [{
        type: "text",
        text: `Cannot request credentials — no active WebSocket connection. Please add your ${providerName} credential via Settings > Integrations.`,
      }],
    };
  }

  // Resolve provider icon from registry
  let providerIcon = "";
  try {
    const { LLM_PROVIDERS, INTEGRATION_PROVIDERS } = await import("../provider-registry.ts");
    const llmMatch = LLM_PROVIDERS.find((p) => p.credentialType === credentialType);
    if (llmMatch) providerIcon = llmMatch.icon;
    else {
      const intMatch = INTEGRATION_PROVIDERS.find((p) => p.credentialType === credentialType);
      if (intMatch) providerIcon = intMatch.icon;
    }
  } catch { /* non-critical */ }

  // Fetch redacted values for existing credential
  let redactedValues: Record<string, string> | undefined;
  if (existingCredentialId) {
    try {
      const { getCredentialData } = await import("../../db/credential-store.ts");
      const existing = getCredentialData(existingCredentialId);
      if (existing) {
        const NON_SECRET = new Set(["host", "port", "baseUrl", "domain", "homeserverUrl", "instanceUrl", "userId", "email", "vaultPath", "username"]);
        redactedValues = {};
        for (const [k, v] of Object.entries(existing.data)) {
          redactedValues[k] = NON_SECRET.has(k) ? v : (v.length <= 4 ? "••••••••" : v.slice(0, 4) + "••••••••");
        }
      }
    } catch { /* non-critical */ }
  }

  const requestId = randomUUID();
  const allowFieldEditing = source === "ai-research";

  // Track 0.5: capture the original user intent so the AI can resume after the
  // credential dance. Dedupes per (session, originalText, credentialType).
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
        "[request_credential] recordPendingIntent failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const normalizedFields = fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: (f.type ?? "password") as "password" | "text",
    placeholder: f.placeholder,
    helpText: f.helpText,
    optional: f.optional,
  }));

  // Route to originating client if web, or broadcast as fallback
  const credentialRequestEvent: import("@chvor/shared").GatewayServerEvent = {
    type: "credential.request",
    data: {
      requestId,
      providerName,
      providerIcon,
      credentialType,
      fields: normalizedFields,
      source,
      registryEntryId,
      confidence,
      helpText,
      specUrl,
      specVerified,
      authScheme,
      baseUrl,
      probePath,
      allowFieldEditing,
      existingCredentialId,
      redactedValues,
      timestamp: new Date().toISOString(),
    },
  };

  if (context?.originClientId) {
    ws.sendTo(context.originClientId, credentialRequestEvent);
  } else {
    ws.broadcast(credentialRequestEvent);
  }

  // Wait for user response with 10-minute timeout
  const CREDENTIAL_REQUEST_TIMEOUT_MS = 10 * 60_000;
  const response = await new Promise<import("@chvor/shared").CredentialResponseData>((resolve) => {
    const timer = setTimeout(() => {
      pendingCredentialRequests.delete(requestId);
      resolve({ requestId, cancelled: true });
    }, CREDENTIAL_REQUEST_TIMEOUT_MS);
    pendingCredentialRequests.set(requestId, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
    });
  });

  // User cancelled
  if (response.cancelled) {
    if (pendingIntentId) {
      try {
        markIntentCancelled(pendingIntentId);
      } catch { /* non-critical */ }
    }
    return {
      content: [{
        type: "text",
        text: `Credential request for ${providerName} was cancelled. You can add it later via Settings > Integrations.`,
      }],
    };
  }

  // Save credential
  const { createCredential, updateCredential } = await import("../../db/credential-store.ts");
  const data = response.data ?? {};
  const credName = response.name ?? providerName;

  // Validate required fields are present (skip for updates — empty means keep current)
  if (!existingCredentialId) {
    const requiredKeys = fields.filter((f) => !f.optional).map((f) => f.key);
    const missingKeys = requiredKeys.filter((k) => !data[k]?.trim());
    if (missingKeys.length > 0) {
      return {
        content: [{
          type: "text",
          text: `Credential save failed: missing required fields: ${missingKeys.join(", ")}. Please try again.`,
        }],
      };
    }
  }

  let savedId: string;
  let savedType: string;

  if (existingCredentialId) {
    const updated = updateCredential(existingCredentialId, credName, data);
    if (!updated) {
      // Fallback: create new if update target doesn't exist
      const created = createCredential(credName, credentialType, data);
      savedId = created.id;
      savedType = created.type;
    } else {
      savedId = updated.id;
      savedType = updated.type;
    }
  } else {
    const created = createCredential(credName, credentialType, data);
    savedId = created.id;
    savedType = created.type;
  }

  // Post-save actions
  try {
    const { tryRestartChannel } = await import("../../routes/credentials.ts");
    tryRestartChannel(savedType);
  } catch (err) { console.warn("[request_credential] tryRestartChannel failed:", err instanceof Error ? err.message : String(err)); }

  try {
    const { mcpManager } = await import("../mcp-manager.ts");
    await mcpManager.closeConnectionsForCredential(savedType);
  } catch (err) { console.warn("[request_credential] closeConnectionsForCredential failed:", err instanceof Error ? err.message : String(err)); }

  try {
    const { invalidateToolCache } = await import("../tool-builder.ts");
    invalidateToolCache();
  } catch (err) { console.warn("[request_credential] invalidateToolCache failed:", err instanceof Error ? err.message : String(err)); }

  try {
    const { clearModelCache } = await import("../model-fetcher.ts");
    clearModelCache();
  } catch (err) { console.warn("[request_credential] clearModelCache failed:", err instanceof Error ? err.message : String(err)); }

  // Auto-test
  let testMsg = "";
  try {
    const { testProvider } = await import("../../routes/provider-tester.ts");
    const { updateTestStatus } = await import("../../db/credential-store.ts");
    const result = await testProvider(credentialType, data);
    if (result.success) {
      updateTestStatus(savedId, "success");
      testMsg = " Connection tested successfully.";
    } else {
      updateTestStatus(savedId, "failed");
      testMsg = ` Test failed: ${result.error}.`;
    }
  } catch {
    testMsg = " Could not auto-test.";
  }

  // Source-aware follow-up text so the AI knows what to do next.
  let nextStepMsg: string;
  if (source === "chvor-registry") {
    nextStepMsg = registryInstallError
      ? ` Tool install failed: ${registryInstallError}.`
      : ` Tool "${registryEntryId ?? credentialType}" installed — call it in your next tool call.`;
  } else if (source === "provider-registry") {
    try {
      const { loadTools } = await import("../capability-loader.ts");
      const matchingTool = loadTools().find((t) =>
        t.metadata.requires?.credentials?.includes(credentialType)
      );
      nextStepMsg = matchingTool
        ? ` Tool "${matchingTool.id}" is now usable — call it in your next tool call.`
        : ` No tool on disk requires credential type "${credentialType}" yet. If this is meant to drive an HTTP API, call native__synthesize_tool to create one.`;
    } catch {
      nextStepMsg = " Credential saved. The associated provider should now be usable.";
    }
  } else {
    // ai-research
    nextStepMsg =
      ` Next step: call native__synthesize_tool with credentialType="${credentialType}" and either openApiSpecUrl=... (preferred) or an endpoints[] array.`;
  }

  // Track 0.5: if we had captured an original user intent, surface a
  // resumption directive so the AI continues the work rather than waiting
  // for the user to re-prompt. Prefer the matching pending row over the
  // one we recorded, in case multiple AI re-prompts collapsed to one.
  let resumptionMsg = "";
  if (context?.sessionId) {
    try {
      const resumable = findResumableForCredential({
        sessionId: context.sessionId,
        credentialType: savedType,
      });
      const target = resumable ?? (pendingIntentId
        ? { id: pendingIntentId, originalText: context.latestUserText ?? "" }
        : null);
      if (target && target.originalText) {
        markIntentResumed(target.id);
        resumptionMsg = ` The user's original request was: "${target.originalText}". Continue handling it now using the newly-saved credential — do not wait for them to re-ask.`;
      }
    } catch (err) {
      console.warn(
        "[request_credential] resumption check failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    content: [{
      type: "text",
      text: `Credential "${credName}" (${credentialType}) saved (id: ${savedId}).${testMsg}${nextStepMsg}${resumptionMsg}`,
    }],
  };
};

/** Called when the client responds to a credential.request event. */
export function resolveCredentialRequest(
  requestId: string,
  response: import("@chvor/shared").CredentialResponseData,
): boolean {
  const pending = pendingCredentialRequests.get(requestId);
  if (!pending) return false;
  pendingCredentialRequests.delete(requestId);
  pending.resolve(response);
  return true;
}

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

const REQUEST_OAUTH_SETUP_NAME = "native__request_oauth_setup";

const pendingOAuthWizards = new Map<
  string,
  { resolve: (response: import("@chvor/shared").OAuthSynthesizedWizardResponse) => void }
>();

const requestOAuthSetupToolDef = tool({
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

const handleRequestOAuthSetup: NativeToolHandler = async (
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

  const { getWSInstance } = await import("../../gateway/ws-instance.ts");
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
    const { invalidateToolCache } = await import("../tool-builder.ts");
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

// ---------------------------------------------------------------------------
// Update credential tool
// ---------------------------------------------------------------------------

const UPDATE_CREDENTIAL_NAME = "native__update_credential";

const updateCredentialToolDef = tool({
  description:
    "[Update Credential] Update an existing credential's name and/or data. Use this when a user wants to change/rotate a key or rename a credential. Call native__list_credentials first to get the credential id.",
  parameters: z.object({
    id: z.string().describe("Credential id (from native__list_credentials)"),
    name: z.string().optional().describe("New display name (omit to keep current)"),
    data: z
      .record(z.string())
      .optional()
      .describe(
        "New credential data fields. Only include fields you want to change. Key-value pairs like { apiKey: '...' }."
      ),
  }),
});

const handleUpdateCredential: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const { updateCredential, getCredentialData } = await import("../../db/credential-store.ts");
  const { testProvider } = await import("../../routes/provider-tester.ts");
  const { tryRestartChannel } = await import("../../routes/credentials.ts");
  const { invalidateToolCache } = await import("../tool-builder.ts");
  const { mcpManager } = await import("../mcp-manager.ts");

  const id = String(args.id);
  const newName = args.name ? String(args.name) : undefined;
  const newData = args.data as Record<string, string> | undefined;

  if (!newName && !newData) {
    return { content: [{ type: "text", text: "Nothing to update — provide name or data." }] };
  }

  const summary = updateCredential(id, newName, newData);
  if (!summary) {
    return { content: [{ type: "text", text: `Credential ${id} not found.` }] };
  }

  // Auto-test with updated data
  let testMsg = "";
  if (newData) {
    try {
      const updatedRecord = getCredentialData(id);
      if (updatedRecord) {
        const result = await testProvider(updatedRecord.cred.type, updatedRecord.data);
        testMsg = result.success
          ? " Connection tested successfully."
          : ` Test failed: ${result.error}.`;
      }
    } catch {
      testMsg = " Could not auto-test.";
    }
    tryRestartChannel(summary.type);
    // Refresh MCP connections and tool cache so tools use the new credentials
    try {
      await mcpManager.closeConnectionsForCredential(summary.type);
      invalidateToolCache();
    } catch (err) {
      console.error(`[update_credential] tool refresh failed for ${summary.type}:`, err);
    }
  }

  return {
    content: [
      {
        type: "text",
        text: `Credential "${summary.name}" (${summary.type}) updated.${testMsg}`,
      },
    ],
  };
};

const LIST_CREDENTIALS_NAME = "native__list_credentials";

const listCredentialsToolDef = tool({
  description:
    "[List Credentials] List all saved credentials with their type, status, and redacted values.",
  parameters: z.object({}),
});

const handleListCredentials: NativeToolHandler = async (): Promise<NativeToolResult> => {
  const { listCredentials } = await import("../../db/credential-store.ts");
  const { INTEGRATION_PROVIDERS } = await import("../provider-registry.ts");
  const creds = listCredentials();
  if (creds.length === 0) {
    return { content: [{ type: "text", text: "No credentials saved yet." }] };
  }
  const lines = creds.map((c) => {
    const status = c.testStatus ?? "untested";
    const fields = Object.entries(c.redactedFields)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    // Resolve usage context: stored on credential > provider default
    const usage = c.usageContext
      ?? INTEGRATION_PROVIDERS.find((p) => p.credentialType === c.type)?.usageContext;
    const usageSuffix = usage ? ` | Usage: ${usage}` : "";
    return `- [${status}] "${c.name}" (${c.type}) | ${fields} | id: ${c.id}${usageSuffix}`;
  });
  return { content: [{ type: "text", text: lines.join("\n") }] };
};

const USE_CREDENTIAL_NAME = "native__use_credential";

const useCredentialToolDef = tool({
  description:
    "[Use Credential] Retrieve full (unredacted) credential data by ID for making authenticated API calls. Use native__list_credentials first to find the ID, then this tool to get the actual secret values needed for request headers.",
  parameters: z.object({
    id: z.string().describe("The credential ID to retrieve"),
  }),
});

const handleUseCredential: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const { getCredentialData } = await import("../../db/credential-store.ts");
  const { INTEGRATION_PROVIDERS } = await import("../provider-registry.ts");
  const { registerSecretValues } = await import("../sensitive-filter.ts");

  const result = getCredentialData(String(args.id));
  if (!result) {
    return { content: [{ type: "text", text: "Credential not found." }] };
  }

  // Audit log
  try {
    const activityEntry = insertActivity({
      source: "credential-access",
      title: `Credential used: "${result.cred.name}" (${result.cred.type})`,
      content: `Credential ${args.id} accessed via native__use_credential${context?.sessionId ? ` in session ${context.sessionId}` : ""}`,
    });
    const { getWSInstance } = await import("../../gateway/ws-instance.ts");
    getWSInstance()?.broadcast({ type: "activity.new", data: activityEntry });
  } catch { /* best-effort logging */ }

  // Register secret values for dynamic redaction
  const secretValues = Object.values(result.data).filter((v) => v.length >= 4);
  if (secretValues.length > 0) registerSecretValues(secretValues);

  const fields = Object.entries(result.data)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  // Build connection instructions from connectionConfig (structured) or usageContext (legacy)
  let connectionHint = "";
  const cc = result.cred.connectionConfig;
  if (cc) {
    const parts: string[] = ["\n\n## Connection Config"];
    if (cc.baseUrl) parts.push(`Base URL: ${cc.baseUrl}`);
    if (cc.auth.headerName && cc.auth.headerTemplate) {
      // Replace placeholder with the actual credential field value
      let headerVal = cc.auth.headerTemplate;
      for (const [k, v] of Object.entries(result.data)) {
        headerVal = headerVal.replace(`{{${k}}}`, v);
      }
      parts.push(`Auth header: ${cc.auth.headerName}: ${headerVal}`);
    }
    if (cc.headers && Object.keys(cc.headers).length > 0) {
      parts.push(`Required headers: ${JSON.stringify(cc.headers)}`);
    }
    if (cc.baseUrl) {
      // Build a ready-to-use example for the LLM
      const exHeaders: Record<string, string> = {};
      if (cc.auth.headerName && cc.auth.headerTemplate) {
        let hv = cc.auth.headerTemplate;
        for (const [k, v] of Object.entries(result.data)) {
          hv = hv.replace(`{{${k}}}`, v);
        }
        exHeaders[cc.auth.headerName] = hv;
      }
      if (cc.headers) Object.assign(exHeaders, cc.headers);
      parts.push(`\nTo call this API, use native__web_request with:\n  url: ${cc.baseUrl}/{endpoint}\n  headers: ${JSON.stringify(exHeaders)}`);
    }
    parts.push(`\nConfidence: ${cc.confidence} (source: ${cc.source})`);
    connectionHint = parts.join("\n");
  } else {
    // Fallback to legacy usageContext
    const usage = result.cred.usageContext
      ?? INTEGRATION_PROVIDERS.find((p) => p.credentialType === result.cred.type)?.usageContext;
    connectionHint = usage ? `\n\nUsage: ${usage}` : "";
  }

  return {
    content: [
      {
        type: "text",
        text: `IMPORTANT: Use these values ONLY in tool call parameters (headers, body). Never display them in your response.\n\nCredential "${result.cred.name}" (${result.cred.type}):\n${fields}${connectionHint}`,
      },
    ],
  };
};

const DELETE_CREDENTIAL_NAME = "native__delete_credential";

const deleteCredentialToolDef = tool({
  description:
    "[Delete Credential] Remove a saved credential by its ID. Use native__list_credentials first to find the ID.",
  parameters: z.object({
    id: z.string().describe("The credential ID to delete"),
  }),
});

const handleDeleteCredential: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const { getCredentialData, deleteCredential } = await import(
    "../../db/credential-store.ts"
  );
  const { tryRestartChannel } = await import("../../routes/credentials.ts");

  const id = String(args.id);
  const record = getCredentialData(id);
  const deleted = deleteCredential(id);

  if (!deleted) {
    return {
      content: [{ type: "text", text: `Credential ${id} not found.` }],
    };
  }

  if (record) tryRestartChannel(record.cred.type);

  return {
    content: [
      {
        type: "text",
        text: `Credential "${record?.cred.name}" (${record?.cred.type}) deleted.`,
      },
    ],
  };
};

const TEST_CREDENTIAL_NAME = "native__test_credential";

const testCredentialToolDef = tool({
  description:
    "[Test Credential] Verify that a saved credential works (e.g. test API key or bot token connectivity). Use native__list_credentials first to find the ID.",
  parameters: z.object({
    id: z.string().describe("The credential ID to test"),
  }),
});

const handleTestCredential: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const { getCredentialData, updateTestStatus } = await import(
    "../../db/credential-store.ts"
  );
  const { testProvider } = await import("../../routes/provider-tester.ts");
  const { tryRestartChannel } = await import("../../routes/credentials.ts");

  const id = String(args.id);
  const record = getCredentialData(id);
  if (!record) {
    return {
      content: [{ type: "text", text: `Credential ${id} not found.` }],
    };
  }

  const result = await testProvider(record.cred.type, record.data);
  updateTestStatus(id, result.success ? "success" : "failed");

  if (result.success) tryRestartChannel(record.cred.type);

  return {
    content: [
      {
        type: "text",
        text: result.success
          ? `Credential "${record.cred.name}" (${record.cred.type}) tested successfully.`
          : `Credential "${record.cred.name}" test failed: ${result.error}`,
      },
    ],
  };
};

export const credentialModule: NativeToolModule = {
  defs: {
    [REQUEST_CREDENTIAL_NAME]: requestCredentialToolDef,
    [REQUEST_OAUTH_SETUP_NAME]: requestOAuthSetupToolDef,
    [UPDATE_CREDENTIAL_NAME]: updateCredentialToolDef,
    [LIST_CREDENTIALS_NAME]: listCredentialsToolDef,
    [USE_CREDENTIAL_NAME]: useCredentialToolDef,
    [DELETE_CREDENTIAL_NAME]: deleteCredentialToolDef,
    [TEST_CREDENTIAL_NAME]: testCredentialToolDef,
  },
  handlers: {
    [REQUEST_CREDENTIAL_NAME]: handleRequestCredential,
    [REQUEST_OAUTH_SETUP_NAME]: handleRequestOAuthSetup,
    [UPDATE_CREDENTIAL_NAME]: handleUpdateCredential,
    [LIST_CREDENTIALS_NAME]: handleListCredentials,
    [USE_CREDENTIAL_NAME]: handleUseCredential,
    [DELETE_CREDENTIAL_NAME]: handleDeleteCredential,
    [TEST_CREDENTIAL_NAME]: handleTestCredential,
  },
  mappings: {
    [REQUEST_CREDENTIAL_NAME]: { kind: "tool", id: "credentials" },
    [REQUEST_OAUTH_SETUP_NAME]: { kind: "tool", id: "credentials" },
    [UPDATE_CREDENTIAL_NAME]: { kind: "tool", id: "credentials" },
    [LIST_CREDENTIALS_NAME]: { kind: "tool", id: "credentials" },
    [USE_CREDENTIAL_NAME]: { kind: "tool", id: "credentials" },
    [DELETE_CREDENTIAL_NAME]: { kind: "tool", id: "credentials" },
    [TEST_CREDENTIAL_NAME]: { kind: "tool", id: "credentials" },
  },
};
