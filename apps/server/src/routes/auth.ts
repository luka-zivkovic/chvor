import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  isAuthEnabled,
  isAuthSetupComplete,
  getAuthMethod,
  setupPassword,
  setupPin,
  verifyCredential,
  createSession,
  destroySession,
  destroyAllSessions,
  destroySessionById,
  listSessions,
  resetWithRecoveryKey,
  enableAuth,
  disableAuth,
  validateSession,
} from "../db/auth-store.ts";
import {
  generateApiKey,
  revokeApiKey,
  listApiKeys,
} from "../db/api-key-store.ts";

const auth = new Hono();

const MAX_PASSWORD_LENGTH = 256;
const MAX_PIN_LENGTH = 64;

/** Detect HTTPS from request URL or reverse-proxy headers */
function isSecure(c: { req: { url: string; header: (name: string) => string | undefined } }): boolean {
  return c.req.url.startsWith("https") || c.req.header("x-forwarded-proto") === "https";
}

// ── Unauthenticated endpoints ────────────────────────────────────

auth.get("/status", (c) => {
  const enabled = isAuthEnabled();
  let authenticated = !enabled; // if auth is off, everyone is authenticated

  if (enabled) {
    // Check if the current request has a valid session cookie
    const cookie = getCookie(c, "chvor_session");
    if (cookie) {
      authenticated = validateSession(cookie).valid;
    }
  }

  return c.json({
    data: {
      enabled,
      setupComplete: isAuthSetupComplete(),
      method: getAuthMethod(),
      authenticated,
    },
  });
});

