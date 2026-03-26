import { randomUUID } from "node:crypto";
import type { EmotionSnapshot, EmotionSignal, PrimaryEmotion, SecondaryEmotion } from "@chvor/shared";
import { vadToColor } from "@chvor/shared";
import { getDb } from "./database.ts";

// ── Insert ────────────────────────────────────────────────────────────────

export function insertEmotionSnapshot(
  sessionId: string,
  snapshot: EmotionSnapshot,
  messageId?: string
): string {
  const db = getDb();
  const id = snapshot.id || randomUUID();

  db.prepare(`
    INSERT INTO emotion_snapshots (
      id, session_id, message_id,
      valence, arousal, dominance,
      primary_emotion, primary_weight,
      secondary_emotion, secondary_weight,
      intensity, display_label, signals,
      trigger, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sessionId,
    messageId ?? null,
    snapshot.vad.valence,
    snapshot.vad.arousal,
    snapshot.vad.dominance,
    snapshot.blend.primary.emotion,
    snapshot.blend.primary.weight,
    snapshot.blend.secondary?.emotion ?? null,
    snapshot.blend.secondary?.weight ?? null,
    snapshot.blend.intensity,
    snapshot.displayLabel,
    snapshot.signals ? JSON.stringify(snapshot.signals) : null,
    "message",
    snapshot.timestamp,
  );

  return id;
}

// ── Query ─────────────────────────────────────────────────────────────────

interface EmotionSnapshotRow {
  id: string;
  session_id: string;
  message_id: string | null;
  valence: number;
  arousal: number;
  dominance: number;
  primary_emotion: string;
  primary_weight: number;
  secondary_emotion: string | null;
  secondary_weight: number | null;
  intensity: number;
  display_label: string;
  signals: string | null;
  trigger: string;
  created_at: string;
}

function rowToSnapshot(row: EmotionSnapshotRow): EmotionSnapshot {
  let signals: EmotionSignal[] | undefined;
  if (row.signals) {
    try {
      signals = JSON.parse(row.signals);
    } catch (e) { console.warn("[emotion-store] malformed signals JSON:", e); }
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id ?? undefined,
    vad: { valence: row.valence, arousal: row.arousal, dominance: row.dominance },
    blend: {
      primary: { emotion: row.primary_emotion as PrimaryEmotion, weight: row.primary_weight },
      secondary:
        row.secondary_emotion && row.secondary_weight != null
          ? { emotion: row.secondary_emotion as SecondaryEmotion, weight: row.secondary_weight }
          : null,
      intensity: row.intensity,
    },
    displayLabel: row.display_label,
    color: vadToColor({ valence: row.valence, arousal: row.arousal, dominance: row.dominance }),
    signals,
    timestamp: row.created_at,
  };
}

/** Get the emotion arc for a session (ordered by time, capped at limit) */
export function getSessionEmotionArc(sessionId: string, limit = 500): EmotionSnapshot[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM emotion_snapshots WHERE session_id = ? ORDER BY created_at ASC LIMIT ?"
  ).all(sessionId, limit) as EmotionSnapshotRow[];

  return rows.map(rowToSnapshot);
}

/** Get the most recent emotion snapshot for a session */
export function getLatestEmotion(sessionId: string): EmotionSnapshot | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM emotion_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(sessionId) as EmotionSnapshotRow | undefined;

  return row ? rowToSnapshot(row) : null;
}

/** Get recent emotion history across all sessions */
export function getEmotionHistory(limit = 100): EmotionSnapshot[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM emotion_snapshots ORDER BY created_at DESC LIMIT ?"
  ).all(limit) as EmotionSnapshotRow[];

  return rows.map(rowToSnapshot);
}

/** Get emotion frequency/pattern data for the last N days */
export function getEmotionPatterns(days = 30): {
  frequencies: Record<string, number>;
  avgVAD: { valence: number; arousal: number; dominance: number };
  totalSnapshots: number;
} {
  const db = getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(
    "SELECT primary_emotion, valence, arousal, dominance FROM emotion_snapshots WHERE created_at > ?"
  ).all(cutoff) as { primary_emotion: string; valence: number; arousal: number; dominance: number }[];

  const frequencies: Record<string, number> = {};
  let sumV = 0, sumA = 0, sumD = 0;

  for (const row of rows) {
    frequencies[row.primary_emotion] = (frequencies[row.primary_emotion] || 0) + 1;
    sumV += row.valence;
    sumA += row.arousal;
    sumD += row.dominance;
  }

  const n = rows.length || 1;
  return {
    frequencies,
    avgVAD: { valence: sumV / n, arousal: sumA / n, dominance: sumD / n },
    totalSnapshots: rows.length,
  };
}

/** Prune old snapshots beyond maxAge days */
export function pruneOldSnapshots(maxAgeDays = 90): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(
    "DELETE FROM emotion_snapshots WHERE created_at < ?"
  ).run(cutoff);

  return result.changes;
}
