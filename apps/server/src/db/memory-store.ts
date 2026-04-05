import { randomUUID } from "node:crypto";
import type { Memory, MemoryCategory, MemoryEdge, MemorySpace, MemoryProvenance, EdgeRelation } from "@chvor/shared";
import { getDb, isVecAvailable } from "./database.ts";
import { containsSensitiveData } from "../lib/sensitive-filter.ts";
import { embed, isEmbedderAvailable } from "../lib/embedder.ts";
import { computeTopicHash } from "../lib/memory-preloader.ts";

// ─── Row types ──────────────────────────────────────────────

export interface MemoryNodeRow {
  id: string;
  abstract: string;
  overview: string | null;
  detail: string | null;
  category: string;
  space: string;
  strength: number;
  decay_rate: number;
  access_count: number;
  last_accessed_at: string | null;
  confidence: number;
  provenance: string;
  emotional_valence: number | null;
  emotional_intensity: number | null;
  source_channel: string;
  source_session_id: string;
  source_message_id: string | null;
  source_resource_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  weight: number;
  created_at: string;
}

// ─── Row → Model mappers ────────────────────────────────────

export function rowToMemory(row: MemoryNodeRow): Memory {
  return {
    id: row.id,
    abstract: row.abstract,
    overview: row.overview,
    detail: row.detail,
    category: row.category as MemoryCategory,
    space: row.space as MemorySpace,
    strength: row.strength,
    decayRate: row.decay_rate,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    confidence: row.confidence,
    provenance: row.provenance as MemoryProvenance,
    emotionalValence: row.emotional_valence,
    emotionalIntensity: row.emotional_intensity,
    sourceChannel: row.source_channel,
    sourceSessionId: row.source_session_id,
    sourceMessageId: row.source_message_id,
    sourceResourceId: row.source_resource_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Backward-compat: content = abstract (used by UI, health-manifest, etc.)
    content: row.abstract,
  };
}

function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation as EdgeRelation,
    weight: row.weight,
    createdAt: row.created_at,
  };
}

// ─── Vector helpers (sqlite-vec vs pgvector) ───────────────

/**
 * Convert a Float32Array embedding to the format expected by the current driver.
 * - SQLite (sqlite-vec): raw Buffer of float32 bytes
 * - PostgreSQL (pgvector): string like '[0.1,0.2,...]'
 */
