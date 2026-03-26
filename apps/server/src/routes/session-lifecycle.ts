import { Hono } from "hono";
import type { UpdateSessionLifecycleRequest } from "@chvor/shared";
import { getSessionLifecycleConfig, updateSessionLifecycleConfig } from "../db/config-store.ts";
import { resetSession } from "../lib/session-reset.ts";

const sessionLifecycle = new Hono();

sessionLifecycle.get("/", (c) => {
  try {
    return c.json({ data: getSessionLifecycleConfig() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sessionLifecycle.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as UpdateSessionLifecycleRequest;
    const updated = updateSessionLifecycleConfig(body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Manual session reset (from UI or API)
sessionLifecycle.post("/reset/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  try {
    await resetSession(id, "manual");
    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default sessionLifecycle;
