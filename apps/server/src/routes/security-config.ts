import { Hono } from "hono";
import {
  getAllowLocalhost,
  setAllowLocalhost,
  getFilesystemConfig,
  updateFilesystemConfig,
  getTrustedCommands,
  addTrustedCommand,
  removeTrustedCommand,
} from "../db/config-store.ts";
import type { UpdateFilesystemConfigRequest } from "@chvor/shared";

const securityConfig = new Hono();

securityConfig.get("/", (c) => {
  return c.json({ data: { allowLocalhost: getAllowLocalhost() } });
});

securityConfig.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as { allowLocalhost?: boolean };
    if (body.allowLocalhost !== undefined) {
      setAllowLocalhost(body.allowLocalhost);
    }
    return c.json({ data: { allowLocalhost: getAllowLocalhost() } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Filesystem config ──────────────────────────────────────────

securityConfig.get("/filesystem", (c) => {
  return c.json({ data: getFilesystemConfig() });
});

securityConfig.patch("/filesystem", async (c) => {
  try {
    const body = (await c.req.json()) as UpdateFilesystemConfigRequest;
    if (body.allowedPaths !== undefined) {
      if (!Array.isArray(body.allowedPaths)) return c.json({ error: "allowedPaths must be an array" }, 400);
      if (body.allowedPaths.length > 50) return c.json({ error: "Too many paths (max 50)" }, 400);
      for (const p of body.allowedPaths) {
        if (typeof p !== "string" || !p.trim()) return c.json({ error: "Each path must be a non-empty string" }, 400);
        if (p.length > 1024) return c.json({ error: "Path too long (max 1024 chars)" }, 400);
      }
    }
    const updated = updateFilesystemConfig(body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Trusted commands (Always Allow) ────────────────────────────

securityConfig.get("/trusted", (c) => {
  return c.json({ data: getTrustedCommands() });
});

securityConfig.post("/trusted", async (c) => {
  try {
    const { kind, pattern } = (await c.req.json()) as { kind: string; pattern: string };
    if (!["shell", "pc"].includes(kind) || !pattern?.trim()) {
      return c.json({ error: "Invalid kind or pattern" }, 400);
    }
    if (pattern.trim().length > 512) {
      return c.json({ error: "Pattern too long (max 512 chars)" }, 400);
    }
    const updated = addTrustedCommand(kind as "shell" | "pc", pattern.trim());
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

securityConfig.delete("/trusted", async (c) => {
  try {
    const { kind, pattern } = (await c.req.json()) as { kind: string; pattern: string };
    if (!["shell", "pc"].includes(kind) || !pattern?.trim()) {
      return c.json({ error: "Invalid kind or pattern" }, 400);
    }
    const updated = removeTrustedCommand(kind as "shell" | "pc", pattern.trim());
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default securityConfig;
