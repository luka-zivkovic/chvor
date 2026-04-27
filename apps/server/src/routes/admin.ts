import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { logger } from "../lib/logger.ts";

/**
 * Admin endpoints for the desktop wrapper / CLI to drive the daemon lifecycle.
 *
 * These are guarded by:
 *   1. Localhost-only — never reachable from the network.
 *   2. CHVOR_TOKEN — bearer-token check (timing-safe).
 *
 * The shutdown handler is registered by the host process (src/index.ts) at boot.
 */
let shutdownHandler: (() => Promise<void>) | null = null;

export function registerShutdownHandler(handler: () => Promise<void>): void {
  shutdownHandler = handler;
}

interface NodeEnvShape {
  incoming?: { socket?: { remoteAddress?: string } };
}

function isLocalhost(c: { env?: unknown }): boolean {
  const env = c.env as NodeEnvShape | undefined;
  const ip = env?.incoming?.socket?.remoteAddress ?? "";
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip);
}

function verifyToken(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const len = Math.max(a.length, b.length);
  const aPad = Buffer.concat([a, Buffer.alloc(len - a.length)]);
  const bPad = Buffer.concat([b, Buffer.alloc(len - b.length)]);
  return timingSafeEqual(aPad, bPad) && a.length === b.length;
}

const admin = new Hono();

admin.post("/shutdown", async (c) => {
  if (!isLocalhost(c)) {
    return c.json({ error: "admin endpoints are localhost-only" }, 403);
  }

  const expected = process.env.CHVOR_TOKEN;
  if (expected) {
    const auth = c.req.header("Authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!verifyToken(provided, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
  }

  if (!shutdownHandler) {
    return c.json({ error: "shutdown handler not registered" }, 503);
  }

  // Respond immediately, then trigger shutdown on next tick so the response
  // can flush before sockets close.
  logger.info({ source: "admin" }, "graceful shutdown requested via API");
  setImmediate(() => {
    void shutdownHandler!().catch((err) => {
      logger.error({ err }, "graceful shutdown failed");
      process.exit(1);
    });
  });
  return c.json({ ok: true, message: "shutdown initiated" });
});

export default admin;
