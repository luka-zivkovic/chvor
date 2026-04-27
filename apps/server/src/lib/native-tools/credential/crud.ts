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

export const handleListCredentials: NativeToolHandler = async (): Promise<NativeToolResult> => {
  const { listCredentials } = await import("../../../db/credential-store.ts");
  const { INTEGRATION_PROVIDERS } = await import("../../provider-registry.ts");
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

export const USE_CREDENTIAL_NAME = "native__use_credential";

export const useCredentialToolDef = tool({
  description:
    "[Use Credential] Retrieve full (unredacted) credential data by ID for making authenticated API calls. Use native__list_credentials first to find the ID, then this tool to get the actual secret values needed for request headers.",
  parameters: z.object({
    id: z.string().describe("The credential ID to retrieve"),
  }),
});

export const handleUseCredential: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const { getCredentialData } = await import("../../../db/credential-store.ts");
  const { INTEGRATION_PROVIDERS } = await import("../../provider-registry.ts");
  const { registerSecretValues } = await import("../../sensitive-filter.ts");

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
    const { getWSInstance } = await import("../../../gateway/ws-instance.ts");
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
  const { getCredentialData, deleteCredential } = await import(
    "../../../db/credential-store.ts"
  );
  const { tryRestartChannel } = await import("../../../routes/credentials.ts");

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
  const { getCredentialData, updateTestStatus } = await import(
    "../../../db/credential-store.ts"
  );
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
