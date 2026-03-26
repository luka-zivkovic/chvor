import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { isAuthEnabled } from "../db/auth-store.ts";
import { validateSession } from "../db/auth-store.ts";
import { validateApiKey } from "../db/api-key-store.ts";

export type AuthEnv = {
  Variables: {
    authType?: "session" | "apikey";
    sessionId?: string;
    apiKeyId?: string;
  };
};

export const chvorAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const path = new URL(c.req.url).pathname;

  // Webhook receiver endpoints have their own signature verification
  if (path.match(/^\/api\/webhooks\/[^/]+\/receive$/)) return next();

  // Auth endpoints that must work without authentication
  if (
    path === "/api/auth/status" ||
    path === "/api/auth/setup" ||
    path === "/api/auth/login" ||
    path === "/api/auth/recover"
  ) {
    return next();
  }

  // If auth is not enabled, allow all requests
  if (!isAuthEnabled()) return next();

  // 1. Check session cookie (browser UI)
  const cookie = getCookie(c, "chvor_session");
  if (cookie) {
    const result = validateSession(cookie);
    if (result.valid) {
      c.set("authType", "session");
      c.set("sessionId", result.sessionId);
      return next();
    }
  }

  // 2. Check Authorization header
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // API key: starts with "chvor_"
    if (token.startsWith("chvor_")) {
      const result = validateApiKey(token);
      if (result.valid) {
        c.set("authType", "apikey");
        c.set("apiKeyId", result.keyId);
        return next();
      }
    } else {
      // Session token via header (for non-cookie clients)
      const result = validateSession(token);
      if (result.valid) {
        c.set("authType", "session");
        c.set("sessionId", result.sessionId);
        return next();
      }
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});
