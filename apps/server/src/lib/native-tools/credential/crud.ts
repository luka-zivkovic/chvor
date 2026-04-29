import { tool } from "ai";
import { z } from "zod";
import { insertActivity } from "../../../db/activity-store.ts";
import type { NativeToolContext, NativeToolHandler, NativeToolResult } from "../types.ts";

// ---------------------------------------------------------------------------
// CRUD + test operations on saved credentials
// ---------------------------------------------------------------------------

export const UPDATE_CREDENTIAL_NAME = "native__update_credential";

export const updateCredentialToolDef = tool({
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

export const handleUpdateCredential: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const { updateCredential, getCredentialData } = await import("../../../db/credential-store.ts");
  const { testProvider } = await import("../../../routes/provider-tester.ts");
  const { tryRestartChannel } = await import("../../../routes/credentials.ts");
  const { invalidateToolCache } = await import("../../tool-builder.ts");
  const { mcpManager } = await import("../../mcp-manager.ts");

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
  } else if (newName) {
    // Credential names are surfaced in synthesized-tool credentialId enum
    // descriptions, so a rename must rebuild the tool surface even though no
    // external MCP connection needs restarting.
    invalidateToolCache();
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

export const LIST_CREDENTIALS_NAME = "native__list_credentials";

export const listCredentialsToolDef = tool({
  description:
    "[List Credentials] List all saved credentials with their type, status, and redacted values.",
  parameters: z.object({}),
});

export const handleListCredentials: NativeToolHandler = async (
  _args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const { listCredentials } = await import("../../../db/credential-store.ts");
  const { INTEGRATION_PROVIDERS } = await import("../../provider-registry.ts");
  const all = listCredentials();
  // Honour the active skill's allowedCredentialTypes scope. Listing
  // out-of-scope credential ids would invite the LLM to try them and absorb
  // a synthesized-caller preflight rejection downstream.
  const allowed = context?.allowedCredentialTypes;
  const creds = allowed && allowed.length > 0 ? all.filter((c) => allowed.includes(c.type)) : all;
  if (creds.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            allowed && allowed.length > 0 && all.length > 0
              ? `No credentials available for the active skill scope (${allowed.join(", ")}).`
              : "No credentials saved yet.",
        },
      ],
    };
  }
  const lines = creds.map((c) => {
    const status = c.testStatus ?? "untested";
    const fields = Object.entries(c.redactedFields)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    // Resolve usage context: stored on credential > provider default
    const usage =
      c.usageContext ??
      INTEGRATION_PROVIDERS.find((p) => p.credentialType === c.type)?.usageContext;
    const usageSuffix = usage ? ` | Usage: ${usage}` : "";
    return `- [${status}] "${c.name}" (${c.type}) | ${fields} | id: ${c.id}${usageSuffix}`;
  });
  return { content: [{ type: "text", text: lines.join("\n") }] };
};

export const USE_CREDENTIAL_NAME = "native__use_credential";

export const useCredentialToolDef = tool({
  description:
    "[Credential] Read metadata about a stored credential — its name, type, usage_context, field NAMES, and a connection-hint template with placeholders LEFT UN-RENDERED. Use this to decide which credential applies, then reference values via {{credentials.<type>[.field]}} placeholders in downstream tool calls; those expand at the external boundary, never in your prompt. To READ a raw credential value (rare), pass revealValues:true and approve the HITL prompt that fires.",
  parameters: z.object({
    credentialId: z
      .string()
      .optional()
      .describe("Exact credential id (preferred, from native__list_credentials)"),
    id: z.string().optional().describe("Legacy alias for credentialId"),
    type: z.string().optional().describe("Credential type lookup fallback, e.g. github"),
    revealValues: z
      .boolean()
      .optional()
      .default(false)
      .describe("Default false. true requests HITL approval to reveal raw values once."),
  }),
});

function usageContextList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isSensitiveHeaderName(name: string | undefined): boolean {
  if (!name) return false;
  return /authorization|cookie|api[-_]?key|token|secret|password/i.test(name);
}

