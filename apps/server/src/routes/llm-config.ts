import { Hono } from "hono";
import { getRoleConfig, setRoleConfig, getExtendedThinking, setExtendedThinking } from "../db/config-store.ts";

const llmConfig = new Hono();

// Backward-compatible endpoint — delegates to primary role
llmConfig.get("/", (c) => {
  const primary = getRoleConfig("primary");
  return c.json({ data: primary });
});

llmConfig.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as { providerId: string; model: string };
    if (!body.providerId || !body.model) {
      return c.json({ error: "providerId and model are required" }, 400);
    }
    const result = setRoleConfig("primary", body.providerId, body.model);
    return c.json({ data: result });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Extended Thinking config
llmConfig.get("/thinking", (c) => {
  return c.json({ data: getExtendedThinking() });
});

llmConfig.patch("/thinking", async (c) => {
  try {
    const body = (await c.req.json()) as { enabled?: boolean; budgetTokens?: number };
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled (boolean) is required" }, 400);
    }
    if (body.budgetTokens !== undefined && (typeof body.budgetTokens !== "number" || !Number.isFinite(body.budgetTokens))) {
      return c.json({ error: "budgetTokens must be a finite number" }, 400);
    }
    const result = setExtendedThinking(body.enabled, body.budgetTokens);
    return c.json({ data: result });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default llmConfig;
