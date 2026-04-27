/**
 * Persistence for synthesized-tool runtime state and discovered specs.
 *
 * Two concerns:
 *   1. Session approvals + repair budget + success/failure counters that used
 *      to live only in approval-gate.ts in-memory state. Persisting them
 *      survives server restart so "allow-session" doesn't ask the user again.
 *   2. Discovered OpenAPI specs (full normalized operations) so we don't
 *      re-scrape every boot. TTL-based; default 24 h.
 *
 * Schema lives in database.ts migrations v20 and v21.
 */

import { getDb } from "./database.ts";
import type { NormalizedOperation, DiscoveredSpec } from "../lib/spec-fetcher.ts";

// ── Session state ──────────────────────────────────────────────

type Scope = "session-approval" | "repair-attempt" | "tool-success" | "tool-failure";

interface SessionRow {
  session_id: string;
  scope: string;
  tool_id: string;
  endpoint_name: string;
  value: string | null;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Record a "allow-session" approval. The endpoint pair is stored so a restart
 * doesn't lose user consent for the active session.
 */
export function persistSessionApproval(
  sessionId: string,
  toolId: string,
  endpointName: string,
): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO synthesized_session_state (session_id, scope, tool_id, endpoint_name, value, updated_at) VALUES (?, 'session-approval', ?, ?, '1', ?)",
  ).run(sessionId, toolId, endpointName, nowIso());
}

export function hasSessionApproval(
  sessionId: string,
  toolId: string,
  endpointName: string,
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT 1 FROM synthesized_session_state WHERE session_id = ? AND scope = 'session-approval' AND tool_id = ? AND endpoint_name = ? LIMIT 1",
    )
    .get(sessionId, toolId, endpointName);
  return !!row;
}

/** Persist a repair attempt counter for (session, tool, endpoint). */
export function persistRepairAttempts(
  sessionId: string,
  toolId: string,
  endpointName: string,
  count: number,
  lastError: string,
): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO synthesized_session_state (session_id, scope, tool_id, endpoint_name, value, updated_at) VALUES (?, 'repair-attempt', ?, ?, ?, ?)",
  ).run(
    sessionId,
    toolId,
    endpointName,
    JSON.stringify({ count, lastError }),
    nowIso(),
  );
}

export function loadRepairAttempts(
  sessionId: string,
  toolId: string,
  endpointName: string,
): { count: number; lastError: string } | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT value FROM synthesized_session_state WHERE session_id = ? AND scope = 'repair-attempt' AND tool_id = ? AND endpoint_name = ? LIMIT 1",
    )
    .get(sessionId, toolId, endpointName) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return { count: Number(parsed.count) || 0, lastError: String(parsed.lastError ?? "") };
  } catch {
    return null;
  }
}

export function persistCounter(
  sessionId: string,
  scope: "tool-success" | "tool-failure",
  toolId: string,
  endpointName: string,
  count: number,
): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO synthesized_session_state (session_id, scope, tool_id, endpoint_name, value, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sessionId, scope, toolId, endpointName, String(count), nowIso());
}

export function loadCounter(
  sessionId: string,
  scope: "tool-success" | "tool-failure",
  toolId: string,
  endpointName: string,
): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT value FROM synthesized_session_state WHERE session_id = ? AND scope = ? AND tool_id = ? AND endpoint_name = ? LIMIT 1",
    )
    .get(sessionId, scope, toolId, endpointName) as { value: string } | undefined;
  if (!row) return 0;
  return Number(row.value) || 0;
}

/**
 * Sum a counter across all endpoints for a tool — used for tool-level success
 * stats. Walking the per-endpoint rows keeps the schema simple and avoids
 * double-bookkeeping.
 */
export function loadToolCounter(
  sessionId: string,
  scope: "tool-success" | "tool-failure",
  toolId: string,
): number {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT value FROM synthesized_session_state WHERE session_id = ? AND scope = ? AND tool_id = ?",
    )
    .all(sessionId, scope, toolId) as { value: string }[];
  let sum = 0;
  for (const r of rows) sum += Number(r.value) || 0;
  return sum;
}

export function clearRepairAttemptsFor(sessionId?: string): void {
  const db = getDb();
  if (sessionId) {
    db.prepare(
      "DELETE FROM synthesized_session_state WHERE session_id = ? AND scope = 'repair-attempt'",
    ).run(sessionId);
  } else {
    db.prepare("DELETE FROM synthesized_session_state WHERE scope = 'repair-attempt'").run();
  }
}

// Optional: housekeeping. Drop session rows older than `olderThanDays`.
export function purgeStaleSessionState(olderThanDays = 30): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString();
  const res = db
    .prepare("DELETE FROM synthesized_session_state WHERE updated_at < ?")
    .run(cutoff);
  return Number(res.changes ?? 0);
}

// ── Spec cache ────────────────────────────────────────────────

const DEFAULT_SPEC_TTL_SECONDS = 24 * 60 * 60;

interface SpecRow {
  service_slug: string;
  spec_url: string;
  base_url: string | null;
  operations: string;
  fetched_at: string;
  ttl_seconds: number;
}

export function cacheDiscoveredSpec(
  serviceSlug: string,
  spec: DiscoveredSpec,
  ttlSeconds = DEFAULT_SPEC_TTL_SECONDS,
): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO synthesized_specs (service_slug, spec_url, base_url, operations, fetched_at, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    serviceSlug,
    spec.specUrl,
    spec.baseUrl ?? null,
    JSON.stringify(spec.operations),
    nowIso(),
    ttlSeconds,
  );
}

export function loadCachedSpec(serviceSlug: string): DiscoveredSpec | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM synthesized_specs WHERE service_slug = ?")
    .get(serviceSlug) as SpecRow | undefined;
  if (!row) return null;

  const fetchedAt = Date.parse(row.fetched_at);
  if (Number.isFinite(fetchedAt)) {
    const expires = fetchedAt + row.ttl_seconds * 1000;
    if (Date.now() > expires) {
      // Stale — drop and miss so the caller refetches.
      db.prepare("DELETE FROM synthesized_specs WHERE service_slug = ?").run(serviceSlug);
      return null;
    }
  }

  let operations: NormalizedOperation[] = [];
  try {
    operations = JSON.parse(row.operations);
  } catch {
    return null;
  }

  return {
    specUrl: row.spec_url,
    baseUrl: row.base_url ?? undefined,
    operations,
  };
}

export function purgeExpiredSpecs(): number {
  const db = getDb();
  const rows = db.prepare("SELECT service_slug, fetched_at, ttl_seconds FROM synthesized_specs").all() as Array<{
    service_slug: string;
    fetched_at: string;
    ttl_seconds: number;
  }>;
  let removed = 0;
  for (const r of rows) {
    const fetchedAt = Date.parse(r.fetched_at);
    if (!Number.isFinite(fetchedAt)) continue;
    if (Date.now() > fetchedAt + r.ttl_seconds * 1000) {
      db.prepare("DELETE FROM synthesized_specs WHERE service_slug = ?").run(r.service_slug);
      removed++;
    }
  }
  return removed;
}
