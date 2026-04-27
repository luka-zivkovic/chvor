import { getDb } from "./database.ts";

/**
 * Cognitive Tool Graph storage (Phase G).
 *
 * `tool_nodes` — one row per tool the orchestrator has ever observed.
 * `tool_edges` — undirected co-activation edges between tool names.
 *
 * Edges are stored canonically: tool_a is always the lexicographically-smaller
 * name. The pair-helper below normalises every (a, b) lookup so callers don't
 * have to remember the convention.
 */

export interface ToolNode {
  toolName: string;
  strength: number;
  invocationCount: number;
  successCount: number;
  failureCount: number;
  trialBoostRemaining: number;
  installedAt: string;
  lastUsedAt: string | null;
  lastDecayedAt: string | null;
}

export interface ToolEdge {
  toolA: string;
  toolB: string;
  weight: number;
  coUseCount: number;
  lastCoUsedAt: string;
}

interface NodeRow {
  tool_name: string;
  strength: number;
  invocation_count: number;
  success_count: number;
  failure_count: number;
  trial_boost_remaining: number;
  installed_at: string;
  last_used_at: string | null;
  last_decayed_at: string | null;
}

interface EdgeRow {
  tool_a: string;
  tool_b: string;
  weight: number;
  co_use_count: number;
  last_co_used_at: string;
}

function rowToNode(r: NodeRow): ToolNode {
  return {
    toolName: r.tool_name,
    strength: r.strength,
    invocationCount: r.invocation_count,
    successCount: r.success_count,
    failureCount: r.failure_count,
    trialBoostRemaining: r.trial_boost_remaining,
    installedAt: r.installed_at,
    lastUsedAt: r.last_used_at,
    lastDecayedAt: r.last_decayed_at,
  };
}

function rowToEdge(r: EdgeRow): ToolEdge {
  return {
    toolA: r.tool_a,
    toolB: r.tool_b,
    weight: r.weight,
    coUseCount: r.co_use_count,
    lastCoUsedAt: r.last_co_used_at,
  };
}

/** Canonical (a, b) ordering so edge rows are unique. */
export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Lazy create — returns the existing or freshly-inserted node. */
export function getOrCreateNode(toolName: string, opts: { initialStrength?: number; trialBoost?: number } = {}): ToolNode {
  const db = getDb();
  const existing = db
    .prepare(
      "SELECT tool_name, strength, invocation_count, success_count, failure_count, trial_boost_remaining, installed_at, last_used_at, last_decayed_at FROM tool_nodes WHERE tool_name = ?"
    )
    .get(toolName) as NodeRow | undefined;
  if (existing) return rowToNode(existing);

  const now = new Date().toISOString();
  const strength = opts.initialStrength ?? 1.5;
  const trialBoost = opts.trialBoost ?? 20;
  db.prepare(
    `INSERT INTO tool_nodes (tool_name, strength, trial_boost_remaining, installed_at)
     VALUES (?, ?, ?, ?)`
  ).run(toolName, strength, trialBoost, now);
  return {
    toolName,
    strength,
    invocationCount: 0,
    successCount: 0,
    failureCount: 0,
    trialBoostRemaining: trialBoost,
    installedAt: now,
    lastUsedAt: null,
    lastDecayedAt: null,
  };
}

export function getNode(toolName: string): ToolNode | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT tool_name, strength, invocation_count, success_count, failure_count, trial_boost_remaining, installed_at, last_used_at, last_decayed_at FROM tool_nodes WHERE tool_name = ?"
    )
    .get(toolName) as NodeRow | undefined;
  return row ? rowToNode(row) : null;
}