auth.post("/setup", async (c) => {
  if (isAuthSetupComplete()) {
    return c.json({ error: "Auth already configured. Use recovery flow to reconfigure." }, 400);
  }

  const body = await c.req.json<{
    method: "password" | "pin";
    username?: string;
    password?: string;
    pin?: string;
  }>();

  if (body.method === "password") {
    if (!body.username || !body.password) {
      return c.json({ error: "Username and password required" }, 400);
    }
    if (body.password.length < 6) {
      return c.json({ error: "Password must be at least 6 characters" }, 400);
    }
    if (body.password.length > MAX_PASSWORD_LENGTH) {
      return c.json({ error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` }, 400);
    }
    const result = await setupPassword(body.username, body.password);

    // Auto-create a session so user is logged in after setup
    const session = createSession(
      c.req.header("User-Agent"),
      c.req.header("X-Forwarded-For") ?? c.req.header("X-Real-IP")
    );
    setCookie(c, "chvor_session", session.token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
      secure: isSecure(c),
    });

    return c.json({ data: { recoveryKey: result.recoveryKey } });
  }

  if (body.method === "pin") {
    if (!body.pin) {
      return c.json({ error: "PIN required" }, 400);
    }
    if (body.pin.length < 6) {
      return c.json({ error: "PIN must be at least 6 characters" }, 400);
    }
    if (body.pin.length > MAX_PIN_LENGTH) {
      return c.json({ error: `PIN must be at most ${MAX_PIN_LENGTH} characters` }, 400);
    }
    const result = await setupPin(body.pin);

    const session = createSession(
      c.req.header("User-Agent"),
      c.req.header("X-Forwarded-For") ?? c.req.header("X-Real-IP")
    );
    setCookie(c, "chvor_session", session.token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
      secure: isSecure(c),
    });

    return c.json({ data: { recoveryKey: result.recoveryKey } });
  }

  return c.json({ error: "Invalid method" }, 400);
});

auth.post("/login", async (c) => {
  if (!isAuthEnabled()) {
    return c.json({ error: "Auth is not enabled" }, 400);
  }

  const body = await c.req.json<{
    username?: string;
    password?: string;
    pin?: string;
  }>();

  const method = getAuthMethod();
  const credential = method === "password" ? body.password : body.pin;
  if (!credential) {
    return c.json({ error: `${method === "password" ? "Password" : "PIN"} required` }, 400);
  }
  const maxLen = method === "password" ? MAX_PASSWORD_LENGTH : MAX_PIN_LENGTH;
  if (credential.length > maxLen) {
    return c.json({ error: "Credential too long" }, 400);
  }

  const result = await verifyCredential(credential, body.username);
  if (!result.valid) {
    if (result.reason === "locked_out") {
      const minutes = Math.ceil(result.retryAfter / 60);
      return c.json({ error: `Too many failed attempts. Try again in ${minutes} minute${minutes > 1 ? "s" : ""}.` }, 429);
    }
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const session = createSession(
    c.req.header("User-Agent"),
    c.req.header("X-Forwarded-For") ?? c.req.header("X-Real-IP")
  );

  setCookie(c, "chvor_session", session.token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    secure: isSecure(c),
  });

  return c.json({ data: { expiresAt: session.expiresAt } });
});

auth.post("/recover", async (c) => {
  const body = await c.req.json<{
    recoveryKey: string;
    method: "password" | "pin";
    username?: string;
    password?: string;
    pin?: string;
  }>();

  if (!body.recoveryKey) {
    return c.json({ error: "Recovery key required" }, 400);
  }

  const credential = body.method === "password" ? body.password : body.pin;
  if (!credential) {
    return c.json({ error: "New credential required" }, 400);
  }
  if (body.method === "password" && credential.length < 6) {
    return c.json({ error: "Password must be at least 6 characters" }, 400);
  }
  if (body.method === "pin" && credential.length < 6) {
    return c.json({ error: "PIN must be at least 6 characters" }, 400);
  }
  const maxLen = body.method === "password" ? MAX_PASSWORD_LENGTH : MAX_PIN_LENGTH;
  if (credential.length > maxLen) {
    return c.json({ error: "Credential too long" }, 400);
  }

  try {
    const result = await resetWithRecoveryKey(
      body.recoveryKey,
      body.method,
      credential,
      body.username
    );
    return c.json({ data: { recoveryKey: result.recoveryKey } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid recovery key";
    if (msg.startsWith("Too many failed recovery attempts")) {
      return c.json({ error: msg }, 429);
    }
    return c.json({ error: "Invalid recovery key" }, 400);
  }
});

// ── Authenticated endpoints ──────────────────────────────────────
// These require the chvorAuth middleware to have already run

auth.post("/logout", (c) => {
  const cookie = getCookie(c, "chvor_session");
  if (cookie) {
    destroySession(cookie);
    deleteCookie(c, "chvor_session", { path: "/" });
  }
  return c.json({ data: null });
});

auth.post("/logout-all", (c) => {
  destroyAllSessions();
  deleteCookie(c, "chvor_session", { path: "/" });
  return c.json({ data: null });
});

auth.post("/disable", async (c) => {
  // Only session-based auth can disable — API keys must not disable the auth system
  const authType = c.get("authType" as never) as string | undefined;
  if (authType === "apikey") {
    return c.json({ error: "API keys cannot disable authentication. Use a browser session." }, 403);
  }

  // Require current credential for re-authentication
  const body = await c.req.json<{ password?: string; pin?: string; username?: string }>().catch(() => ({} as { password?: string; pin?: string; username?: string }));
  const method = getAuthMethod();
  const credential = method === "password" ? body.password : body.pin;
  if (!credential) {
    return c.json({ error: `Current ${method === "password" ? "password" : "PIN"} required to disable auth` }, 400);
  }

  const result = await verifyCredential(credential, body.username);
  if (!result.valid) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  disableAuth();
  deleteCookie(c, "chvor_session", { path: "/" });
  return c.json({ data: null });
});

auth.get("/sessions", (c) => {
  const currentToken = getCookie(c, "chvor_session");
  const sessions = listSessions();
  const currentSessionResult = currentToken ? validateSession(currentToken) : null;

  return c.json({
    data: sessions.map((s) => ({
      ...s,
      current: currentSessionResult?.sessionId === s.id,
    })),
  });
});

auth.delete("/sessions/:id", (c) => {
  const id = c.req.param("id");
  destroySessionById(id);
  return c.json({ data: null });
});

// ── API Key management ───────────────────────────────────────────

auth.get("/api-keys", (c) => {
  return c.json({ data: listApiKeys() });
});

auth.post("/api-keys", async (c) => {
  const body = await c.req.json<{ name: string; expiresInDays?: number }>();
  if (!body.name) {
    return c.json({ error: "Name required" }, 400);
  }
  const result = generateApiKey(body.name, body.expiresInDays);
  return c.json({ data: result });
});

auth.delete("/api-keys/:id", (c) => {
  const id = c.req.param("id");
  const revoked = revokeApiKey(id);
  if (!revoked) {
    return c.json({ error: "API key not found or already revoked" }, 404);
  }
  return c.json({ data: null });
});

export default auth;
