import { Hono } from "hono";
import type { UpdateTelemetryRequest } from "@chvor/shared";
import { getTelemetryConfig, updateTelemetryConfig } from "../db/config-store.ts";

const telemetry = new Hono();

telemetry.get("/", (c) => {
  try {
    return c.json({ data: getTelemetryConfig() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

telemetry.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as UpdateTelemetryRequest;
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    const updated = updateTelemetryConfig(body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default telemetry;