export function getNodes(toolNames: string[]): Map<string, ToolNode> {
  if (toolNames.length === 0) return new Map();
  const db = getDb();
  const placeholders = toolNames.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT tool_name, strength, invocation_count, success_count, failure_count, trial_boost_remaining, installed_at, last_used_at, last_decayed_at
         FROM tool_nodes WHERE tool_name IN (${placeholders})`
    )
    .all(...toolNames) as NodeRow[];
  const out = new Map<string, ToolNode>();
  for (const r of rows) out.set(r.tool_name, rowToNode(r));
  return out;
}

/** All nodes sorted by strength DESC. Default cap 500 (more than chvor will ever load). */
export function listNodes(limit = 500): ToolNode[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT tool_name, strength, invocation_count, success_count, failure_count, trial_boost_remaining, installed_at, last_used_at, last_decayed_at
         FROM tool_nodes
         ORDER BY strength DESC, last_used_at DESC NULLS LAST
         LIMIT ?`
    )
    .all(Math.min(Math.max(limit, 1), 1000)) as NodeRow[];
  return rows.map(rowToNode);
}

export interface UpdateNodeStats {
  strength: number;
  invocationDelta?: number;
  successDelta?: number;
  failureDelta?: number;
  /** Decrement trial boost by this much (clamped to 0). */
  consumeTrialBoost?: number;
  lastUsedAt?: string;
  lastDecayedAt?: string;
}

export function updateNode(toolName: string, stats: UpdateNodeStats): void {
  const db = getDb();
  db.prepare(
    `UPDATE tool_nodes SET
       strength = ?,
       invocation_count = invocation_count + ?,
       success_count = success_count + ?,
       failure_count = failure_count + ?,
       trial_boost_remaining = MAX(0, trial_boost_remaining - ?),
       last_used_at = COALESCE(?, last_used_at),
       last_decayed_at = COALESCE(?, last_decayed_at)
     WHERE tool_name = ?`
  ).run(
    stats.strength,
    stats.invocationDelta ?? 0,
    stats.successDelta ?? 0,
    stats.failureDelta ?? 0,
    stats.consumeTrialBoost ?? 0,
    stats.lastUsedAt ?? null,
    stats.lastDecayedAt ?? null,
    toolName
  );
}

/** Apply a uniform decay to every node strength. Returns rows affected. */
export function decayAllStrengths(rate: number, floor: number): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE tool_nodes
         SET strength = MAX(?, strength * ?),
             last_decayed_at = ?`
    )
    .run(floor, rate, now);
  return result.changes as number;
}

/**
 * Bump (or insert) the edge between two tools. Idempotent — safe to call once
 * per successful co-use. Weight increment uses the recency-aware formula
 * documented in tool-graph.ts.
 */
export function bumpEdge(a: string, b: string, weightIncrement: number): void {
  if (a === b) return;
  const [ta, tb] = pairKey(a, b);
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO tool_edges (tool_a, tool_b, weight, co_use_count, last_co_used_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(tool_a, tool_b) DO UPDATE SET
       weight = MIN(1.0, weight + excluded.weight),
       co_use_count = co_use_count + 1,
       last_co_used_at = excluded.last_co_used_at`
  ).run(ta, tb, weightIncrement, now);
}

/** Return every edge incident on `toolName`, regardless of orientation. */
export function getEdgesFor(toolName: string): ToolEdge[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT tool_a, tool_b, weight, co_use_count, last_co_used_at
         FROM tool_edges
         WHERE tool_a = ? OR tool_b = ?`
    )
    .all(toolName, toolName) as EdgeRow[];
  return rows.map(rowToEdge);
}

/** Edges between any two tools in `pool` (used to score current bag). */
export function getEdgesAmong(pool: string[]): ToolEdge[] {
  if (pool.length < 2) return [];
  const db = getDb();
  const placeholders = pool.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT tool_a, tool_b, weight, co_use_count, last_co_used_at
         FROM tool_edges
         WHERE tool_a IN (${placeholders}) AND tool_b IN (${placeholders})`
    )
    .all(...pool, ...pool) as EdgeRow[];
  return rows.map(rowToEdge);
}

/** Count diagnostics — surfaced in /api/debug/tool-graph. */
export function countNodes(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as n FROM tool_nodes").get() as { n: number };
  return row.n;
}

export function countEdges(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as n FROM tool_edges").get() as { n: number };
  return row.n;
}
