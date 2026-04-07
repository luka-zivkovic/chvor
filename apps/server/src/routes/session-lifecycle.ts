import { Hono } from "hono";
import type { UpdateSessionLifecycleRequest } from "@chvor/shared";
import { getSessionLifecycleConfig, updateSessionLifecycleConfig } from "../db/config-store.ts";
import { resetSession } from "../lib/session-reset.ts";

const sessionLifecycle = new Hono();

sessionLifecycle.get("/", (c) => {
  try {
    return c.json({ data: getSessionLifecycleConfig() });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

const VALID_CHAT_TYPES = new Set(["dm", "group", "thread"]);
const MAX_TRIGGERS = 50;

sessionLifecycle.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as UpdateSessionLifecycleRequest;

    // Validate resetTriggers
    if (body.resetTriggers !== undefined) {
      if (!Array.isArray(body.resetTriggers)) {
        return c.json({ error: "resetTriggers must be an array" }, 400);
      }
      if (body.resetTriggers.length > MAX_TRIGGERS) {
        return c.json({ error: `resetTriggers exceeds maximum of ${MAX_TRIGGERS}` }, 400);
      }
      if (body.resetTriggers.some((t) => typeof t !== "string" || t.length > 100)) {
        return c.json({ error: "Each trigger must be a string (max 100 chars)" }, 400);
      }
    }

    // Validate chatTypePolicies keys
    if (body.chatTypePolicies) {
      const invalidKeys = Object.keys(body.chatTypePolicies).filter((k) => !VALID_CHAT_TYPES.has(k));
      if (invalidKeys.length > 0) {
        return c.json({ error: `Invalid chat type(s): ${invalidKeys.join(", ")}` }, 400);
      }
    }

    const updated = updateSessionLifecycleConfig(body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

// Manual session reset (from UI or API)
sessionLifecycle.post("/reset/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  try {
    await resetSession(id, "manual");
    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

export default sessionLifecycle;
