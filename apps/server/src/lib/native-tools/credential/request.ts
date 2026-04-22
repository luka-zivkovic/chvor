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

export const REQUEST_CREDENTIAL_NAME = "native__request_credential";

const pendingCredentialRequests = new Map<
  string,
  { resolve: (response: import("@chvor/shared").CredentialResponseData) => void }
>();

export const requestCredentialToolDef = tool({
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

export const handleRequestCredential: NativeToolHandler = async (
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
      const { readLock, installEntry } = await import("../../registry-manager.ts");
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
  const { getWSInstance } = await import("../../../gateway/ws-instance.ts");
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
    const { LLM_PROVIDERS, INTEGRATION_PROVIDERS } = await import("../../provider-registry.ts");
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
      const { getCredentialData } = await import("../../../db/credential-store.ts");
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
  const { createCredential, updateCredential } = await import("../../../db/credential-store.ts");
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
    const { tryRestartChannel } = await import("../../../routes/credentials.ts");
    tryRestartChannel(savedType);
  } catch (err) { console.warn("[request_credential] tryRestartChannel failed:", err instanceof Error ? err.message : String(err)); }

  try {
    const { mcpManager } = await import("../../mcp-manager.ts");
    await mcpManager.closeConnectionsForCredential(savedType);
  } catch (err) { console.warn("[request_credential] closeConnectionsForCredential failed:", err instanceof Error ? err.message : String(err)); }

  try {
    const { invalidateToolCache } = await import("../../tool-builder.ts");
    invalidateToolCache();
  } catch (err) { console.warn("[request_credential] invalidateToolCache failed:", err instanceof Error ? err.message : String(err)); }

  try {
    const { clearModelCache } = await import("../../model-fetcher.ts");
    clearModelCache();
  } catch (err) { console.warn("[request_credential] clearModelCache failed:", err instanceof Error ? err.message : String(err)); }

  // Auto-test
  let testMsg = "";
  try {
    const { testProvider } = await import("../../../routes/provider-tester.ts");
    const { updateTestStatus } = await import("../../../db/credential-store.ts");
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
      const { loadTools } = await import("../../capability-loader.ts");
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
