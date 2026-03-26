import { randomUUID } from "node:crypto";
import type { EmotionalResidue, PrimaryEmotion, VADState } from "@chvor/shared";
import { getDb } from "./database.ts";

interface ResidueRow {
  id: string;
  session_id: string;
  snapshot_id: string;
  valence: number;
  arousal: number;
  dominance: number;
  primary_emotion: string;
  intensity: number;
  topic_hint: string;
  unresolved_since: string;
  resolved: number;
  resolved_at: string | null;
}

function rowToResidue(row: ResidueRow): EmotionalResidue {
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    sessionId: row.session_id,
    vad: { valence: row.valence, arousal: row.arousal, dominance: row.dominance },
    primaryEmotion: row.primary_emotion as PrimaryEmotion,
    intensity: row.intensity,
    topicHint: row.topic_hint,
    unresolvedSince: row.unresolved_since,
    resolved: row.resolved === 1,
    turnAge: 0, // computed at runtime by the engine
  };
}

/** Insert a new emotional residue (unresolved thread) */
export function insertResidue(residue: Omit<EmotionalResidue, "id" | "turnAge">): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO emotion_residues (
      id, session_id, snapshot_id,
      valence, arousal, dominance,
      primary_emotion, intensity, topic_hint,
      unresolved_since, resolved
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    residue.sessionId,
    residue.snapshotId,
    residue.vad.valence,
    residue.vad.arousal,
    residue.vad.dominance,
    residue.primaryEmotion,
    residue.intensity,
    residue.topicHint,
    residue.unresolvedSince,
    residue.resolved ? 1 : 0,
  );
  return id;
}

/** Get unresolved emotional residues, most recent first */
export function getUnresolvedResidues(limit = 5): EmotionalResidue[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM emotion_residues WHERE resolved = 0 ORDER BY unresolved_since DESC LIMIT ?"
  ).all(limit) as ResidueRow[];
  return rows.map(rowToResidue);
}

/** Resolve a specific residue */
export function resolveResidue(id: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE emotion_residues SET resolved = 1, resolved_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), id);
}

/** Resolve all residues (e.g., on significant emotional shift) */
export function resolveAllResidues(): void {
  const db = getDb();
  db.prepare(
    "UPDATE emotion_residues SET resolved = 1, resolved_at = ? WHERE resolved = 0"
  ).run(new Date().toISOString());
}

/** Prune old resolved residues */
export function pruneOldResidues(maxAgeDays = 30): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(
    "DELETE FROM emotion_residues WHERE resolved = 1 AND resolved_at < ?"
  ).run(cutoff);
  return result.changes;
}
