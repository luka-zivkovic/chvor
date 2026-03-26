import { Hono } from "hono";
import type { UpdatePulseRequest } from "@chvor/shared";
import { getPulseConfig, updatePulseConfig } from "../db/config-store.ts";
import { syncPulse } from "../lib/pulse-engine.ts";

const pulse = new Hono();

pulse.get("/", (c) => {
  try {
    return c.json({ data: getPulseConfig() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

pulse.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as UpdatePulseRequest;
    const updated = updatePulseConfig(body);
    syncPulse();
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default pulse;