function vecParam(vector: Float32Array): Buffer | string {
  const db = getDb();
  if (db.driver === "postgres") {
    return `[${Array.from(vector).map(v => v.toFixed(10)).join(",")}]`;
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Build a vector similarity search query. Returns { sql, params }.
 * sqlite-vec:  WHERE v.embedding MATCH ? ... ORDER BY v.distance
 * pgvector:    ORDER BY v.embedding <-> $N::vector ... (distance is inline)
 *
 * @param selectCols - columns to select (e.g. "m.*", "m.abstract")
 * @param extraWhere - additional WHERE conditions (use ? placeholders)
 * @param extraParams - parameters for extraWhere
 * @param vecBuf - the embedding parameter (from vecParam())
 * @param limit - max rows
 */
function buildVecSearchQuery(
  selectCols: string,
  extraWhere: string,
  extraParams: unknown[],
  vecBuf: Buffer | string,
  limit: number,
): { sql: string; params: unknown[] } {
  const db = getDb();
  if (db.driver === "postgres") {
    // pgvector: distance is computed inline via <-> operator, no MATCH keyword.
    // PostgreSQL allows ORDER BY alias, so we compute distance once in SELECT.
    const wherePart = extraWhere ? `WHERE ${extraWhere}` : "";
    const sql = `
      SELECT ${selectCols}, (v.embedding <-> ?::vector) AS distance
      FROM memory_node_vec v
      JOIN memory_nodes m ON m.id = v.id
      ${wherePart}
      ORDER BY distance
      LIMIT ?
    `;
    // Param order: vecBuf (for <->), extraParams (for WHERE), limit
    return { sql, params: [vecBuf, ...extraParams, limit] };
  }
  // sqlite-vec: MATCH keyword + virtual distance column
  const wherePart = extraWhere ? `AND ${extraWhere}` : "";
  const sql = `
    SELECT ${selectCols}, v.distance
    FROM memory_node_vec v
    JOIN memory_nodes m ON m.id = v.id
    WHERE v.embedding MATCH ?
      ${wherePart}
    ORDER BY v.distance
    LIMIT ?
  `;
  return { sql, params: [vecBuf, ...extraParams, limit] };
}

// ─── Vector operations ──────────────────────────────────────

export async function embedAndStoreVector(id: string, content: string): Promise<void> {
  if (!isEmbedderAvailable() || !isVecAvailable()) return;
  try {
    const db = getDb();
    const vector = await embed(content);
    const param = vecParam(vector);
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const tx = db.transaction(() => {
      db.prepare("UPDATE memory_nodes SET embedding = ? WHERE id = ?").run(buf, id);
      db.prepare("INSERT OR REPLACE INTO memory_node_vec (id, embedding) VALUES (?, ?)").run(id, param);
    });
    tx();
  } catch (err) {
    console.warn(`[memory] failed to embed memory ${id}:`, (err as Error).message);
  }
}

function deleteMemoryVector(id: string): void {
  if (!isVecAvailable()) return;
  try {
    const db = getDb();
    db.prepare("DELETE FROM memory_node_vec WHERE id = ?").run(id);
  } catch { /* vec table may not exist */ }
}

function deleteAllMemoryVectors(): void {
  if (!isVecAvailable()) return;
  try {
    const db = getDb();
    db.prepare("DELETE FROM memory_node_vec").run();
  } catch { /* vec table may not exist */ }
}

export function getUnembeddedMemoryIds(): { id: string; content: string }[] {
  const db = getDb();
  return db
    .prepare("SELECT id, abstract AS content FROM memory_nodes WHERE embedding IS NULL")
    .all() as { id: string; content: string }[];
}

// ─── Semantic retrieval ─────────────────────────────────────

/**
 * Get memories relevant to the query using vector similarity search.
 * Falls back to recency-based retrieval if embedder/vec unavailable.
 * Only returns memories above the strength threshold.
 */
export async function getRelevantMemories(
  query: string,
  limit: number = 15,
  strengthThreshold: number = 0.05,
): Promise<string[]> {
  if (!isEmbedderAvailable() || !isVecAvailable()) {
    return getAllMemoryContents(2000, strengthThreshold);
  }

  try {
    const db = getDb();
    const queryVector = await embed(query);
    const vp = vecParam(queryVector);

    const { sql, params } = buildVecSearchQuery(
      "m.abstract", "m.strength >= ?", [strengthThreshold], vp, limit,
    );
    const rows = db.prepare(sql).all(...params) as { abstract: string }[];

    const results = rows.map((r) => r.abstract);

    // Supplement with recency-based if not enough embedded memories yet
    if (results.length < limit) {
      const existing = new Set(results);
      const recencyFill = getAllMemoryContents(2000, strengthThreshold);
      for (const fact of recencyFill) {
        if (results.length >= limit) break;
        if (!existing.has(fact)) {
          results.push(fact);
          existing.add(fact);
        }
      }
    }

    return results;
  } catch (err) {
    console.warn("[memory] vector search failed, falling back to recency:", (err as Error).message);
    return getAllMemoryContents(2000, strengthThreshold);
  }
}

/**
 * Retrieve memories with vector similarity scores — used by composite scoring.
 * Returns full Memory objects paired with their vector similarity (0–1).
 */
export async function getRelevantMemoriesWithScores(
  query: string,
  limit: number = 20,
  strengthThreshold: number = 0.05,
): Promise<Array<{ memory: Memory; vectorSimilarity: number }>> {
  if (!isEmbedderAvailable() || !isVecAvailable()) {
    // Fallback: return recent memories with a default similarity
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM memory_nodes WHERE strength >= ? ORDER BY created_at DESC LIMIT ?")
      .all(strengthThreshold, limit) as MemoryNodeRow[];
    return rows.map((r, i) => ({
      memory: rowToMemory(r),
      vectorSimilarity: Math.max(0, 0.5 - i * 0.02), // synthetic similarity decay, clamped to [0,1]
    }));
  }

  try {
    const db = getDb();
    const queryVector = await embed(query);
    const vp = vecParam(queryVector);

    const { sql, params } = buildVecSearchQuery(
      "m.*", "m.strength >= ?", [strengthThreshold], vp, limit,
    );
    const rows = db.prepare(sql).all(...params) as (MemoryNodeRow & { distance: number })[];

    const results = rows.map((r) => ({
      memory: rowToMemory(r),
      // L2 distance → cosine similarity (valid for L2-normalized embeddings)
      // Clamped to [0,1] to handle floating-point imprecision
      vectorSimilarity: Math.max(0, Math.min(1, 1 - (r.distance * r.distance) / 2)),
    }));

    // Supplement with unembedded recent memories
    if (results.length < limit) {
      const seen = new Set(results.map((r) => r.memory.id));
      const fallback = db
        .prepare("SELECT * FROM memory_nodes WHERE embedding IS NULL AND strength >= ? ORDER BY created_at DESC LIMIT ?")
        .all(strengthThreshold, limit - results.length) as MemoryNodeRow[];
      for (const r of fallback) {
        if (!seen.has(r.id)) {
          results.push({ memory: rowToMemory(r), vectorSimilarity: 0.3 });
        }
      }
    }

    return results;
  } catch (err) {
    console.warn("[memory] vector search with scores failed:", (err as Error).message);
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM memory_nodes WHERE strength >= ? ORDER BY created_at DESC LIMIT ?")
      .all(strengthThreshold, limit) as MemoryNodeRow[];
    return rows.map((r, i) => ({
      memory: rowToMemory(r),
      vectorSimilarity: Math.max(0, 0.5 - i * 0.02),
    }));
  }
}

/**
 * DRR-style category-tiered retrieval.
 * Phase 1: search within primary categories (70% of budget).
 * Phase 2: cross-category fallback with remaining budget.
 */
export async function getRelevantMemoriesByCategoryTiers(
  query: string,
  primaryCategories: string[],
  limit: number = 20,
  strengthThreshold: number = 0.05,
): Promise<Array<{ memory: Memory; vectorSimilarity: number; categoryMatch: "primary" | "fallback" }>> {
  if (!isEmbedderAvailable() || !isVecAvailable() || primaryCategories.length === 0) {
    // No category signals — fall back to standard retrieval
    const standard = await getRelevantMemoriesWithScores(query, limit, strengthThreshold);
    return standard.map((r) => ({ ...r, categoryMatch: "fallback" as const }));
  }

  try {
    const db = getDb();
    const queryVector = await embed(query);
    const vp = vecParam(queryVector);

    const primaryBudget = Math.ceil(limit * 0.7);
    const seen = new Set<string>();
    const results: Array<{ memory: Memory; vectorSimilarity: number; categoryMatch: "primary" | "fallback" }> = [];

    // Phase 1: per-primary-category search
    const perCategoryLimit = Math.ceil(primaryBudget / primaryCategories.length);
    for (const cat of primaryCategories) {
      try {
        const { sql: catSql, params: catParams } = buildVecSearchQuery(
          "m.*", "m.strength >= ? AND m.category = ?", [strengthThreshold, cat], vp, perCategoryLimit,
        );
        const rows = db.prepare(catSql).all(...catParams) as (MemoryNodeRow & { distance: number })[];

        for (const r of rows) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          results.push({
            memory: rowToMemory(r),
            vectorSimilarity: Math.max(0, Math.min(1, 1 - (r.distance * r.distance) / 2)),
            categoryMatch: "primary",
          });
        }
      } catch { /* category search failed, continue */ }
    }

    // Phase 2: cross-category fallback with remaining budget
    const remaining = limit - results.length;
    if (remaining > 0) {
      try {
        const { sql: fbSql, params: fbParams } = buildVecSearchQuery(
          "m.*", "m.strength >= ?", [strengthThreshold], vp, remaining + seen.size,
        );
        const rows = db.prepare(fbSql).all(...fbParams) as (MemoryNodeRow & { distance: number })[];

        for (const r of rows) {
          if (seen.has(r.id)) continue;
          if (results.length >= limit) break;
          seen.add(r.id);
          results.push({
            memory: rowToMemory(r),
            vectorSimilarity: Math.max(0, Math.min(1, 1 - (r.distance * r.distance) / 2)),
            categoryMatch: "fallback",
          });
        }
      } catch { /* fallback search failed */ }
    }

    return results;
  } catch (err) {
    console.warn("[memory] category-tiered search failed, falling back to standard:", (err as Error).message);
    const standard = await getRelevantMemoriesWithScores(query, limit, strengthThreshold);
    return standard.map((r) => ({ ...r, categoryMatch: "fallback" as const }));
  }
}

// ─── CRUD operations ────────────────────────────────────────

export function listMemories(limit: number = 1000): Memory[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM memory_nodes ORDER BY created_at DESC LIMIT ?")
    .all(limit) as MemoryNodeRow[];
  return rows.map(rowToMemory);
}

/** Find a memory by ID prefix (for recall_detail tool). Uses index scan, not full table scan. */
export function findMemoryByIdPrefix(prefix: string): Memory | null {
  if (!prefix || prefix.length < 4) return null;
  // Escape LIKE wildcards (%, _) with backslash to prevent wildcard injection
  const escaped = prefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  if (escaped.length < 4) return null;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM memory_nodes WHERE id LIKE ? ESCAPE '\\' LIMIT 1")
    .get(`${escaped}%`) as MemoryNodeRow | undefined;
  return row ? rowToMemory(row) : null;
}

export function getMemory(id: string): Memory | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM memory_nodes WHERE id = ?")
    .get(id) as MemoryNodeRow | undefined;
  return row ? rowToMemory(row) : null;
}

