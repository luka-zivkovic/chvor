import { Hono } from "hono";
import {
  listConnectedAgents,
  getAgent,
  disconnectAgent,
  getPcSafetyLevel,
  localBackendAvailable,
  getLocalBackend,
  getBackend,
  shutdownPcAgents,
} from "../lib/pc-control.ts";
import { setConfig, getPcControlEnabled, setPcControlEnabled } from "../db/config-store.ts";
import type { PcSafetyLevel } from "@chvor/shared";

const pcControl = new Hono();

/** List all connected PC agents (including local if available) */
pcControl.get("/connections", (c) => {
  const agents = listConnectedAgents();
  const local = getLocalBackend();
  const connections = local
    ? [{ id: "local", hostname: local.hostname, os: local.os, screenWidth: local.screenSize.width, screenHeight: local.screenSize.height, connectedAt: new Date().toISOString(), status: "connected" as const }, ...agents]
    : agents;
  return c.json({ data: connections });
});

/** Get a specific agent */
pcControl.get("/connections/:id", (c) => {
  const id = c.req.param("id");
  if (id === "local") {
    const local = getLocalBackend();
    if (!local) return c.json({ error: "Local backend not available" }, 404);
    return c.json({ data: { id: "local", hostname: local.hostname, os: local.os, screenWidth: local.screenSize.width, screenHeight: local.screenSize.height, connectedAt: new Date().toISOString(), status: "connected" } });
  }
  const agent = getAgent(id);
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  return c.json({ data: agent });
});

/** Take a screenshot */
pcControl.post("/screenshot/:id", async (c) => {
  if (!getPcControlEnabled()) return c.json({ error: "PC Control is disabled" }, 403);
  try {
    const backend = getBackend(c.req.param("id"));
    const screenshot = await backend.captureScreen();
    return c.json({ data: screenshot });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Execute a shell command on a PC — restricted to read-only inspection commands */
pcControl.post("/shell/:id", async (c) => {
  if (!getPcControlEnabled()) return c.json({ error: "PC Control is disabled" }, 403);
  return c.json({ error: "Shell execution via REST is not allowed. Use native__pc_shell tool instead." }, 403);
});

/** Disconnect an agent */
pcControl.delete("/connections/:id", (c) => {
  const id = c.req.param("id");
  if (id === "local") return c.json({ error: "Cannot disconnect local backend" }, 400);
  const ok = disconnectAgent(id);
  if (!ok) return c.json({ error: "Agent not found" }, 404);
  return c.json({ data: null });
});

/** Get PC control config (enabled + safety level + local availability) */
pcControl.get("/config", (c) => {
  return c.json({
    data: {
      enabled: getPcControlEnabled(),
      safetyLevel: getPcSafetyLevel(),
      localAvailable: localBackendAvailable(),
    },
  });
});

/** Update PC control config */
pcControl.put("/config", async (c) => {
  try {
    const body = await c.req.json() as { enabled?: boolean; safetyLevel?: PcSafetyLevel };
    if (body.enabled !== undefined) {
      setPcControlEnabled(body.enabled);
      // Disconnect all remote agents when disabling
      if (!body.enabled) shutdownPcAgents();
    }
    if (body.safetyLevel !== undefined) {
      const valid: PcSafetyLevel[] = ["supervised", "semi-autonomous", "autonomous"];
      if (!valid.includes(body.safetyLevel)) {
        return c.json({ error: "Invalid safety level" }, 400);
      }
      setConfig("pc_safety_level", body.safetyLevel);
    }
    return c.json({
      data: {
        enabled: getPcControlEnabled(),
        safetyLevel: getPcSafetyLevel(),
        localAvailable: localBackendAvailable(),
      },
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

export default pcControl;
