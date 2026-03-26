import { Hono } from "hono";
import type { UpdateRetentionRequest } from "@chvor/shared";
import { getRetentionConfig, updateRetentionConfig } from "../db/config-store.ts";

const retention = new Hono();

retention.get("/", (c) => {
  try {
    return c.json({ data: getRetentionConfig() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

retention.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as UpdateRetentionRequest;
    if (body.sessionMaxAgeDays !== undefined) {
      if (typeof body.sessionMaxAgeDays !== "number" || body.sessionMaxAgeDays < 0) {
        return c.json({ error: "sessionMaxAgeDays must be a non-negative number" }, 400);
      }
    }
    const updated = updateRetentionConfig(body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default retention;