function replaceCredentialValuesWithPlaceholders(
  value: string,
  data: Record<string, string> | undefined
): string {
  if (!data) return value;
  let out = value;
  const entries = Object.entries(data)
    .filter(([, raw]) => typeof raw === "string" && raw.length > 0)
    // Replace longer values first so overlapping values don't partially mask.
    .sort((a, b) => b[1].length - a[1].length);
  for (const [field, raw] of entries) {
    out = out.split(raw).join(`{{${field}}}`);
  }
  return out;
}

function renderPotentialSecretTemplate(args: {
  headerName?: string;
  value: string;
  data?: Record<string, string>;
  reveal: boolean;
}): string {
  let rendered = args.value;
  if (args.reveal && args.data) {
    for (const [k, v] of Object.entries(args.data)) {
      rendered = rendered.replaceAll(`{{${k}}}`, v);
    }
    return rendered;
  }

  rendered = replaceCredentialValuesWithPlaceholders(rendered, args.data);
  if (isSensitiveHeaderName(args.headerName) && !rendered.includes("{{")) {
    return "«credential»";
  }
  return rendered;
}

function renderHeaderRecord(args: {
  headers: Record<string, string> | undefined;
  data?: Record<string, string>;
  reveal: boolean;
}): Record<string, string> | undefined {
  if (!args.headers || Object.keys(args.headers).length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.headers)) {
    out[k] = renderPotentialSecretTemplate({
      headerName: k,
      value: String(v),
      data: args.data,
      reveal: args.reveal,
    });
  }
  return out;
}

function renderConnectionHint(args: {
  cred: {
    usageContext?: string;
    connectionConfig?: import("@chvor/shared").ConnectionConfig;
    type: string;
  };
  data?: Record<string, string>;
  providerUsage?: string;
  reveal: boolean;
}): string {
  const cc = args.cred.connectionConfig;
  if (cc) {
    const parts: string[] = ["## Connection Config"];
    const renderedBaseUrl = cc.baseUrl
      ? renderPotentialSecretTemplate({
          value: cc.baseUrl,
          data: args.data,
          reveal: args.reveal,
        })
      : undefined;
    if (renderedBaseUrl) parts.push(`Base URL: ${renderedBaseUrl}`);
    if (cc.auth.headerName && cc.auth.headerTemplate) {
      const headerVal = renderPotentialSecretTemplate({
        headerName: cc.auth.headerName,
        value: cc.auth.headerTemplate,
        data: args.data,
        reveal: args.reveal,
      });
      parts.push(`Auth header: ${cc.auth.headerName}: ${headerVal}`);
    }
    const renderedStaticHeaders = renderHeaderRecord({
      headers: cc.headers,
      data: args.data,
      reveal: args.reveal,
    });
    if (renderedStaticHeaders && Object.keys(renderedStaticHeaders).length > 0) {
      parts.push(`Required headers: ${JSON.stringify(renderedStaticHeaders)}`);
    }
    if (renderedBaseUrl) {
      const exHeaders: Record<string, string> = {};
      if (cc.auth.headerName && cc.auth.headerTemplate) {
        exHeaders[cc.auth.headerName] = renderPotentialSecretTemplate({
          headerName: cc.auth.headerName,
          value: cc.auth.headerTemplate,
          data: args.data,
          reveal: args.reveal,
        });
      }
      if (renderedStaticHeaders) Object.assign(exHeaders, renderedStaticHeaders);
      parts.push(
        `To call this API, use native__web_request with url: ${renderedBaseUrl}/{endpoint} and headers: ${JSON.stringify(exHeaders)}`
      );
    }
    parts.push(`Confidence: ${cc.confidence} (source: ${cc.source})`);
    return parts.join("\n");
  }
  const usage = args.cred.usageContext ?? args.providerUsage;
  return usage ? `Usage: ${usage}` : "";
}

function metadataPayload(args: {
  credentialId: string;
  name: string;
  type: string;
  usageContext?: string;
  fieldNames: string[];
  connectionHint: string;
  note?: string;
}): Record<string, unknown> {
  return {
    credentialId: args.credentialId,
    name: args.name,
    type: args.type,
    usage_context: usageContextList(args.usageContext),
    field_names: args.fieldNames,
    connectionHint: args.connectionHint,
    hint: args.note ?? "values redacted — pass revealValues:true to read raw",
  };
}