export interface CreateMemoryOptions {
  abstract: string;
  overview?: string | null;
  detail?: string | null;
  category?: MemoryCategory;
  space?: MemorySpace;
  confidence?: number;
  provenance?: MemoryProvenance;
  emotionalValence?: number | null;
  emotionalIntensity?: number | null;
  initialStrength?: number;
  sourceChannel: string;
  sourceSessionId: string;
  sourceMessageId?: string | null;
  sourceResourceId?: string | null;
}

export function createMemory(
  contentOrOpts: string | CreateMemoryOptions,
  sourceChannel?: string,
  sourceSessionId?: string,
): Memory {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  // Support both legacy (content, channel, session) and new (options object) signatures
  let opts: CreateMemoryOptions;
  if (typeof contentOrOpts === "string") {
    opts = {
      abstract: contentOrOpts,
      sourceChannel: sourceChannel!,
      sourceSessionId: sourceSessionId!,
    };
  } else {
    opts = contentOrOpts;
  }

  // Reject empty or whitespace-only abstracts
  if (!opts.abstract?.trim()) {
    throw new Error("Memory abstract cannot be empty");
  }

  db.prepare(`
    INSERT INTO memory_nodes
      (id, abstract, overview, detail, category, space, strength, decay_rate,
       confidence, provenance, emotional_valence, emotional_intensity,
       source_channel, source_session_id, source_message_id, source_resource_id,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0.1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.abstract,
    opts.overview ?? null,
    opts.detail ?? null,
    opts.category ?? "profile",
    opts.space ?? "user",
    opts.initialStrength ?? 0.8,
    opts.confidence ?? 0.8,
    opts.provenance ?? "extracted",
    opts.emotionalValence ?? null,
    opts.emotionalIntensity ?? null,
    opts.sourceChannel,
    opts.sourceSessionId,
    opts.sourceMessageId ?? null,
    opts.sourceResourceId ?? null,
    now,
    now,
  );

  // Fire-and-forget embedding (embed the abstract for vector search)
  embedAndStoreVector(id, opts.abstract).catch((err) => {
    console.warn("[memory] embedding failed for", id, (err as Error).message);
  });

  return getMemory(id)!;
}

export function updateMemory(id: string, content: string): Memory | null {
  const existing = getMemory(id);
  if (!existing) return null;
  const db = getDb();
  const now = new Date().toISOString();
  // Null out overview and detail so stale L1/L2 content doesn't persist after abstract edit
  db.prepare(
    "UPDATE memory_nodes SET abstract = ?, overview = NULL, detail = NULL, updated_at = ? WHERE id = ?"
  ).run(content, now, id);
  // Fire-and-forget re-embed
  embedAndStoreVector(id, content).catch((err) => {
    console.warn("[memory] re-embedding failed for", id, (err as Error).message);
  });
  return getMemory(id)!;
}

export function updateMemoryOverview(id: string, overview: string): void {
  const db = getDb();
  db.prepare("UPDATE memory_nodes SET overview = ? WHERE id = ? AND overview IS NULL").run(overview, id);
}

export function deleteMemory(id: string): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    deleteMemoryVector(id);
    db.prepare("DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?").run(id, id);
    db.prepare("DELETE FROM memory_access_log WHERE memory_id = ?").run(id);
    const result = db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(id);
    return result.changes > 0;
  });
  return tx();
}

export function deleteAllMemories(): void {
  const db = getDb();
  const tx = db.transaction(() => {
    deleteAllMemoryVectors();
    db.prepare("DELETE FROM memory_access_log").run();
    db.prepare("DELETE FROM memory_edges").run();
    db.prepare("DELETE FROM memory_nodes").run();
  });
  tx();
}

/** Returns recent memory abstracts for system prompt injection, capped by token budget. */
export function getAllMemoryContents(
  maxTokenBudget: number = 2000,
  strengthThreshold: number = 0.05,
): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT abstract FROM memory_nodes WHERE strength >= ? ORDER BY created_at DESC LIMIT 1000")
    .all(strengthThreshold) as { abstract: string }[];
  const results: string[] = [];
  let usedTokens = 0;
  for (const r of rows) {
    const estimate = Math.ceil(r.abstract.length / 4);
    if (usedTokens + estimate > maxTokenBudget) break;
    results.push(r.abstract);
    usedTokens += estimate;
  }
  return results;
}

// ─── Deduplication ──────────────────────────────────────────

/**
 * Find an existing memory that overlaps with new content using vector similarity.
 * Falls back to text-based matching when embedder is unavailable.
 */
export async function findSimilarMemory(
  content: string,
  threshold: number = 0.85,
): Promise<Memory | null> {
  // Try vector similarity first
  if (isEmbedderAvailable() && isVecAvailable()) {
    try {
      const db = getDb();
      const vector = await embed(content);
      const vp = vecParam(vector);
      const { sql: simSql, params: simParams } = buildVecSearchQuery("m.*", "", [], vp, 1);
      const row = db.prepare(simSql).get(...simParams) as (MemoryNodeRow & { distance: number }) | undefined;

      if (row) {
        // L2 distance → cosine similarity (valid for L2-normalized embeddings)
        const cosineSim = Math.max(0, Math.min(1, 1 - (row.distance * row.distance) / 2));
        if (cosineSim >= threshold) {
          return rowToMemory(row);
        }
      }
    } catch (err) {
      console.warn("[memory] vector dedup search failed:", (err as Error).message);
    }
  }

  // Fallback: text-based matching (substring overlap, capped for safety)
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM memory_nodes ORDER BY created_at DESC LIMIT 500")
    .all() as MemoryNodeRow[];

  const lower = content.toLowerCase();
  for (const row of rows) {
    const existing = row.abstract.toLowerCase();
    if (existing === lower) return rowToMemory(row);
    const shorter = Math.min(existing.length, lower.length);
    if (shorter < 10) continue;
    if (existing.includes(lower) && lower.length / existing.length >= 0.6) {
      return rowToMemory(row);
    }
    if (lower.includes(existing) && existing.length / lower.length >= 0.6) {
      return rowToMemory(row);
    }
  }
  return null;
}

/**
 * Find top-K similar memories with similarity scores — used by 4-action dedup.
 */
export async function findTopKSimilarMemories(
  content: string,
  k: number = 3,
  threshold: number = 0.5,
): Promise<Array<{ memory: Memory; similarity: number }>> {
  if (!isEmbedderAvailable() || !isVecAvailable()) return [];

  try {
    const db = getDb();
    const vector = await embed(content);
    const vp = vecParam(vector);
    const { sql: topKSql, params: topKParams } = buildVecSearchQuery(
      "m.*", "m.strength >= 0.05", [], vp, k,
    );
    const rows = db.prepare(topKSql).all(...topKParams) as (MemoryNodeRow & { distance: number })[];

    return rows
      .map((r) => ({
        memory: rowToMemory(r),
        similarity: Math.max(0, Math.min(1, 1 - (r.distance * r.distance) / 2)),
      }))
      .filter((r) => r.similarity >= threshold);
  } catch {
    return [];
  }
}

/**
 * Legacy sync dedup for backward compatibility (used by old upsertMemory path).
 */
function findOverlappingMemory(content: string): Memory | null {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM memory_nodes ORDER BY created_at DESC LIMIT 500")
    .all() as MemoryNodeRow[];

  const lower = content.toLowerCase();
  for (const row of rows) {
    const existing = row.abstract.toLowerCase();
    if (existing === lower) return rowToMemory(row);
    const shorter = Math.min(existing.length, lower.length);
    if (shorter < 10) continue;
    if (existing.includes(lower) && lower.length / existing.length >= 0.6) {
      return rowToMemory(row);
    }
    if (lower.includes(existing) && existing.length / lower.length >= 0.6) {
      return rowToMemory(row);
    }
  }
  return null;
}

/**
 * Smart upsert: skip duplicates, update if new content is longer, insert if no overlap.
 * Wrapped in a transaction to prevent race conditions between find and insert/update.
 * Returns the memory if stored/updated, null if skipped.
 */
export function upsertMemory(
  content: string,
  sourceChannel: string,
  sourceSessionId: string,
): Memory | null {
  const db = getDb();
  const doUpsert = db.transaction(() => {
    const overlap = findOverlappingMemory(content);
    if (!overlap) {
      return createMemory(content, sourceChannel, sourceSessionId);
    }
    if (content.length > overlap.content.length) {
      return updateMemory(overlap.id, content);
    }
    return null;
  });
  return doUpsert();
}

// ─── Memory strength & access tracking ──────────────────────

/** Record that a memory was accessed (boost strength, slow decay). */
export function recordMemoryAccess(id: string, sessionId?: string, queryText?: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Boost strength and slow decay rate (spaced repetition)
  db.prepare(`
    UPDATE memory_nodes SET
      strength = MIN(1.0, strength + 0.15),
      decay_rate = MAX(0.02, decay_rate * 0.8),
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

// ─── Memory count (for health manifest) ─────────────────────

export function getMemoryCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get() as { count: number };
  return row.count;
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

  // Only include edges between nodes in the result set — filter in SQL, not JS
  const nodeIds = nodes.map((n) => n.id);
  let edgeRows: EdgeRow[] = [];
  if (nodeIds.length > 0) {
    const placeholders = nodeIds.map(() => "?").join(",");
    edgeRows = db.prepare(
      `SELECT * FROM memory_edges WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})`
    ).all(...nodeIds, ...nodeIds) as EdgeRow[];
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

