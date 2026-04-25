import { randomUUID } from "node:crypto";
import type {
  Credential,
  CredentialSummary,
  CredentialData,
  CredentialType,
  ConnectionConfig,
} from "@chvor/shared";
import { getDb } from "./database.ts";
import { encrypt, decrypt } from "./crypto.ts";

interface CredentialRow {
  id: string;
  name: string;
  type: string;
  encrypted_data: string;
  usage_context: string | null;
  connection_config: string | null;
  created_at: string;
  updated_at: string;
  last_tested_at: string | null;
  test_status: string | null;
}

function parseConnectionConfig(raw: string | null): ConnectionConfig | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as ConnectionConfig; } catch { return undefined; }
}

function rowToCredential(row: CredentialRow): Credential {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    encryptedData: row.encrypted_data,
    usageContext: row.usage_context ?? undefined,
    connectionConfig: parseConnectionConfig(row.connection_config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTestedAt: row.last_tested_at ?? undefined,
    testStatus: (row.test_status as Credential["testStatus"]) ?? undefined,
  };
}

const NON_SECRET_FIELDS = new Set([
  "host", "port", "baseUrl", "domain", "homeserverUrl", "instanceUrl",
  "userId", "email", "vaultPath", "username",
]);

function redactValue(value: string, key?: string): string {
  if (key && NON_SECRET_FIELDS.has(key)) return value;
  if (value.length <= 4) return "••••••••";
  return value.slice(0, 4) + "••••••••";
}

function toSummary(cred: Credential, data: CredentialData): CredentialSummary {
  const redactedFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    redactedFields[k] = redactValue(v, k);
  }
  return {
    id: cred.id,
    name: cred.name,
    type: cred.type,
    testStatus: cred.testStatus,
    createdAt: cred.createdAt,
    redactedFields,
    usageContext: cred.usageContext,
    connectionConfig: cred.connectionConfig,
  };
}

/**
 * Lightweight metadata-only listing for audit/reporting — no decryption,
 * includes timestamps. Never exposes encrypted_data.
 */
export interface CredentialMetadata {
  id: string;
  name: string;
  type: string;
  usageContext: string | null;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
  testStatus: Credential["testStatus"] | null;
}

export function listCredentialMetadata(): CredentialMetadata[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, name, type, usage_context, created_at, updated_at, last_tested_at, test_status FROM credentials ORDER BY created_at DESC"
    )
    .all() as Array<{
    id: string;
    name: string;
    type: string;
    usage_context: string | null;
    created_at: string;
    updated_at: string;
    last_tested_at: string | null;
    test_status: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    usageContext: r.usage_context,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastTestedAt: r.last_tested_at,
    testStatus: (r.test_status as Credential["testStatus"]) ?? null,
  }));
}

export function listCredentials(): CredentialSummary[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM credentials ORDER BY created_at DESC").all() as CredentialRow[];
  return rows.map((row) => {
    try {
      const cred = rowToCredential(row);
      const data = JSON.parse(decrypt(cred.encryptedData)) as CredentialData;
      return toSummary(cred, data);
    } catch (err) {
      console.error(`[credential-store] failed to decrypt credential ${row.id}:`, err);
      // Return a degraded summary so the credential is still visible in the UI
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        testStatus: "failed" as const,
        createdAt: row.created_at,
        redactedFields: { _error: "Decryption failed — re-enter this credential" },
        usageContext: row.usage_context ?? undefined,
      };
    }
  });
}

export function createCredential(
  name: string,
  type: CredentialType,
  data: CredentialData,
  usageContext?: string
): CredentialSummary {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const encryptedData = encrypt(JSON.stringify(data));

  db.prepare(
    `INSERT INTO credentials (id, name, type, encrypted_data, usage_context, created_at, updated_at, test_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'untested')`
  ).run(id, name, type, encryptedData, usageContext ?? null, now, now);

  const cred: Credential = {
    id,
    name,
    type,
    encryptedData,
    usageContext,
    createdAt: now,
    updatedAt: now,
    testStatus: "untested",
  };
  return toSummary(cred, data);
}

export function deleteCredential(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM credentials WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getCredentialData(
  id: string
): { cred: Credential; data: CredentialData } | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as CredentialRow | undefined;
  if (!row) return null;
  const cred = rowToCredential(row);
  try {
    const data = JSON.parse(decrypt(cred.encryptedData)) as CredentialData;
    return { cred, data };
  } catch (err) {
    console.error(`[credential-store] decrypt failed for credential ${id}:`, err);
    return null;
  }
}

export function updateCredential(
  id: string,
  name: string | undefined,
  data: CredentialData | undefined,
  usageContext?: string
): CredentialSummary | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as CredentialRow | undefined;
  if (!row) return null;

  const cred = rowToCredential(row);
  let existingData: CredentialData;
  try {
    existingData = JSON.parse(decrypt(cred.encryptedData)) as CredentialData;
  } catch (err) {
    console.error(`[credential-store] decrypt failed for credential ${id}:`, err);
    return null;
  }
  const now = new Date().toISOString();

  const newName = name ?? cred.name;
  // Merge data; empty string values = delete that field
  const newData = data
    ? Object.fromEntries(
        Object.entries({ ...existingData, ...data }).filter(([, v]) => v !== "")
      )
    : existingData;
  const newEncrypted = data ? encrypt(JSON.stringify(newData)) : cred.encryptedData;
  const newTestStatus = data ? "untested" : (cred.testStatus ?? "untested");
  const newUsageContext = usageContext !== undefined ? usageContext : cred.usageContext;

  db.prepare(
    `UPDATE credentials SET name = ?, encrypted_data = ?, usage_context = ?, test_status = ?, updated_at = ? WHERE id = ?`
  ).run(newName, newEncrypted, newUsageContext ?? null, newTestStatus, now, id);

  const updated: Credential = {
    ...cred,
    name: newName,
    encryptedData: newEncrypted,
    usageContext: newUsageContext,
    updatedAt: now,
    testStatus: newTestStatus as Credential["testStatus"],
  };
  return toSummary(updated, newData);
}

export function updateTestStatus(
  id: string,
  status: "success" | "failed"
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE credentials SET test_status = ?, last_tested_at = ?, updated_at = ? WHERE id = ?"
  ).run(status, now, now, id);
}

export function updateConnectionConfig(
  id: string,
  config: ConnectionConfig,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const json = JSON.stringify(config);
  // Also update usageContext with the summary for backward compatibility
  const usageCtx = config.summary ?? null;
  db.prepare(
    "UPDATE credentials SET connection_config = ?, usage_context = COALESCE(usage_context, ?), updated_at = ? WHERE id = ?"
  ).run(json, usageCtx, now, id);
}
