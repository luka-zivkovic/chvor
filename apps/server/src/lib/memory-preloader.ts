/**
 * Predictive Memory Preloader — topic transition model for anticipatory retrieval.
 *
 * Tracks which memory topics tend to follow each other in conversations,
 * then preloads likely-needed memories before they're explicitly relevant.
 *
 * Like CPU cache prefetching, but for context.
 */

import { getDb } from "../db/database.ts";
import type { Memory } from "@chvor/shared";
import { getCognitiveMemoryConfig } from "../db/config-store.ts";

interface TopicTransition {
  fromTopic: string;
  toTopic: string;
  count: number;
}

/**
 * Build a topic hash from a memory's category + first entity keyword.
 * Used as a lightweight fingerprint for topic transition tracking.
 */
const STOPWORDS = new Set([
  "the", "this", "that", "with", "from", "have", "been", "will", "they", "their",
  "about", "would", "could", "should", "also", "just", "does", "like", "want",
  "uses", "used", "using", "very", "some", "more", "most", "much", "many",
  "into", "over", "when", "what", "which", "where", "were", "them", "then",
  "than", "there", "these", "those", "each", "every", "both", "other", "only",
]);

export function computeTopicHash(memory: Memory): string {
  // Extract first 2 significant words from abstract for lower collision rate
  const words = memory.abstract.toLowerCase().split(/\s+/).filter(
    (w) => w.length > 3 && !STOPWORDS.has(w)
  );
  const keywords = words.slice(0, 2).join("+") || "general";
  return `${memory.category}:${keywords}`;
}

/**
 * Get topic transition frequencies from the access log.
 * Finds patterns like: "when entity:postgres is accessed, preference:database often follows"
 */
export function getTopicTransitions(limit: number = 20): TopicTransition[] {
  const db = getDb();

  // Get sequential access pairs within the same session
  const rows = db.prepare(`
    SELECT
      a1.topic_hash AS from_topic,
      a2.topic_hash AS to_topic,
      COUNT(*) AS count
    FROM memory_access_log a1
    JOIN memory_access_log a2
      ON a1.session_id = a2.session_id
      AND a2.accessed_at > a1.accessed_at
      AND julianday(a2.accessed_at) - julianday(a1.accessed_at) < 0.01  -- within ~15 minutes
    WHERE a1.topic_hash IS NOT NULL
      AND a2.topic_hash IS NOT NULL
      AND a1.topic_hash != a2.topic_hash
      AND a1.accessed_at > datetime('now', '-30 days')  -- bound query to recent history
    GROUP BY a1.topic_hash, a2.topic_hash
    HAVING count >= 2
    ORDER BY count DESC
    LIMIT ?
  `).all(limit) as TopicTransition[];

  return rows;
}

/**
 * Given currently accessed topics, predict which topics will be needed next
 * and return memory IDs to preload.
 */
export function predictNextMemories(
  currentTopicHashes: string[],
  maxPreload: number = 5,
): string[] {
  const config = getCognitiveMemoryConfig();
  if (!config.preloadingEnabled) return [];
  if (currentTopicHashes.length === 0) return [];

  const transitions = getTopicTransitions();
  if (transitions.length === 0) return [];

  // Find likely next topics based on current topics
  const nextTopicScores = new Map<string, number>();
  for (const current of currentTopicHashes) {
    for (const t of transitions) {
      if (t.fromTopic === current) {
        const existing = nextTopicScores.get(t.toTopic) ?? 0;
        nextTopicScores.set(t.toTopic, existing + t.count);
      }
    }
  }

  // Sort by frequency and take top candidates
  const predictedTopics = [...nextTopicScores.entries()]
    .filter(([topic]) => !currentTopicHashes.includes(topic)) // exclude already-accessed
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxPreload)
    .map(([topic]) => topic);

  if (predictedTopics.length === 0) return [];

  // Find memories matching predicted topics
  const db = getDb();
  const memoryIds: string[] = [];
  const seen = new Set<string>();

  // Prepare statement once outside the loop
  const topicStmt = db.prepare(`
    SELECT m.id
    FROM memory_access_log a
    JOIN memory_nodes m ON m.id = a.memory_id AND m.strength >= 0.05
    WHERE a.topic_hash = ?
    ORDER BY a.accessed_at DESC
    LIMIT 2
  `);

  for (const topic of predictedTopics) {
    const rows = topicStmt.all(topic) as { id: string }[];

    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        memoryIds.push(row.id);
      }
    }

    if (memoryIds.length >= maxPreload) break;
  }

  return memoryIds.slice(0, maxPreload);
}

/**
 * Update topic hashes in the access log for recently accessed memories.
 * Called after retrieval to keep the transition model fresh.
 */
export function updateAccessLogTopics(
  memoryTopicPairs: Array<{ memoryId: string; topicHash: string }>,
): void {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE memory_access_log SET topic_hash = ?
     WHERE id = (
       SELECT id FROM memory_access_log
       WHERE memory_id = ? AND topic_hash IS NULL
       ORDER BY accessed_at DESC LIMIT 1
     )`
  );
  const tx = db.transaction(() => {
    for (const { memoryId, topicHash } of memoryTopicPairs) {
      stmt.run(topicHash, memoryId);
    }
  });
  tx();
}