function textJson(value: unknown): NativeToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function findCredentialForUse(
  args: Record<string, unknown>,
  sessionId?: string | null
): Promise<
  | {
      record: { cred: import("@chvor/shared").Credential; data: Record<string, string> };
      requestedId?: string;
      requestedType?: string;
    }
  | { error: string }
> {
  const { getCredentialData, listCredentials } = await import("../../../db/credential-store.ts");
  const { pickCredential } = await import("../../credential-picker.ts");
  const requestedId = args.credentialId ?? args.id;
  if (typeof requestedId === "string" && requestedId.trim()) {
    const record = getCredentialData(requestedId.trim());
    if (!record) return { error: `Credential id ${requestedId} not found.` };
    return { record, requestedId: requestedId.trim(), requestedType: record.cred.type };
  }
  const requestedType = typeof args.type === "string" ? args.type.trim() : "";
  if (requestedType) {
    const pick = pickCredential(requestedType, { sessionId: sessionId ?? null });
    if (!pick) return { error: `Credential type ${requestedType} not found.` };
    const record = getCredentialData(pick.credentialId);
    if (!record) return { error: `Credential ${pick.credentialId} could not be decrypted.` };
    return { record, requestedId: pick.credentialId, requestedType };
  }
  const count = listCredentials().length;
  return {
    error: count > 0 ? "Provide credentialId (or legacy id) or type." : "No credentials saved yet.",
  };
}

export const handleUseCredential: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const { INTEGRATION_PROVIDERS } = await import("../../provider-registry.ts");
  const lookup = await findCredentialForUse(args, context?.sessionId);
  if ("error" in lookup) {
    return { content: [{ type: "text", text: lookup.error }] };
  }

  const { record } = lookup;
  const providerUsage = INTEGRATION_PROVIDERS.find(
    (p) => p.credentialType === record.cred.type
  )?.usageContext;
  const redacted = metadataPayload({
    credentialId: record.cred.id,
    name: record.cred.name,
    type: record.cred.type,
    usageContext: record.cred.usageContext ?? providerUsage,
    fieldNames: Object.keys(record.data),
    connectionHint: renderConnectionHint({
      cred: record.cred,
      data: record.data,
      providerUsage,
      reveal: false,
    }),
  });

  const revealValues = args.revealValues === true;
  if (!revealValues) {
    try {
      const activityEntry = insertActivity({
        source: "credential-access",
        title: `Credential metadata read: "${record.cred.name}" (${record.cred.type})`,
        content: `Credential ${record.cred.id} metadata accessed via native__use_credential${context?.sessionId ? ` in session ${context.sessionId}` : ""}`,
      });
      const { getWSInstance } = await import("../../../gateway/ws-instance.ts");
      getWSInstance()?.broadcast({ type: "activity.new", data: activityEntry });
    } catch {
      /* best-effort logging */
    }
    return textJson(redacted);
  }

  const revealArgs = { credentialId: record.cred.id, type: record.cred.type, revealValues: true };
  const appendRevealAudit = async (allowed: boolean, error?: string | null) => {
    try {
      const { appendAudit } = await import("../../../db/audit-log-store.ts");
      appendAudit({
        eventType: allowed ? "credential.reveal.allowed" : "credential.reveal.denied",
        actorType: "session",
        actorId: context?.sessionId ?? null,
        resourceType: "credential",
        resourceId: record.cred.id,
        action: allowed ? "reveal" : "deny",
        error: error ?? null,
      });
    } catch {
      /* best-effort */
    }
  };

  if (!context?.sessionId) {
    await appendRevealAudit(false, "no session available for credential reveal approval");
    return textJson({
      ...redacted,
      hint: "values redacted — revealValues:true requires an interactive session approval",
    });
  }

  const { requestNativeApproval } = await import("../../approval-gate-hitl.ts");
  const { getLatestCheckpointForSession } = await import("../../../db/checkpoint-store.ts");
  const checkpointId = getLatestCheckpointForSession(context.sessionId)?.id ?? null;
  context.emitEvent?.({
    type: "security.approval.requested",
    data: {
      toolName: USE_CREDENTIAL_NAME,
      kind: "native",
      risk: "high",
      reasons: [
        {
          analyzer: "credential-reveal",
          risk: "high",
          reason: "explicit credential value reveal requested",
        },
      ],
      checkpointId,
    },
  });
  const outcome = await requestNativeApproval({
    sessionId: context.sessionId,
    actionId: null,
    toolName: USE_CREDENTIAL_NAME,
    kind: "native",
    args: revealArgs,
    risk: "high",
    reasons: ["explicit credential value reveal requested"],
    checkpointId,
    originClientId: context.originClientId,
  });

  if (!outcome.allowed) {
    context.emitEvent?.({
      type: "security.approval.resolved",
      data: {
        toolName: USE_CREDENTIAL_NAME,
        kind: "native",
        status: outcome.reason === "denied" ? "denied" : "expired",
        decision: outcome.record?.decision ?? null,
      },
    });
    await appendRevealAudit(false, outcome.reason);
    return textJson({ ...redacted, hint: `values redacted — reveal request ${outcome.reason}` });
  }

  const { withSecretSeal, extractSecretValues } = await import("../../credential-injector.ts");
  return withSecretSeal(extractSecretValues(record.data), async () => {
    context.emitEvent?.({
      type: "security.approval.resolved",
      data: {
        toolName: USE_CREDENTIAL_NAME,
        kind: "native",
        status: "allowed",
        decision: outcome.decision,
      },
    });
    await appendRevealAudit(true, null);
    const payload = {
      credentialId: record.cred.id,
      name: record.cred.name,
      type: record.cred.type,
      usage_context: usageContextList(record.cred.usageContext ?? providerUsage),
      fields: record.data,
      connectionHint: renderConnectionHint({
        cred: record.cred,
        data: record.data,
        providerUsage,
        reveal: true,
      }),
      audit: { approvalId: outcome.record.id, decidedAt: outcome.record.decidedAt },
    };
    return textJson(payload);
  });
};

