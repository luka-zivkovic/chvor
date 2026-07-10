import { randomUUID } from "node:crypto";
import type { EdgeRelation, Memory, MemoryEdge } from "@chvor/shared";
import { getDb } from "../database.ts";
import { containsSensitiveData } from "../../lib/sensitive-filter.ts";
import { computeTopicHash } from "../../lib/memory-preloader.ts";
import { getMemory } from "./crud.ts";
import { deleteMemoryVector } from "./vectors.ts";
import { rowToEdge, rowToMemory, type EdgeRow, type MemoryNodeRow } from "./types.ts";

// ─── Memory strength & access tracking ──────────────────────

/** Record that a memory was accessed (boost strength, slow decay). */
export function recordMemoryAccess(id: string, sessionId?: string, queryText?: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Boost strength with diminishing returns and slow decay rate (spaced repetition)
  // Uses (1 - strength) factor so strong memories get smaller boosts, preventing immortality
  db.prepare(`
    UPDATE memory_nodes SET
      strength = MIN(1.0, strength + 0.05 * (1.0 - strength)),
      decay_rate = MAX(0.02, decay_rate * 0.9),
      access_count = access_count + 1,
      last_accessed_at = ?
    WHERE id = ?
  `).run(now, id);

  // Log access for predictive preloading
  if (sessionId) {
    try {
      const memory = getMemory(id);
      const topicHash = memory ? computeTopicHash(memory) : null;
      db.prepare(`
        INSERT INTO memory_access_log (id, memory_id, session_id, query_text, topic_hash, accessed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), id, sessionId, queryText ?? null, topicHash, now);
    } catch (err) {
      // FK constraint fails if memory was deleted between retrieval and access logging
      console.warn("[memory] access log insert failed (memory may have been deleted):", (err as Error).message);
    }
  }
}

/** Bulk decay: apply exponential decay to all memories. */
export function applyDecayPass(): { decayed: number; invisible: number } {
  const db = getDb();
  const now = Date.now();

  // Use relative multiplication (strength = strength * factor) instead of absolute writes
  // so concurrent recordMemoryAccess boosts are not overwritten.
  const update = db.prepare(
    "UPDATE memory_nodes SET strength = MAX(0, MIN(1, strength * ?)) WHERE id = ? AND strength > 0"
  );
  let decayed = 0;
  let invisible = 0;

  // SELECT + UPDATE inside same transaction to prevent TOCTOU race
  const tx = db.transaction(() => {
    const rows = db.prepare(
      "SELECT id, decay_rate, last_accessed_at, created_at, strength FROM memory_nodes WHERE strength > 0"
    ).all() as Array<{
      id: string; decay_rate: number; strength: number;
      last_accessed_at: string | null; created_at: string;
    }>;

    for (const row of rows) {
      const lastActive = row.last_accessed_at ?? row.created_at;
      const lastActiveMs = new Date(lastActive).getTime();
      if (!Number.isFinite(lastActiveMs)) continue; // corrupt date
      const daysSince = (now - lastActiveMs) / (1000 * 60 * 60 * 24);
      if (daysSince <= 0) continue; // future date (clock skew) — no decay
      const factor = Math.exp(-row.decay_rate * daysSince);
      if (!Number.isFinite(factor) || factor >= 1) continue; // NaN/Infinity/no-op guard
      update.run(factor, row.id);
      decayed++;
      if (row.strength * factor < 0.05) invisible++;
    }
  });
  tx();

  return { decayed, invisible };
}

// ─── Graph edge operations ──────────────────────────────────

export function createEdge(
  sourceId: string,
  targetId: string,
  relation: EdgeRelation,
  weight: number = 0.5,
): MemoryEdge | null {
  if (sourceId === targetId) return null; // no self-edges
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO memory_edges (id, source_id, target_id, relation, weight, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sourceId, targetId, relation, weight, now);
    if (result.changes === 0) return null; // duplicate constraint fired
    return { id, sourceId, targetId, relation, weight, createdAt: now };
  } catch {
    return null;
  }
}

export function getEdgesForMemory(memoryId: string, limit: number = 50): MemoryEdge[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM memory_edges WHERE source_id = ? OR target_id = ? ORDER BY weight DESC LIMIT ?"
  ).all(memoryId, memoryId, limit) as EdgeRow[];
  return rows.map(rowToEdge);
}

export function getNeighborMemories(memoryId: string): Memory[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT m.*
    FROM memory_edges e
    JOIN memory_nodes m ON (m.id = e.target_id AND e.source_id = ?) OR (m.id = e.source_id AND e.target_id = ?)
    WHERE m.strength >= 0.05
      AND m.id != ?
    ORDER BY m.strength DESC
    LIMIT 20
  `).all(memoryId, memoryId, memoryId) as MemoryNodeRow[];
  return rows.map(rowToMemory);
}

export function boostEdgeWeight(sourceId: string, targetId: string, boost: number = 0.05): void {
  const db = getDb();
  db.prepare(`
    UPDATE memory_edges SET weight = MIN(1.0, weight + ?)
    WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)
  `).run(boost, sourceId, targetId, targetId, sourceId);
}

// ─── Sensitive data cleanup ─────────────────────────────────

/**
 * Scan existing memories and delete any that contain sensitive data (API keys, tokens, etc).
 * Call at server boot to purge accidentally stored secrets.
 */
export function deleteSensitiveMemories(): number {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, abstract, overview, detail FROM memory_nodes")
    .all() as { id: string; abstract: string; overview: string | null; detail: string | null }[];

  const sensitiveIds: string[] = [];
  for (const row of rows) {
    const textToCheck = [row.abstract, row.overview, row.detail].filter(Boolean).join(" ");
    if (containsSensitiveData(textToCheck)) {
      sensitiveIds.push(row.id);
      console.log(`[memory] purged sensitive memory: "${row.abstract.slice(0, 30)}..."`);
    }
  }

  if (sensitiveIds.length === 0) return 0;

  const tx = db.transaction(() => {
    for (const id of sensitiveIds) {
      deleteMemoryVector(id);
      db.prepare("DELETE FROM memory_access_log WHERE memory_id = ?").run(id);
      db.prepare("DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?").run(id, id);
      db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(id);
    }
  });
  tx();

  return sensitiveIds.length;
}

// ─── Consolidation helpers ──────────────────────────────────

/** Get memory clusters: groups of memories connected by semantic edges, same category. */
export function getMemoryClusters(
  minClusterSize: number = 3,
  category?: string,
): Array<{ memories: Memory[]; edges: MemoryEdge[] }> {
  const db = getDb();

  // Find all semantic/temporal/entity edges between active memories
  const edgeQuery = category
    ? db.prepare(`
        SELECT e.*
        FROM memory_edges e
        JOIN memory_nodes s ON s.id = e.source_id AND s.strength >= 0.05
        JOIN memory_nodes t ON t.id = e.target_id AND t.strength >= 0.05
        WHERE e.relation IN ('semantic', 'temporal', 'entity')
          AND s.category = ? AND t.category = ?
      `).all(category, category) as EdgeRow[]
    : db.prepare(`
        SELECT e.*
        FROM memory_edges e
        JOIN memory_nodes s ON s.id = e.source_id AND s.strength >= 0.05
        JOIN memory_nodes t ON t.id = e.target_id AND t.strength >= 0.05
        WHERE e.relation IN ('semantic', 'temporal', 'entity')
          AND s.category = t.category
      `).all() as EdgeRow[];

  // Build adjacency map
  const adj = new Map<string, Set<string>>();
  for (const e of edgeQuery) {
    if (!adj.has(e.source_id)) adj.set(e.source_id, new Set());
    if (!adj.has(e.target_id)) adj.set(e.target_id, new Set());
    adj.get(e.source_id)!.add(e.target_id);
    adj.get(e.target_id)!.add(e.source_id);
  }

  // Find connected components via BFS
  const visited = new Set<string>();
  const clusters: Array<{ memoryIds: Set<string> }> = [];

  for (const nodeId of adj.keys()) {
    if (visited.has(nodeId)) continue;
    const component = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.add(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    if (component.size >= minClusterSize) {
      clusters.push({ memoryIds: component });
    }
  }

  // Load full memory data for each cluster (batch in chunks of 500 to stay under SQLite's 999 variable limit)
  const CHUNK_SIZE = 500;
  return clusters.map((cluster) => {
    const ids = [...cluster.memoryIds];
    const allMemories: MemoryNodeRow[] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT * FROM memory_nodes WHERE id IN (${placeholders}) ORDER BY created_at`
      ).all(...chunk) as MemoryNodeRow[];
      allMemories.push(...rows);
    }

    // Re-sort after chunked loading to ensure consistent created_at ordering
    allMemories.sort((a, b) => a.created_at.localeCompare(b.created_at));

    const clusterEdges = edgeQuery.filter(
      (e) => cluster.memoryIds.has(e.source_id) && cluster.memoryIds.has(e.target_id)
    );

    return {
      memories: allMemories.map(rowToMemory),
      edges: clusterEdges.map(rowToEdge),
    };
  });
}

/** Get memories created since a given timestamp. */
export function getMemoriesSince(since: string): Memory[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM memory_nodes WHERE created_at > ? ORDER BY created_at"
  ).all(since) as MemoryNodeRow[];
  return rows.map(rowToMemory);
}

/** Reduce strength of a memory (used when consolidated into a merged memory). */
export function reduceMemoryStrength(id: string, factor: number = 0.5): void {
  const db = getDb();
  db.prepare("UPDATE memory_nodes SET strength = strength * ? WHERE id = ?").run(factor, id);
}

/** Prune weak edges from the graph. */
export function pruneWeakEdges(minWeight: number = 0.1): number {
  const db = getDb();
  const result = db.prepare("DELETE FROM memory_edges WHERE weight < ?").run(minWeight);
  return result.changes;
}

/** Prune access log entries older than N days. */
export function pruneAccessLog(maxAgeDays: number = 90): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare("DELETE FROM memory_access_log WHERE accessed_at < ?").run(cutoff);
  return result.changes;
}

// ─── Graph & Statistics (Memory Insights Dashboard) ────────

export function getMemoryGraph(limit: number = 500): import("@chvor/shared").MemoryGraphExport {
  const db = getDb();
  const nodeRows = db.prepare(
    `SELECT id, abstract, category, space, strength, decay_rate, access_count,
            last_accessed_at, confidence, provenance, emotional_valence,
            emotional_intensity, source_channel, created_at
     FROM memory_nodes WHERE strength >= 0.05 ORDER BY strength DESC LIMIT ?`
  ).all(limit) as MemoryNodeRow[];

  const nodes = nodeRows.map((row) => ({
    id: row.id,
    abstract: row.abstract,
    category: row.category as import("@chvor/shared").MemoryCategory,
    space: row.space as import("@chvor/shared").MemorySpace,
    strength: row.strength,
    decayRate: row.decay_rate,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    confidence: row.confidence,
    provenance: row.provenance as import("@chvor/shared").MemoryProvenance,
    emotionalValence: row.emotional_valence,
    emotionalIntensity: row.emotional_intensity,
    sourceChannel: row.source_channel,
    createdAt: row.created_at,
  }));

  // Only include edges between nodes in the result set
  // Use chunked queries to stay under SQLite's 999 variable limit
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  let edgeRows: EdgeRow[] = [];
  if (nodeIdSet.size > 0) {
    const EDGE_CHUNK = 400; // 400 * 2 = 800 params, well under 999
    const nodeIdArr = [...nodeIdSet];
    for (let i = 0; i < nodeIdArr.length; i += EDGE_CHUNK) {
      const chunk = nodeIdArr.slice(i, i + EDGE_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT * FROM memory_edges WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})`
      ).all(...chunk, ...chunk) as EdgeRow[];
      edgeRows.push(...rows);
    }
    // Filter: both endpoints must be in the node set (cross-chunk edges)
    edgeRows = edgeRows.filter((e) => nodeIdSet.has(e.source_id) && nodeIdSet.has(e.target_id));
  }
  const edges = edgeRows.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation as import("@chvor/shared").EdgeRelation,
    weight: row.weight,
    createdAt: row.created_at,
  }));

  return { nodes, edges };
}

