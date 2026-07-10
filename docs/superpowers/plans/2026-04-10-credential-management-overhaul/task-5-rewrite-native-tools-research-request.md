# Credential Management Overhaul — Task 5: Rewrite Native Tools (research + request)

## Task 5: Rewrite Native Tools (research + request)

**Files:**
- Modify: `apps/server/src/lib/native-tools.ts`

- [ ] **Step 1: Replace native__request_credential and add native__research_integration**

In `apps/server/src/lib/native-tools.ts`, replace the credential request section (around lines 1549-1713). Remove the old `handleRequestCredential` stub from Task 1, the timeout constant, and the `pendingCredentialRequests` map. Also remove the `native__add_credential` tool (lines ~1450-1543) since it's replaced.

Add the new `native__research_integration` tool and rewrite `native__request_credential`:

```typescript
// ---------------------------------------------------------------------------
// Research integration tool (NEW)
// ---------------------------------------------------------------------------

const RESEARCH_INTEGRATION_NAME = "native__research_integration";
const researchIntegrationToolDef = tool({
  description:
    "[Research Integration] Look up an integration/service to determine what credentials are needed. " +
    "Checks the built-in provider registry, then the Chvor tool registry, then falls back to AI-powered web research. " +
    "Call this BEFORE native__request_credential to determine what fields to collect. " +
    "Returns the integration details including required credential fields and source tier.",
  parameters: z.object({
    service: z.string().describe(
      "The service/integration name (e.g., 'NocoDB', 'Anthropic', 'GitHub', 'My CRM'). Any string accepted.",
    ),
  }),
});

async function handleResearchIntegration(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  const service = String(args.service).trim();
  if (!service) {
    return { content: [{ type: "text", text: "Please provide a service name to research." }] };
  }

  try {
    const { resolveIntegration } = await import("./integration-resolver.ts");

    // Tier 1 + 2
    const resolution = await resolveIntegration(service);
    if (resolution) {
      const fieldList = resolution.fields.map((f) => `- ${f.label}${f.optional ? " (optional)" : " (required)"}`).join("\n");
      const existingNote = resolution.existingCredentialId
        ? `\n\nNote: A "${resolution.credentialType}" credential already exists (id: ${resolution.existingCredentialId}). You can use native__use_credential to access it, or proceed to add another.`
        : "";

      let sourceNote = "";
      if (resolution.source === "provider-registry") {
        sourceNote = `Found "${resolution.name}" in the built-in provider registry.`;
      } else if (resolution.source === "chvor-registry") {
        const installNote = resolution.registryToolInstalled
          ? "Tool is already installed."
          : "Tool will be installed from the Chvor registry when credentials are added.";
        sourceNote = `Found "${resolution.name}" in the Chvor registry. ${installNote}`;
      }

      return {
        content: [{
          type: "text",
          text: `${sourceNote}\n\nRequired credentials for ${resolution.name}:\n${fieldList}${existingNote}\n\nSource: ${resolution.source}\nCredential type: ${resolution.credentialType}\n\nTo collect these credentials, confirm with the user and then call native__request_credential with the resolution data.`,
        }],
        // Attach resolution as structured data for the next tool call
        _resolution: resolution,
      } as any;
    }

    // Tier 3: AI research
    const { researchIntegration } = await import("./integration-research.ts");
    const proposal = await researchIntegration(service);

    const fieldList = proposal.fields.map((f) => `- ${f.label}${f.optional ? " (optional)" : " (required)"}`).join("\n");
    const confidenceNote = proposal.confidence === "inferred"
      ? "⚠️ Based on AI knowledge (no web docs found). Fields may not be accurate."
      : "Based on web research of the service's API documentation.";

    return {
      content: [{
        type: "text",
        text: `Researched "${proposal.name}".\n\n${confidenceNote}\n\nSuggested credentials:\n${fieldList}${proposal.helpText ? `\n\n${proposal.helpText}` : ""}\n\nSource: ai-research (${proposal.confidence})\nCredential type: ${proposal.credentialType}\n\nConfirm with the user, then call native__request_credential to collect credentials.`,
      }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Research failed: ${err instanceof Error ? err.message : String(err)}. Suggest the user add credentials manually in Settings > Integrations.` }],
    };
  }
}

