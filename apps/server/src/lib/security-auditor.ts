import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/database.ts";
import { listCredentialMetadata } from "../db/credential-store.ts";
import { listApiKeys } from "../db/api-key-store.ts";

export type Severity = "low" | "medium" | "high";

export interface AuditFinding {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  remediation: string;
  resourceType?: string;
  resourceId?: string;
}

export interface AuditReport {
  ranAt: string;
  findings: AuditFinding[];
  summary: {
    high: number;
    medium: number;
    low: number;
    total: number;
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CHVOR_DATA_DIR ?? resolve(__dirname, "../../data");
const ENCRYPTION_KEY_PATH = resolve(DATA_DIR, ".encryption-key");

/**
 * Scan for credentials that haven't been used in the last 90 days. Unused
 * creds expand blast radius with no upside.
 */
function scanStaleCredentials(): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const creds = listCredentialMetadata();
  for (const c of creds) {
    const lastTested = c.lastTestedAt ? new Date(c.lastTestedAt).getTime() : 0;
    const updated = c.updatedAt ? new Date(c.updatedAt).getTime() : 0;
    const mostRecent = Math.max(lastTested, updated);
    if (mostRecent && now - mostRecent > NINETY_DAYS) {
      const days = Math.round((now - mostRecent) / (24 * 60 * 60 * 1000));
      findings.push({
        id: `stale-cred-${c.id}`,
        severity: "low",
        category: "credentials",
        title: `Credential "${c.name}" unused for ${days} days`,
        detail: `The ${c.type} credential has not been tested or updated in ${days} days.`,
        remediation: "Delete it if no longer needed, or rotate and re-test to confirm it still works.",
        resourceType: "credential",
        resourceId: c.id,
      });
    }
    if (c.testStatus === "failed") {
      findings.push({
        id: `failed-cred-${c.id}`,
        severity: "medium",
        category: "credentials",
        title: `Credential "${c.name}" is failing its test`,
        detail: `Last test for this ${c.type} credential reported failure.`,
        remediation: "Re-enter or rotate the secret and run the connection test.",
        resourceType: "credential",
        resourceId: c.id,
      });
    }
  }
  return findings;
}

/**
 * Flag API keys that are wildcard (`*`), never expire, or haven't been used
 * in the last 90 days.
 */
function scanApiKeys(): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const keys = listApiKeys();
  for (const k of keys) {
    if (k.revokedAt) continue;
    if (k.scopes.trim() === "*") {
      findings.push({
        id: `wildcard-key-${k.id}`,
        severity: "medium",
        category: "api-keys",
        title: `API key "${k.name}" has wildcard scope`,
        detail: "A single `*` scope grants full platform access via this key.",
        remediation: "Narrow the scope list to what the consumer actually needs (e.g. `tool:execute:native__web_*,credential:read`).",
        resourceType: "api-key",
        resourceId: k.id,
      });
    }
    if (!k.expiresAt) {
      findings.push({
        id: `no-expiry-key-${k.id}`,
        severity: "low",
        category: "api-keys",
        title: `API key "${k.name}" has no expiration`,
        detail: "Long-lived tokens increase exposure if leaked.",
        remediation: "Re-issue with an expiration (e.g. 90 days) and rotate consumers.",
        resourceType: "api-key",
        resourceId: k.id,
      });
    }
    const lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).getTime() : 0;
    if (lastUsed && now - lastUsed > NINETY_DAYS) {
      const days = Math.round((now - lastUsed) / (24 * 60 * 60 * 1000));
      findings.push({
        id: `stale-key-${k.id}`,
        severity: "low",
        category: "api-keys",
        title: `API key "${k.name}" unused for ${days} days`,
        detail: "Unused keys are safer to revoke.",
        remediation: "Revoke if no longer needed.",
        resourceType: "api-key",
        resourceId: k.id,
      });
    }
  }
  return findings;
}

/** Flag webhook subscriptions without a signing secret. */
function scanWebhooks(): AuditFinding[] {
  const findings: AuditFinding[] = [];
  try {
    const db = getDb();
    const rows = db
      .prepare("SELECT id, name, secret FROM webhook_subscriptions WHERE enabled = 1")
      .all() as Array<{ id: string; name: string; secret: string | null }>;
    for (const r of rows) {
      if (!r.secret || r.secret.length < 16) {
        findings.push({
          id: `weak-webhook-${r.id}`,
          severity: "high",
          category: "webhooks",
          title: `Webhook "${r.name}" has weak or missing HMAC secret`,
          detail: "Inbound webhooks without a strong secret can be spoofed.",
          remediation: "Rotate the secret to at least 32 random bytes and update the sender.",
          resourceType: "webhook",
          resourceId: r.id,
        });
      }
    }
  } catch {
    // webhooks table may not exist on fresh installs; skip.
  }
  return findings;
}

/** Flag plaintext encryption key file with loose permissions (best effort on Windows). */
function scanEncryptionKey(): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (!existsSync(ENCRYPTION_KEY_PATH)) return findings;
  try {
    const stat = statSync(ENCRYPTION_KEY_PATH);
    const mode = stat.mode & 0o777;
    // On POSIX, anything wider than 0o600 leaks. On Windows this check is noisy
    // so treat it as informational only.
    if (process.platform !== "win32" && mode > 0o600) {
      findings.push({
        id: "key-permissions",
        severity: "high",
        category: "encryption",
        title: "Encryption key file has loose permissions",
        detail: `~/.chvor/.encryption-key has mode ${mode.toString(8)} — should be 600.`,
        remediation: `chmod 600 "${ENCRYPTION_KEY_PATH}" and restart chvor.`,
      });
    }
  } catch {
    // stat failure — ignore
  }
  // Regardless of platform: flag that rotation is not implemented yet.
  findings.push({
    id: "key-rotation-missing",
    severity: "low",
    category: "encryption",
    title: "No encryption key rotation",
    detail: "chvor stores the AES-256-GCM key statically on disk. A compromised key never expires.",
    remediation: "Rotation is tracked in the platform roadmap; for now, revoke via full data reset if you suspect compromise.",
  });
  return findings;
}

/** Flag OAuth tokens that expired more than 7 days ago and were never refreshed. */
function scanOAuthTokens(): AuditFinding[] {
  const findings: AuditFinding[] = [];
  // OAuth tokens are stored as credentials with type prefix oauth-token-*;
  // if their updatedAt is stale and their test_status is failed, flag it.
  const creds = listCredentialMetadata();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const c of creds) {
    if (!c.type.startsWith("oauth-token-")) continue;
    const updated = c.updatedAt ? new Date(c.updatedAt).getTime() : 0;
    if (c.testStatus === "failed" && updated && now - updated > SEVEN_DAYS) {
      findings.push({
        id: `stale-oauth-${c.id}`,
        severity: "medium",
        category: "oauth",
        title: `OAuth token "${c.name}" stuck in failed state`,
        detail: `The token has been failing for more than 7 days and may have been revoked by the provider.`,
        remediation: "Reconnect the integration through the UI to obtain a fresh token.",
        resourceType: "credential",
        resourceId: c.id,
      });
    }
  }
  return findings;
}

/** Summarize severities and return the full report. */
export function runSecurityAudit(): AuditReport {
  const findings: AuditFinding[] = [
    ...scanStaleCredentials(),
    ...scanApiKeys(),
    ...scanWebhooks(),
    ...scanEncryptionKey(),
    ...scanOAuthTokens(),
  ];

  const summary = {
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    total: findings.length,
  };

  return {
    ranAt: new Date().toISOString(),
    findings,
    summary,
  };
}
