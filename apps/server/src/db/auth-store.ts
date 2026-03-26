import { randomBytes, createHash } from "node:crypto";
import { getDb } from "./database.ts";

// Lazy-load argon2 to avoid hard crash if not yet installed
let _argon2: typeof import("argon2") | null = null;
async function getArgon2() {
  if (!_argon2) _argon2 = await import("argon2");
  return _argon2;
}

// ── Helpers ──────────────────────────────────────────────────────

function getAuthConfig(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM auth_config WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setAuthConfig(key: string, value: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO auth_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, now);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// Recovery key: 8 groups of 4 chars (no ambiguous chars I/O/0/1)
const RECOVERY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateRecoveryKey(): string {
  const groups: string[] = [];
  for (let g = 0; g < 8; g++) {
    let group = "";
    const bytes = randomBytes(4);
    for (let i = 0; i < 4; i++) {
      group += RECOVERY_CHARS[bytes[i] % RECOVERY_CHARS.length];
    }
    groups.push(group);
  }
  return groups.join("-");
}

// ── Auth State ───────────────────────────────────────────────────

export function isAuthEnabled(): boolean {
  return getAuthConfig("auth.enabled") === "true";
}

export function isAuthSetupComplete(): boolean {
  return getAuthConfig("auth.setup_complete") === "true";
}

export function getAuthMethod(): "password" | "pin" | null {
  const method = getAuthConfig("auth.method");
  if (method === "password" || method === "pin") return method;
  return null;
}

export function enableAuth(): void {
  setAuthConfig("auth.enabled", "true");
}

export function disableAuth(): void {
  setAuthConfig("auth.enabled", "false");
  // Destroy all sessions when disabling auth
  const db = getDb();
  db.prepare("DELETE FROM auth_sessions").run();
}

// ── Setup ────────────────────────────────────────────────────────

export async function setupPassword(
  username: string,
  password: string
): Promise<{ recoveryKey: string }> {
  const argon2 = await getArgon2();
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const recoveryKey = generateRecoveryKey();
  const recoveryHash = await argon2.hash(recoveryKey.replace(/-/g, ""), {
    type: argon2.argon2id,
  });

  const db = getDb();
  db.transaction(() => {
    setAuthConfig("auth.method", "password");
    setAuthConfig("auth.username", username);
    setAuthConfig("auth.credential_hash", hash);
    setAuthConfig("auth.recovery_key_hash", recoveryHash);
    setAuthConfig("auth.setup_complete", "true");
    setAuthConfig("auth.enabled", "true");
    setAuthConfig("auth.failed_attempts", "0");
  })();

  return { recoveryKey };
}

export async function setupPin(
  pin: string
): Promise<{ recoveryKey: string }> {
  const argon2 = await getArgon2();
  const hash = await argon2.hash(pin, { type: argon2.argon2id });
  const recoveryKey = generateRecoveryKey();
  const recoveryHash = await argon2.hash(recoveryKey.replace(/-/g, ""), {
    type: argon2.argon2id,
  });

  const db = getDb();
  db.transaction(() => {
    setAuthConfig("auth.method", "pin");
    setAuthConfig("auth.credential_hash", hash);
    setAuthConfig("auth.recovery_key_hash", recoveryHash);
    setAuthConfig("auth.setup_complete", "true");
    setAuthConfig("auth.enabled", "true");
    setAuthConfig("auth.failed_attempts", "0");
  })();

  return { recoveryKey };
}

// ── Login ────────────────────────────────────────────────────────

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: "locked_out"; retryAfter: number }
  | { valid: false; reason: "invalid" };

export async function verifyCredential(
  credential: string,
  username?: string
): Promise<VerifyResult> {
  // Check lockout
  const lockoutUntil = getAuthConfig("auth.lockout_until");
  if (lockoutUntil && new Date(lockoutUntil) > new Date()) {
    const retryAfter = Math.ceil((new Date(lockoutUntil).getTime() - Date.now()) / 1000);
    return { valid: false, reason: "locked_out", retryAfter };
  }

  // For password method, verify username matches
  const method = getAuthMethod();
  if (method === "password" && username !== undefined) {
    const storedUsername = getAuthConfig("auth.username");
    if (storedUsername && username !== storedUsername) {
      const attempts = parseInt(getAuthConfig("auth.failed_attempts") ?? "0", 10) + 1;
      setAuthConfig("auth.failed_attempts", String(attempts));
      if (attempts >= 5) {
        const lockout = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        setAuthConfig("auth.lockout_until", lockout);
        setAuthConfig("auth.failed_attempts", "0");
      }
      return { valid: false, reason: "invalid" };
    }
  }

  const storedHash = getAuthConfig("auth.credential_hash");
  if (!storedHash) return { valid: false, reason: "invalid" };

  const argon2 = await getArgon2();
  const valid = await argon2.verify(storedHash, credential);

  if (!valid) {
    const attempts = parseInt(getAuthConfig("auth.failed_attempts") ?? "0", 10) + 1;
    setAuthConfig("auth.failed_attempts", String(attempts));
    if (attempts >= 5) {
      const lockout = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      setAuthConfig("auth.lockout_until", lockout);
      setAuthConfig("auth.failed_attempts", "0");
    }
    return { valid: false, reason: "invalid" };
  }

  // Reset on success
  setAuthConfig("auth.failed_attempts", "0");
  setAuthConfig("auth.lockout_until", "");
  return { valid: true };
}