handlers.set(RESEARCH_INTEGRATION_NAME, handleResearchIntegration);
nativeToolMapping.set(RESEARCH_INTEGRATION_NAME, { kind: "tool", id: "credentials" });

// ---------------------------------------------------------------------------
// Request credential tool (REWRITTEN — no timeout, supports all 3 tiers)
// ---------------------------------------------------------------------------

const REQUEST_CREDENTIAL_NAME = "native__request_credential";

const pendingCredentialRequests = new Map<
  string,
  { resolve: (response: import("@chvor/shared").CredentialResponseData) => void }
>();

const requestCredentialToolDef = tool({
  description:
    "[Request Credential] Show a credential form to the user via an inline modal. " +
    "Use AFTER native__research_integration has identified what credentials are needed and the user has confirmed. " +
    "For Chvor registry tools, this will also install the tool if not already installed. " +
    "On non-web channels, directs user to the web dashboard.",
  parameters: z.object({
    credentialType: z.string().describe("The credential type slug (e.g., 'nocodb', 'anthropic')"),
    providerName: z.string().describe("Display name of the service (e.g., 'NocoDB', 'Anthropic')"),
    fields: z.array(z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(["password", "text"]).default("password"),
      placeholder: z.string().optional(),
      helpText: z.string().optional(),
      optional: z.boolean().optional(),
    })).describe("Credential fields to collect from user"),
    source: z.enum(["provider-registry", "chvor-registry", "ai-research"]).describe("Which tier resolved this integration"),
    registryEntryId: z.string().optional().describe("Chvor registry entry ID (for Tier 2 — will install tool)"),
    confidence: z.enum(["researched", "inferred"]).optional().describe("Confidence level (Tier 3 only)"),
    helpText: z.string().optional().describe("Setup guidance text"),
    existingCredentialId: z.string().optional().describe("If updating an existing credential"),
  }),
});

