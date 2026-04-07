/**
 * Memory Graph — Associative memory operations.
 *
 * Handles spreading activation, co-access edge strengthening, and
 * automatic edge creation based on entity co-occurrence and semantic proximity.
 */

import type { Memory, EdgeRelation } from "@chvor/shared";
import {
  getNeighborMemories,
  getEdgesForMemory,
  createEdge,
  boostEdgeWeight,
  recordMemoryAccess,
} from "../db/memory-store.ts";
import { getDb } from "../db/database.ts";

// Per-session access dedup: only record once per memory per session to prevent
// strength inflation from repeated retrieval on every conversation turn
const sessionAccessSets = new Map<string, Set<string>>();

/** Clear session access tracking (call on session cleanup). */
export function clearSessionAccessTracking(sessionId: string): void {
  sessionAccessSets.delete(sessionId);
}

function shouldRecordAccess(memoryId: string, sessionId?: string): boolean {
  if (!sessionId) return true; // no session = always record
  let set = sessionAccessSets.get(sessionId);
  if (!set) {
    set = new Set();
    sessionAccessSets.set(sessionId, set);
  }
  if (set.has(memoryId)) return false;
  set.add(memoryId);
  return true;
}

// Relation-specific bonuses for spreading activation scoring
const RELATION_BONUS: Record<EdgeRelation, number> = {
  causal: 1.5,
  entity: 1.2,
  narrative: 1.2,
  supersedes: 1.1,
  temporal: 1.0,
  semantic: 0.8,
  contradiction: 0.3,
};

export interface ActivatedMemory {
  memory: Memory;
  activationScore: number;
  /** How this memory was found — "direct" = vector match, "associated" = graph neighbor */
  source: "direct" | "associated";
  /** The relation that led to this association (only for source="associated") */
  relation?: EdgeRelation;
}

/**
 * Spreading activation: given a set of directly retrieved memories,
 * find associated memories through graph edges and score them.
 *
 * This is the core of the associative memory — it finds related memories
 * that vector similarity alone would miss.
 */
export function spreadActivation(
  directMemories: Memory[],
  maxNeighbors: number = 10,
  sessionId?: string,
  queryText?: string,
): ActivatedMemory[] {
  const results: ActivatedMemory[] = [];
  const seen = new Set<string>();

  // Score direct memories (they keep their retrieval order as base score)
  for (let i = 0; i < directMemories.length; i++) {
    const mem = directMemories[i];
    seen.add(mem.id);
    results.push({
      memory: mem,
      activationScore: 1.0 - i * 0.05, // slight decay by position
      source: "direct",
    });

    // Record access for direct matches (boosts strength + logs for preloading)
    // Deduped per-session to prevent strength inflation from repeated retrieval every turn
    if (shouldRecordAccess(mem.id, sessionId)) {
      recordMemoryAccess(mem.id, sessionId, queryText);
    }
  }

  // Spread to neighbors
  const neighborScores = new Map<string, { memory: Memory; score: number; relation: EdgeRelation }>();

  for (const mem of directMemories) {
    const edges = getEdgesForMemory(mem.id);
    const neighbors = getNeighborMemories(mem.id);
    const neighborMap = new Map(neighbors.map((n) => [n.id, n]));

    for (const edge of edges) {
      const neighborId = edge.sourceId === mem.id ? edge.targetId : edge.sourceId;
      if (seen.has(neighborId)) continue;

      const neighbor = neighborMap.get(neighborId);
      if (!neighbor) continue;

      const relation = edge.relation as EdgeRelation;
      const score = edge.weight * neighbor.strength * (RELATION_BONUS[relation] ?? 1.0);

      const existing = neighborScores.get(neighborId);
      if (!existing || score > existing.score) {
        neighborScores.set(neighborId, { memory: neighbor, score, relation });
      }
    }
  }

  // Sort neighbors by score and take top-K
  const sortedNeighbors = [...neighborScores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxNeighbors);

  for (const { memory, score, relation } of sortedNeighbors) {
    seen.add(memory.id);
    results.push({
      memory,
      activationScore: score,
      source: "associated",
      relation,
    });

    // Small priming boost for activated neighbors (deduped per-session)
    if (shouldRecordAccess(memory.id, sessionId)) {
      recordMemoryAccess(memory.id, sessionId);
    }
  }

  return results;
}

/**
 * Strengthen edges between memories accessed in the same session.
 * Called after a retrieval pass — if two memories were both accessed,
 * their connection should get stronger (Hebbian learning: "fire together, wire together").
 */
export function strengthenCoAccessedEdges(memoryIds: string[]): void {
  if (memoryIds.length < 2) return;

  // Cap to prevent O(n²) blowup — 20 IDs = max 190 pairs
  const capped = memoryIds.length > 20 ? memoryIds.slice(0, 20) : memoryIds;

  // Only boost edges that already exist — don't create phantom associations
  // between unrelated memories that happened to be co-retrieved by coincidence
  const db = getDb();
  const tx = db.transaction(() => {
    for (let i = 0; i < capped.length; i++) {
      for (let j = i + 1; j < capped.length; j++) {
        // boostEdgeWeight only UPDATEs existing edges (no INSERT), so this is safe
        // but reduce boost to prevent graph densification from broad queries
        boostEdgeWeight(capped[i], capped[j], 0.02);
      }
    }
  });
  tx();
}

/**
 * Create entity-based edges between memories that share named entities.
 * Call during extraction when relatedEntities are known.
 */
export function linkBySharedEntities(
  newMemoryId: string,
  entities: string[],
  existingMemories: Memory[],
): void {
  if (!entities.length) return;

  const entityPatterns = entities
    .filter((e) => e.length >= 3) // skip very short entity names to avoid false matches
    .map((e) => ({
      lower: e.toLowerCase(),
      regex: new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
    }));

  if (!entityPatterns.length) return;

  for (const existing of existingMemories) {
    // Check if the existing memory's abstract mentions any of our entities (word-boundary match)
    for (const { regex } of entityPatterns) {
      if (regex.test(existing.abstract)) {
        createEdge(newMemoryId, existing.id, "entity", 0.6);
        break; // one edge per pair
      }
    }
  }
}