// ── Sessions ─────────────────────────────────────────────────────

export function createSession(
  userAgent?: string,
  ipAddress?: string
): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
  const id = randomBytes(16).toString("hex");

  const db = getDb();
  db.prepare(
    `INSERT INTO auth_sessions (id, token_hash, user_agent, ip_address, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    tokenHash,
    userAgent ?? null,
    ipAddress ?? null,
    now.toISOString(),
    expiresAt.toISOString(),
    now.toISOString()
  );

  return { token, expiresAt: expiresAt.toISOString() };
}

export function validateSession(
  token: string
): { valid: boolean; sessionId?: string } {
  const tokenHash = sha256(token);
  const db = getDb();
  const row = db
    .prepare("SELECT id, expires_at FROM auth_sessions WHERE token_hash = ?")
    .get(tokenHash) as { id: string; expires_at: string } | undefined;

  if (!row) return { valid: false };
  if (new Date(row.expires_at) < new Date()) {
    // Expired — clean up
    db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(row.id);
    return { valid: false };
  }

  // Update last_active_at
  db.prepare("UPDATE auth_sessions SET last_active_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.id
  );

  return { valid: true, sessionId: row.id };
}

export function destroySession(token: string): void {
  const tokenHash = sha256(token);
  const db = getDb();
  db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
}

export function destroySessionById(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(id);
}

export function destroyAllSessions(): void {
  const db = getDb();
  db.prepare("DELETE FROM auth_sessions").run();
}

export function listSessions(): Array<{
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  lastActiveAt: string;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, user_agent, ip_address, created_at, expires_at, last_active_at FROM auth_sessions ORDER BY last_active_at DESC"
    )
    .all() as Array<{
    id: string;
    user_agent: string | null;
    ip_address: string | null;
    created_at: string;
    expires_at: string;
    last_active_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    userAgent: r.user_agent,
    ipAddress: r.ip_address,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastActiveAt: r.last_active_at,
  }));
}

// ── Recovery ─────────────────────────────────────────────────────

export async function resetWithRecoveryKey(
  recoveryKey: string,
  newMethod: "password" | "pin",
  newCredential: string,
  newUsername?: string
): Promise<{ recoveryKey: string }> {
  // Rate-limit recovery attempts (same pattern as login lockout)
  const lockoutUntil = getAuthConfig("auth.recovery_lockout_until");
  if (lockoutUntil && new Date(lockoutUntil) > new Date()) {
    const retryAfter = Math.ceil((new Date(lockoutUntil).getTime() - Date.now()) / 1000);
    const minutes = Math.ceil(retryAfter / 60);
    throw new Error(`Too many failed recovery attempts. Try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`);
  }

  const storedHash = getAuthConfig("auth.recovery_key_hash");
  if (!storedHash) throw new Error("No recovery key configured");

  const argon2 = await getArgon2();
  const normalized = recoveryKey.replace(/-/g, "").toUpperCase();
  const valid = await argon2.verify(storedHash, normalized);
  if (!valid) {
    // Track failed recovery attempts
    const attempts = parseInt(getAuthConfig("auth.recovery_failed_attempts") ?? "0", 10) + 1;
    setAuthConfig("auth.recovery_failed_attempts", String(attempts));
    if (attempts >= 5) {
      const lockout = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min lockout
      setAuthConfig("auth.recovery_lockout_until", lockout);
      setAuthConfig("auth.recovery_failed_attempts", "0");
    }
    throw new Error("Invalid recovery key");
  }

  // Hash new credential
  const newHash = await argon2.hash(newCredential, { type: argon2.argon2id });

  // Generate new recovery key
  const newRecoveryKey = generateRecoveryKey();
  const newRecoveryHash = await argon2.hash(
    newRecoveryKey.replace(/-/g, ""),
    { type: argon2.argon2id }
  );

  // Reset recovery attempt counters on success
  setAuthConfig("auth.recovery_failed_attempts", "0");
  setAuthConfig("auth.recovery_lockout_until", "");

  const db = getDb();
  db.transaction(() => {
    setAuthConfig("auth.method", newMethod);
    setAuthConfig("auth.credential_hash", newHash);
    setAuthConfig("auth.recovery_key_hash", newRecoveryHash);
    if (newUsername) setAuthConfig("auth.username", newUsername);
    setAuthConfig("auth.failed_attempts", "0");
    setAuthConfig("auth.lockout_until", "");
    // Destroy all sessions
    db.prepare("DELETE FROM auth_sessions").run();
  })();

  return { recoveryKey: newRecoveryKey };
}

// ── CLI Reset ────────────────────────────────────────────────────

export function resetAuth(): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM auth_config").run();
    db.prepare("DELETE FROM auth_sessions").run();
    db.prepare("DELETE FROM api_keys").run();
  })();
}