async function handleRequestCredential(
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> {
  const credentialType = String(args.credentialType);
  const providerName = String(args.providerName);
  const fields = args.fields as import("@chvor/shared").ProviderField[];
  const source = String(args.source) as "provider-registry" | "chvor-registry" | "ai-research";
  const registryEntryId = args.registryEntryId as string | undefined;
  const confidence = args.confidence as "researched" | "inferred" | undefined;
  const helpText = args.helpText as string | undefined;
  const existingCredentialId = args.existingCredentialId as string | undefined;

  // Non-web channels — direct to web dashboard
  if (context?.channelType && context.channelType !== "web") {
    return {
      content: [{ type: "text", text: `To add ${providerName} credentials, please use the web dashboard: Settings > Integrations.` }],
    };
  }

  // Install registry tool if needed (Tier 2)
  if (source === "chvor-registry" && registryEntryId) {
    try {
      const { readLock } = await import("./registry-manager.ts");
      const lock = readLock();
      if (!lock.installed[registryEntryId]) {
        const { installEntry } = await import("./registry-manager.ts");
        await installEntry(registryEntryId, "tool");
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to install registry tool "${registryEntryId}": ${err instanceof Error ? err.message : String(err)}. You can still add credentials manually in Settings.` }],
      };
    }
  }

  // Send credential.request to client
  const { getWSInstance } = await import("../gateway/ws-instance.ts");
  const ws = getWSInstance();
  if (!ws) {
    return { content: [{ type: "text", text: "WebSocket not available. Please add credentials in Settings > Integrations." }] };
  }

  const requestId = randomUUID();
  const requestEvent: GatewayServerEvent = {
    type: "credential.request",
    data: {
      requestId,
      providerName,
      providerIcon: "key",
      credentialType,
      fields: fields.length > 0 ? fields : [{ key: "apiKey", label: "API Key", type: "password" as const, placeholder: "sk-..." }],
      source,
      registryEntryId,
      confidence,
      helpText,
      allowFieldEditing: source === "ai-research",
      existingCredentialId,
      timestamp: new Date().toISOString(),
    },
  };

  if (context?.originClientId) {
    ws.sendTo(context.originClientId, requestEvent);
  } else {
    ws.broadcast(requestEvent);
  }

  // Wait for response — NO TIMEOUT (cleaned up on disconnect)
  const response = await new Promise<import("@chvor/shared").CredentialResponseData>((resolve) => {
    pendingCredentialRequests.set(requestId, { resolve });
  });

  if (response.cancelled || !response.data) {
    return { content: [{ type: "text", text: "Credential entry was cancelled by the user." }] };
  }

  // Save credential
  try {
    const { createCredential: createCred, updateCredential: updateCred } = await import("../db/credential-store.ts");
    const { invalidateToolCache } = await import("./tool-builder.ts");

    const name = response.name || `${providerName} API Key`;

    let savedId: string;
    if (existingCredentialId) {
      updateCred(existingCredentialId, { name, data: response.data });
      savedId = existingCredentialId;
    } else {
      const saved = createCred(name, credentialType, response.data);
      savedId = saved.id;
    }

    // Post-save actions
    try {
      const { tryRestartChannel } = await import("../routes/credentials.ts");
      tryRestartChannel(credentialType);
    } catch { /* ignore */ }
    try {
      const { mcpManager } = await import("./mcp-manager.ts");
      await mcpManager.closeConnectionsForCredential(credentialType);
    } catch { /* ignore */ }
    invalidateToolCache();
    clearModelCache();

    // Auto-test
    let testMsg = "";
    try {
      const { testProvider } = await import("../routes/provider-tester.ts");
      const result = await testProvider(credentialType, response.data);
      testMsg = result.success ? " Connection tested successfully." : ` Test: ${result.error}`;
      const { updateTestStatus } = await import("../db/credential-store.ts");
      updateTestStatus(savedId, result.success ? "success" : "failed");
    } catch { /* ignore */ }

    return {
      content: [{
        type: "text",
        text: `Credential "${name}" (${credentialType}) ${existingCredentialId ? "updated" : "saved"} successfully.${testMsg} Tools that require this credential are now available.`,
      }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to save credential: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}

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

handlers.set(REQUEST_CREDENTIAL_NAME, handleRequestCredential);
nativeToolMapping.set(REQUEST_CREDENTIAL_NAME, { kind: "tool", id: "credentials" });
```

- [ ] **Step 2: Update getNativeToolDefinitions to include new tool and remove old**

In the `getNativeToolDefinitions()` function (around line 4877), replace:
```typescript
[ADD_CREDENTIAL_NAME]: addCredentialToolDef,
[REQUEST_CREDENTIAL_NAME]: requestCredentialToolDef,
```

With:
```typescript
[RESEARCH_INTEGRATION_NAME]: researchIntegrationToolDef,
[REQUEST_CREDENTIAL_NAME]: requestCredentialToolDef,
```

- [ ] **Step 3: Remove the old native__add_credential tool**

Remove the `ADD_CREDENTIAL_NAME` constant, `addCredentialToolDef`, `handleAddCredential` function, and its `handlers.set()` / `nativeToolMapping.set()` calls (around lines 1450-1543).

- [ ] **Step 4: Add clearModelCache import**

Ensure `clearModelCache` is imported at the top of native-tools.ts (it's used in the new handleRequestCredential):

```typescript
import { clearModelCache } from "./model-fetcher.ts";
```

Check if this import already exists; add if not.

- [ ] **Step 5: Verify server compiles**

```bash
cd apps/server && pnpm tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/native-tools.ts
git commit -m "feat: rewrite credential native tools — add research_integration, rewrite request_credential

native__research_integration: three-tier lookup (provider registry → Chvor registry → AI research).
native__request_credential: rewritten with no timeout, supports all 3 tiers, auto-installs registry tools.
native__add_credential: removed (replaced by the new flow)."
```

---
