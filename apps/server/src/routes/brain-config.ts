import { Hono } from "hono";
import type { UpdateBrainConfigRequest } from "@chvor/shared";
import { getBrainConfig, updateBrainConfig, getSelfHealingEnabled, setSelfHealingEnabled, getConfig } from "../db/config-store.ts";
import { initManifest, shutdownManifest } from "../lib/health-manifest.ts";
import { getErrorStats } from "../lib/error-logger.ts";

const brainConfig = new Hono();

brainConfig.get("/", (c) => {
  try {
    return c.json({ data: getBrainConfig() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

brainConfig.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as UpdateBrainConfigRequest;
    if (body.maxToolRounds !== undefined) {
      if (typeof body.maxToolRounds !== "number" || body.maxToolRounds < 1 || body.maxToolRounds > 100) {
        return c.json({ error: "maxToolRounds must be a number between 1 and 100" }, 400);
      }
    }
    if (body.memoryBatchSize !== undefined) {
      if (typeof body.memoryBatchSize !== "number" || body.memoryBatchSize < 1 || body.memoryBatchSize > 20) {
        return c.json({ error: "memoryBatchSize must be a number between 1 and 20" }, 400);
      }
    }
    if (body.lowTokenMode !== undefined) {
      if (typeof body.lowTokenMode !== "boolean") {
        return c.json({ error: "lowTokenMode must be a boolean" }, 400);
      }
    }
    const updated = updateBrainConfig(body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// --- Self-Healing toggle ---

brainConfig.get("/self-healing", (c) => {
  return c.json({ data: { enabled: getSelfHealingEnabled() } });
});

brainConfig.patch("/self-healing", async (c) => {
  try {
    const body = (await c.req.json()) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    setSelfHealingEnabled(body.enabled);
    // Start or stop the health manifest timer accordingly
    if (body.enabled) {
      initManifest();
    } else {
      shutdownManifest();
    }
    return c.json({ data: { enabled: body.enabled } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

brainConfig.get("/self-healing/status", (c) => {
  const enabled = getSelfHealingEnabled();
  const stats = getErrorStats();
  const lastRepairAt = getConfig("selfHealing.lastRepairAt");
  return c.json({
    data: { enabled, errors24h: stats.last24h, lastRepairAt: lastRepairAt || null },
  });
});

export default brainConfig;