export function getMemoryStats(): import("@chvor/shared").MemoryStats {
  const db = getDb();

  // Wrap in transaction for consistent snapshot
  const run = db.transaction(() => {
    const totalMemories = (db.prepare("SELECT COUNT(*) as c FROM memory_nodes").get() as { c: number }).c;
    const totalEdges = (db.prepare("SELECT COUNT(*) as c FROM memory_edges").get() as { c: number }).c;

    const categoryBreakdown = db.prepare(
      "SELECT category, COUNT(*) as count FROM memory_nodes GROUP BY category ORDER BY count DESC"
    ).all() as Array<{ category: string; count: number }>;

    const provenanceBreakdown = db.prepare(
      "SELECT provenance, COUNT(*) as count FROM memory_nodes GROUP BY provenance ORDER BY count DESC"
    ).all() as Array<{ provenance: string; count: number }>;

    const relationBreakdown = db.prepare(
      "SELECT relation, COUNT(*) as count FROM memory_edges GROUP BY relation ORDER BY count DESC"
    ).all() as Array<{ relation: string; count: number }>;

    const strengthDistribution = db.prepare(`
      SELECT
        CASE
          WHEN strength < 0.2 THEN '0.0-0.2'
          WHEN strength < 0.4 THEN '0.2-0.4'
          WHEN strength < 0.6 THEN '0.4-0.6'
          WHEN strength < 0.8 THEN '0.6-0.8'
          ELSE '0.8-1.0'
        END as bucket,
        COUNT(*) as count
      FROM memory_nodes GROUP BY bucket ORDER BY bucket
    `).all() as Array<{ bucket: string; count: number }>;

    const avgRow = db.prepare(
      "SELECT AVG(strength) as avgStrength, AVG(confidence) as avgConfidence FROM memory_nodes"
    ).get() as { avgStrength: number | null; avgConfidence: number | null };

    const dateRow = db.prepare(
      "SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM memory_nodes"
    ).get() as { oldest: string | null; newest: string | null };

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentCount7d = (db.prepare(
      "SELECT COUNT(*) as c FROM memory_nodes WHERE created_at > ?"
    ).get(sevenDaysAgo) as { c: number }).c;

    const weakCount = (db.prepare(
      "SELECT COUNT(*) as c FROM memory_nodes WHERE strength < 0.2"
    ).get() as { c: number }).c;

    const topAccessed = db.prepare(
      "SELECT id, abstract, access_count FROM memory_nodes ORDER BY access_count DESC LIMIT 5"
    ).all() as Array<{ id: string; abstract: string; access_count: number }>;

    return {
      totalMemories,
      totalEdges,
      categoryBreakdown,
      provenanceBreakdown,
      relationBreakdown,
      strengthDistribution,
      avgStrength: avgRow.avgStrength ?? 0,
      avgConfidence: avgRow.avgConfidence ?? 0,
      oldestMemory: dateRow.oldest,
      newestMemory: dateRow.newest,
      recentCount7d,
      weakCount,
      topAccessed: topAccessed.map((r) => ({ id: r.id, abstract: r.abstract, accessCount: r.access_count })),
    };
  });

  return run();
}
