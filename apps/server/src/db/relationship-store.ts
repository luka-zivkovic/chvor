import type { RelationshipState } from "@chvor/shared";
import { getDb } from "./database.ts";

interface RelationshipRow {
  id: string;
  total_sessions: number;
  total_messages: number;
  avg_emotional_depth: number;
  depth: number;
  first_interaction: string | null;
  last_interaction: string | null;
}

function rowToState(row: RelationshipRow): RelationshipState {
  return {
    totalSessions: row.total_sessions,
    totalMessages: row.total_messages,
    avgEmotionalDepth: row.avg_emotional_depth,
    depth: row.depth,
    firstInteraction: row.first_interaction ?? new Date().toISOString(),
    lastInteraction: row.last_interaction ?? new Date().toISOString(),
  };
}

/** Compute relationship depth from component metrics */
function computeDepth(sessions: number, messages: number, avgDepth: number): number {
  // Session familiarity: log curve that saturates around ~30 sessions
  const sessionFactor = Math.min(1, Math.log2(sessions + 1) / 5);
  // Message volume: linear up to 500 messages
  const messageFactor = Math.min(1, messages / 500);
  // Emotional depth: direct passthrough (already 0-1)
  const emotionFactor = Math.min(1, avgDepth);

  return Math.min(1, sessionFactor * 0.4 + messageFactor * 0.3 + emotionFactor * 0.3);
}

/** Get the current relationship state (singleton) */
export function getRelationshipState(): RelationshipState {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM relationship_state WHERE id = 'singleton'"
  ).get() as RelationshipRow | undefined;

  if (!row) {
    const now = new Date().toISOString();
    return {
      totalSessions: 0,
      totalMessages: 0,
      avgEmotionalDepth: 0,
      depth: 0,
      firstInteraction: now,
      lastInteraction: now,
    };
  }

  return rowToState(row);
}

/** Update relationship metrics after each assistant turn (message count + emotional depth) */
export function updateRelationshipAfterTurn(intensity: number): RelationshipState {
  const db = getDb();
  const current = getRelationshipState();
  const now = new Date().toISOString();

  const totalMessages = current.totalMessages + 1;

  // Running average of emotional depth (weighted by message count)
  const avgEmotionalDepth = current.totalMessages === 0
    ? intensity
    : (current.avgEmotionalDepth * current.totalMessages + intensity) / totalMessages;

  const depth = computeDepth(current.totalSessions, totalMessages, avgEmotionalDepth);

  db.prepare(`
    INSERT INTO relationship_state (id, total_sessions, total_messages, avg_emotional_depth, depth, first_interaction, last_interaction)
    VALUES ('singleton', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      total_messages = excluded.total_messages,
      avg_emotional_depth = excluded.avg_emotional_depth,
      depth = excluded.depth,
      last_interaction = excluded.last_interaction
  `).run(
    current.totalSessions,
    totalMessages,
    avgEmotionalDepth,
    depth,
    current.totalSessions === 0 ? now : current.firstInteraction,
    now,
  );

  return {
    totalSessions: current.totalSessions,
    totalMessages,
    avgEmotionalDepth,
    depth,
    firstInteraction: current.totalSessions === 0 ? now : current.firstInteraction,
    lastInteraction: now,
  };
}

/** Increment session count (call once per session start) */
export function incrementRelationshipSession(): void {
  const db = getDb();
  const current = getRelationshipState();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO relationship_state (id, total_sessions, total_messages, avg_emotional_depth, depth, first_interaction, last_interaction)
    VALUES ('singleton', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      total_sessions = excluded.total_sessions,
      last_interaction = excluded.last_interaction
  `).run(
    current.totalSessions + 1,
    current.totalMessages,
    current.avgEmotionalDepth,
    current.depth,
    current.totalSessions === 0 ? now : current.firstInteraction,
    now,
  );
}
