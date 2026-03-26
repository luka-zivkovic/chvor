import type { PrimaryEmotion, VADState } from "./emotion.js";

// ── Per-Emotion Inertia (Enhancement 1) ──────────────────────────────────
// Higher values = more resistance to change. Sadness lingers, surprise is fleeting.

export const EMOTION_INERTIA: Record<PrimaryEmotion, number> = {
  sadness: 0.70,
  anger: 0.55,
  disgust: 0.50,
  fear: 0.45,
  trust: 0.40,
  focus: 0.35,
  anticipation: 0.30,
  curiosity: 0.25,
  joy: 0.20,
  surprise: 0.10,
};

// ── Mood Layer (Enhancement 2) ───────────────────────────────────────────
// Medium-term affect: exponential moving average of recent emotion snapshots.

export type MoodOctant =
  | "exuberant"   // +V +A +D
  | "anxious"     // -V +A -D
  | "hostile"     // -V +A +D
  | "bored"       // -V -A -D
  | "relaxed"     // +V -A +D
  | "docile"      // +V -A -D
  | "disdainful"  // -V -A +D
  | "dependent";  // +V +A -D

export interface MoodState {
  vad: VADState;
  octant: MoodOctant;
  since: string;       // ISO timestamp when this octant started
  turnCount: number;   // turns in current octant
}

export function resolveMoodOctant(vad: VADState): MoodOctant {
  const v = vad.valence >= 0;
  const a = vad.arousal >= 0;
  const d = vad.dominance >= 0;

  if (v && a && d) return "exuberant";
  if (v && a && !d) return "dependent";
  if (v && !a && d) return "relaxed";
  if (v && !a && !d) return "docile";
  if (!v && a && d) return "hostile";
  if (!v && a && !d) return "anxious";
  if (!v && !a && d) return "disdainful";
  return "bored";
}

// ── Emotional Memory Bleed (Enhancement 3) ───────────────────────────────

export interface EmotionalResidue {
  id: string;
  snapshotId: string;
  sessionId: string;
  vad: VADState;
  primaryEmotion: PrimaryEmotion;
  intensity: number;
  topicHint: string;
  unresolvedSince: string;  // ISO timestamp
  resolved: boolean;
  turnAge: number;           // how many turns since created (runtime only)
}

// ── Embodied Modulation (Enhancement 4) ──────────────────────────────────

export interface EmbodimentState {
  energyLevel: number;          // 1.0 → 0.0 (depletes over conversation)
  regulationCapacity: number;   // 1.0 → 0.0 (depletes with each regulation)
}

// ── Regulation Engine (Enhancement 5) ────────────────────────────────────

export type RegulationStrategy = "reappraisal" | "suppression" | "acceptance";

export interface RegulationPreference {
  primary: RegulationStrategy;
  secondary: RegulationStrategy;
  thresholdDistance: number;      // VAD distance from home before regulation kicks in
  suppressionStrength: number;    // 0-1: how much to reduce display intensity
  reappraisalStrength: number;    // 0-1: how much to lerp toward home
}

export const PERSONALITY_REGULATION: Record<string, RegulationPreference> = {
  companion: {
    primary: "acceptance",
    secondary: "reappraisal",
    thresholdDistance: 0.9,
    suppressionStrength: 0.2,
    reappraisalStrength: 0.3,
  },
  warden: {
    primary: "suppression",
    secondary: "reappraisal",
    thresholdDistance: 0.5,
    suppressionStrength: 0.6,
    reappraisalStrength: 0.4,
  },
  steward: {
    primary: "reappraisal",
    secondary: "suppression",
    thresholdDistance: 0.6,
    suppressionStrength: 0.4,
    reappraisalStrength: 0.5,
  },
  copilot: {
    primary: "acceptance",
    secondary: "suppression",
    thresholdDistance: 0.7,
    suppressionStrength: 0.3,
    reappraisalStrength: 0.3,
  },
  operator: {
    primary: "suppression",
    secondary: "reappraisal",
    thresholdDistance: 0.4,
    suppressionStrength: 0.7,
    reappraisalStrength: 0.5,
  },
  oracle: {
    primary: "reappraisal",
    secondary: "acceptance",
    thresholdDistance: 0.5,
    suppressionStrength: 0.3,
    reappraisalStrength: 0.6,
  },
};

// ── Relational Context (Enhancement 6) ───────────────────────────────────

export interface RelationshipState {
  totalSessions: number;
  totalMessages: number;
  avgEmotionalDepth: number;  // running avg of emotion intensity
  depth: number;              // 0-1 computed relationship depth
  firstInteraction: string;   // ISO timestamp
  lastInteraction: string;
}

export type RelationshipStage = "early" | "developing" | "established" | "deep";

export function getRelationshipStage(depth: number): RelationshipStage {
  if (depth >= 0.8) return "deep";
  if (depth >= 0.5) return "established";
  if (depth >= 0.2) return "developing";
  return "early";
}
