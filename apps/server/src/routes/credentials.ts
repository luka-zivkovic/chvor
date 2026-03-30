import { Hono } from "hono";
import type { CreateCredentialRequest, UpdateCredentialRequest, TestCredentialRequest } from "@chvor/shared";
import {
  listCredentials,
  createCredential,
  updateCredential,
  deleteCredential,
  getCredentialData,
  updateTestStatus,
} from "../db/credential-store.ts";
import { clearModelCache } from "../lib/model-fetcher.ts";
import { testProvider } from "./provider-tester.ts";
import { getGatewayInstance } from "../gateway/gateway-instance.ts";
import { invalidateToolCache } from "../lib/tool-builder.ts";
import { mcpManager } from "../lib/mcp-manager.ts";

/** Credential types that map to channel adapters. */
const CHANNEL_CRED_MAP: Record<string, string> = {
  telegram: "telegram",
  discord: "discord",
  slack: "slack",
  whatsapp: "whatsapp",
};

export function tryRestartChannel(credType: string): void {
  const channelType = CHANNEL_CRED_MAP[credType];
  if (!channelType) return;
  const gw = getGatewayInstance();
  if (gw) {
    gw.restartChannel(channelType).catch((err) =>
      console.error(`[credentials] restart ${channelType} failed:`, err)
    );
  }
}

/** Kill stale MCP connections and invalidate tool cache so tools re-spawn with fresh credentials. */
async function refreshToolsForCredential(credType: string): Promise<void> {
  try {
    await mcpManager.closeConnectionsForCredential(credType);
    invalidateToolCache();
  } catch (err) {
    console.error(`[credentials] tool refresh failed for ${credType}:`, err);
  }
}

const credentials = new Hono();

// GET /api/credentials — list all (redacted)
credentials.get("/", (c) => {
  try {
    return c.json({ data: listCredentials() });
  } catch (err) {
    console.error("[api] GET /credentials error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/credentials — create new
credentials.post("/", async (c) => {
  try {
    const body = await c.req.json<CreateCredentialRequest>();
    if (!body.name || !body.type || !body.data) {
      return c.json({ error: "name, type, and data are required" }, 400);
    }
    const summary = createCredential(body.name, body.type, body.data, body.usageContext);
    clearModelCache();
    tryRestartChannel(body.type);
    await refreshToolsForCredential(body.type);
    return c.json({ data: summary }, 201);
  } catch (err) {
    console.error("[api] POST /credentials error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// PUT /api/credentials/:id — update name and/or data
credentials.put("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<UpdateCredentialRequest>();
    if (!body.name && !body.data && body.usageContext === undefined) {
      return c.json({ error: "name, data, or usageContext is required" }, 400);
    }
    const record = getCredentialData(id);
    if (!record) return c.json({ error: "not found" }, 404);

    const summary = updateCredential(id, body.name, body.data, body.usageContext);
    if (!summary) return c.json({ error: "not found" }, 404);

    if (body.data) {
      clearModelCache();
      tryRestartChannel(record.cred.type);
      await refreshToolsForCredential(record.cred.type);
    }
    return c.json({ data: summary });
  } catch (err) {
    console.error("[api] PUT /credentials/:id error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/credentials/test — test without saving
// IMPORTANT: registered before /:id to avoid route conflict
credentials.post("/test", async (c) => {
  try {
    const body = await c.req.json<TestCredentialRequest>();
    if (!body.type || !body.data) {
      return c.json({ error: "type and data are required" }, 400);
    }
    const result = await testProvider(body.type, body.data);
    return c.json({ data: result });
  } catch (err) {
    console.error("[api] POST /credentials/test error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/credentials/:id/test — test saved credential
credentials.post("/:id/test", async (c) => {
  try {
    const id = c.req.param("id");
    const record = getCredentialData(id);
    if (!record) return c.json({ error: "not found" }, 404);

    const result = await testProvider(record.cred.type, record.data);
    updateTestStatus(id, result.success ? "success" : "failed");
    if (result.success) {
      tryRestartChannel(record.cred.type);
      await refreshToolsForCredential(record.cred.type);
    }
    return c.json({ data: result });
  } catch (err) {
    console.error("[api] POST /credentials/:id/test error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// DELETE /api/credentials/:id
credentials.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    // Look up credential type before deleting so we can restart the channel
    const record = getCredentialData(id);
    const deleted = deleteCredential(id);
    if (!deleted) return c.json({ error: "not found" }, 404);
    clearModelCache();
    if (record) {
      tryRestartChannel(record.cred.type);
      await refreshToolsForCredential(record.cred.type);
    }
    return c.json({ data: null });
  } catch (err) {
    console.error("[api] DELETE /credentials/:id error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

export default credentials;
