import { Hono } from "hono";
import type { UpdateRetentionRequest } from "@chvor/shared";
import { getRetentionConfig, updateRetentionConfig } from "../db/config-store.ts";

const retention = new Hono();

function validateMaxAgeDays(
  body: UpdateRetentionRequest,
  field: "sessionMaxAgeDays" | "trajectoryMaxAgeDays"
): string | undefined {
  const value = body[field];
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    return `${field} must be a non-negative number`;
  }
  return undefined;
}

retention.get("/", (c) => {
  try {
    return c.json({ data: getRetentionConfig() });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

retention.patch("/", async (c) => {
  try {
    let parsedBody: unknown;
    try {
      parsedBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
      return c.json({ error: "JSON body must be an object" }, 400);
    }
    const body = parsedBody as UpdateRetentionRequest;
    for (const field of ["sessionMaxAgeDays", "trajectoryMaxAgeDays"] as const) {
      const validationError = validateMaxAgeDays(body, field);
      if (validationError) return c.json({ error: validationError }, 400);
    }
    if (body.archiveBeforeDelete !== undefined && typeof body.archiveBeforeDelete !== "boolean") {
      return c.json({ error: "archiveBeforeDelete must be a boolean" }, 400);
    }
    const updated = updateRetentionConfig(body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});

export default retention;
