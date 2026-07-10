import type { Memory } from "@chvor/shared";
import { getDb, isVecAvailable } from "../database.ts";
import { embed, isEmbedderAvailable } from "../../lib/embedder.ts";
import { rowToMemory, type MemoryNodeRow } from "./types.ts";

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
    const buf = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);

    const rows = db.prepare(`
      SELECT m.abstract
      FROM memory_node_vec v
      JOIN memory_nodes m ON m.id = v.id
      WHERE v.embedding MATCH ?
        AND m.strength >= ?
      ORDER BY v.distance
      LIMIT ?
    `).all(buf, strengthThreshold, limit) as { abstract: string }[];

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
    const buf = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);

    const rows = db.prepare(`
      SELECT m.*, v.distance
      FROM memory_node_vec v
      JOIN memory_nodes m ON m.id = v.id
      WHERE v.embedding MATCH ?
        AND m.strength >= ?
      ORDER BY v.distance
      LIMIT ?
    `).all(buf, strengthThreshold, limit) as (MemoryNodeRow & { distance: number })[];

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
    const buf = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);

    const primaryBudget = Math.ceil(limit * 0.7);
    const seen = new Set<string>();
    const results: Array<{ memory: Memory; vectorSimilarity: number; categoryMatch: "primary" | "fallback" }> = [];

    // Phase 1: per-primary-category search
    const perCategoryLimit = Math.ceil(primaryBudget / primaryCategories.length);
    for (const cat of primaryCategories) {
      try {
        const rows = db.prepare(`
          SELECT m.*, v.distance
          FROM memory_node_vec v
          JOIN memory_nodes m ON m.id = v.id
          WHERE v.embedding MATCH ?
            AND m.strength >= ?
            AND m.category = ?
          ORDER BY v.distance
          LIMIT ?
        `).all(buf, strengthThreshold, cat, perCategoryLimit) as (MemoryNodeRow & { distance: number })[];

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
        const rows = db.prepare(`
          SELECT m.*, v.distance
          FROM memory_node_vec v
          JOIN memory_nodes m ON m.id = v.id
          WHERE v.embedding MATCH ?
            AND m.strength >= ?
          ORDER BY v.distance
          LIMIT ?
        `).all(buf, strengthThreshold, remaining + seen.size) as (MemoryNodeRow & { distance: number })[];

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
    // Conservative estimate: chars/3 accounts for code, URLs, non-Latin text
    const estimate = Math.ceil(r.abstract.length / 3);
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
      const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
      const row = db.prepare(`
        SELECT m.*, v.distance
        FROM memory_node_vec v
        JOIN memory_nodes m ON m.id = v.id
        WHERE v.embedding MATCH ?
        ORDER BY v.distance
        LIMIT 1
      `).get(buf) as (MemoryNodeRow & { distance: number }) | undefined;

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
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const rows = db.prepare(`
      SELECT m.*, v.distance
      FROM memory_node_vec v
      JOIN memory_nodes m ON m.id = v.id
      WHERE v.embedding MATCH ?
        AND m.strength >= 0.05
      ORDER BY v.distance
      LIMIT ?
    `).all(buf, k) as (MemoryNodeRow & { distance: number })[];

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