export const DELETE_CREDENTIAL_NAME = "native__delete_credential";

export const deleteCredentialToolDef = tool({
  description:
    "[Delete Credential] Remove a saved credential by its ID. Use native__list_credentials first to find the ID.",
  parameters: z.object({
    id: z.string().describe("The credential ID to delete"),
  }),
});

export const handleDeleteCredential: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const { getCredentialData, deleteCredential } = await import("../../../db/credential-store.ts");
  const { tryRestartChannel } = await import("../../../routes/credentials.ts");
  const { invalidateToolCache } = await import("../../tool-builder.ts");
  const { mcpManager } = await import("../../mcp-manager.ts");

  const id = String(args.id);
  const record = getCredentialData(id);
  const deleted = deleteCredential(id);

  if (!deleted) {
    return {
      content: [{ type: "text", text: `Credential ${id} not found.` }],
    };
  }

  if (record) {
    tryRestartChannel(record.cred.type);
    try {
      await mcpManager.closeConnectionsForCredential(record.cred.type);
    } catch (err) {
      console.error(`[delete_credential] tool refresh failed for ${record.cred.type}:`, err);
    }
  }
  invalidateToolCache();

  return {
    content: [
      {
        type: "text",
        text: `Credential "${record?.cred.name}" (${record?.cred.type}) deleted.`,
      },
    ],
  };
};

export const TEST_CREDENTIAL_NAME = "native__test_credential";

export const testCredentialToolDef = tool({
  description:
    "[Test Credential] Verify that a saved credential works (e.g. test API key or bot token connectivity). Use native__list_credentials first to find the ID.",
  parameters: z.object({
    id: z.string().describe("The credential ID to test"),
  }),
});

export const handleTestCredential: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const { getCredentialData, updateTestStatus } = await import("../../../db/credential-store.ts");
  const { testProvider } = await import("../../../routes/provider-tester.ts");
  const { tryRestartChannel } = await import("../../../routes/credentials.ts");

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
