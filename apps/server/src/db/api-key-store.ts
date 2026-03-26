import { randomBytes, createHash } from "node:crypto";
import { getDb } from "./database.ts";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function generateApiKey(
  name: string,
  expiresInDays?: number
): { id: string; key: string; prefix: string; name: string } {
  const id = randomBytes(16).toString("hex");
  const rawKey = randomBytes(20).toString("hex"); // 40 hex chars
  const key = `chvor_${rawKey}`;
  const prefix = rawKey.slice(0, 8);
  const keyHash = sha256(key);
  const now = new Date().toISOString();
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const db = getDb();
  db.prepare(
    `INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, '*', ?, ?)`
  ).run(id, name, prefix, keyHash, now, expiresAt);

  return { id, key, prefix, name };
}

export function validateApiKey(
  key: string
): { valid: boolean; keyId?: string; scopes?: string } {
  const keyHash = sha256(key);
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, scopes, expires_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL"
    )
    .get(keyHash) as
    | { id: string; scopes: string; expires_at: string | null }
    | undefined;

  if (!row) return { valid: false };
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return { valid: false };
  }

  // Update last_used_at
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.id
  );

  return { valid: true, keyId: row.id, scopes: row.scopes };
}

export function revokeApiKey(id: string): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function listApiKeys(): Array<{
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, name, key_prefix, scopes, created_at, expires_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC"
    )
    .all() as Array<{
    id: string;
    name: string;
    key_prefix: string;
    scopes: string;
    created_at: string;
    expires_at: string | null;
    last_used_at: string | null;
    revoked_at: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.key_prefix,
    scopes: r.scopes,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }));
}
