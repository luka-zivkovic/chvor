// ── Legacy exports (backward compat) ──────────────────────────────────────

export type EmotionName =
  | "curious"
  | "excited"
  | "calm"
  | "empathetic"
  | "playful"
  | "focused";

export interface EmotionState {
  emotion: EmotionName;
  intensity: number; // 0.0 - 1.0
}

export const VALID_EMOTIONS: Set<string> = new Set([
  "curious",
  "excited",
  "calm",
  "empathetic",
  "playful",
  "focused",
]);

export const DEFAULT_EMOTION: EmotionState = { emotion: "calm", intensity: 0.5 };

export const EMOTION_COLORS: Record<EmotionName, string> = {
  curious: "oklch(0.72 0.15 200)",
  excited: "oklch(0.70 0.18 60)",
  calm: "oklch(0.62 0.08 250)",
  empathetic: "oklch(0.65 0.16 330)",
  playful: "oklch(0.73 0.17 135)",
  focused: "oklch(0.60 0.20 275)",
};

// ── VAD Dimensional Engine ────────────────────────────────────────────────

export interface VADState {
  valence: number;   // -1.0 to 1.0 (unpleasant ↔ pleasant)
  arousal: number;   // -1.0 to 1.0 (calm ↔ activated)
  dominance: number; // -1.0 to 1.0 (yielding ↔ assertive)
}

export const DEFAULT_VAD: VADState = { valence: 0, arousal: 0, dominance: 0 };

// ── Primary & Secondary Emotions ──────────────────────────────────────────

export type PrimaryEmotion =
  | "joy"
  | "sadness"
  | "anger"
  | "fear"
  | "surprise"
  | "disgust"
  | "trust"
  | "anticipation"
  | "curiosity"
  | "focus";

export type SecondaryEmotion =
  | "love"
  | "awe"
  | "contempt"
  | "remorse"
  | "optimism"
  | "anxiety"
  | "frustration"
  | "amusement"
  | "pride"
  | "nostalgia"
  | "serenity"
  | "determination"
  | "compassion"
  | "irritation"
  | "melancholy"
  | "wonder"
  | "grudging_satisfaction"
  | "protective_concern"
  | "quiet_confidence"
  | "restless_energy";

export type AnyEmotion = PrimaryEmotion | SecondaryEmotion;

export const VALID_PRIMARY_EMOTIONS: Set<string> = new Set<PrimaryEmotion>([
  "joy", "sadness", "anger", "fear", "surprise",
  "disgust", "trust", "anticipation", "curiosity", "focus",
]);

export const VALID_SECONDARY_EMOTIONS: Set<string> = new Set<SecondaryEmotion>([
  "love", "awe", "contempt", "remorse", "optimism",
  "anxiety", "frustration", "amusement", "pride", "nostalgia",
  "serenity", "determination", "compassion", "irritation", "melancholy",
  "wonder", "grudging_satisfaction", "protective_concern",
  "quiet_confidence", "restless_energy",
]);

export const VALID_ALL_EMOTIONS: Set<string> = new Set([
  ...VALID_PRIMARY_EMOTIONS,
  ...VALID_SECONDARY_EMOTIONS,
]);

// ── Emotion Regions in VAD Space (Russell & Mehrabian based) ──────────────

export interface EmotionRegion {
  id: PrimaryEmotion;
  center: VADState;
  radius: number;
}

export const PRIMARY_EMOTION_REGIONS: EmotionRegion[] = [
  { id: "joy",          center: { valence:  0.8, arousal:  0.5, dominance:  0.6 }, radius: 0.5 },
  { id: "sadness",      center: { valence: -0.7, arousal: -0.4, dominance: -0.5 }, radius: 0.5 },
  { id: "anger",        center: { valence: -0.6, arousal:  0.7, dominance:  0.6 }, radius: 0.45 },
  { id: "fear",         center: { valence: -0.7, arousal:  0.7, dominance: -0.6 }, radius: 0.45 },
  { id: "surprise",     center: { valence:  0.2, arousal:  0.8, dominance: -0.1 }, radius: 0.5 },
  { id: "disgust",      center: { valence: -0.6, arousal:  0.3, dominance:  0.4 }, radius: 0.4 },
  { id: "trust",        center: { valence:  0.6, arousal: -0.2, dominance:  0.3 }, radius: 0.5 },
  { id: "anticipation", center: { valence:  0.4, arousal:  0.5, dominance:  0.3 }, radius: 0.45 },
  { id: "curiosity",    center: { valence:  0.5, arousal:  0.4, dominance:  0.1 }, radius: 0.5 },
  { id: "focus",        center: { valence:  0.1, arousal:  0.3, dominance:  0.5 }, radius: 0.45 },
];

// Secondary emotions: defined by parent pair, center = midpoint of parents
export interface SecondaryEmotionDef {
  id: SecondaryEmotion;
  parents: [PrimaryEmotion, PrimaryEmotion];
}

export const SECONDARY_EMOTION_DEFS: SecondaryEmotionDef[] = [
  { id: "love",                 parents: ["joy", "trust"] },
  { id: "awe",                  parents: ["surprise", "fear"] },
  { id: "contempt",             parents: ["anger", "disgust"] },
  { id: "remorse",              parents: ["sadness", "disgust"] },
  { id: "optimism",             parents: ["joy", "anticipation"] },
  { id: "anxiety",              parents: ["fear", "anticipation"] },
  { id: "frustration",          parents: ["anger", "sadness"] },
  { id: "amusement",            parents: ["joy", "surprise"] },
  { id: "pride",                parents: ["joy", "anger"] },     // triumph
  { id: "nostalgia",            parents: ["joy", "sadness"] },
  { id: "serenity",             parents: ["trust", "anticipation"] },
  { id: "determination",        parents: ["anger", "anticipation"] },
  { id: "compassion",           parents: ["sadness", "trust"] },
  { id: "irritation",           parents: ["anger", "surprise"] },
  { id: "melancholy",           parents: ["sadness", "curiosity"] },
  { id: "wonder",               parents: ["curiosity", "surprise"] },
  { id: "grudging_satisfaction", parents: ["joy", "disgust"] },
  { id: "protective_concern",   parents: ["fear", "trust"] },
  { id: "quiet_confidence",     parents: ["trust", "focus"] },
  { id: "restless_energy",      parents: ["anticipation", "fear"] },
];

// ── Emotion Blend ─────────────────────────────────────────────────────────

export interface EmotionBlend {
  primary: { emotion: PrimaryEmotion; weight: number };
  secondary: { emotion: SecondaryEmotion; weight: number } | null;
  intensity: number; // 0-1 overall intensity
}

// ── Emotion Snapshot (persisted, emitted, displayed) ──────────────────────

export interface EmotionSnapshot {
  id?: string;
  sessionId?: string;
  messageId?: string;
  vad: VADState;
  blend: EmotionBlend;
  displayLabel: string;
  color: string;
  signals?: EmotionSignal[];
  timestamp: string;
  advancedState?: AdvancedEmotionState;
}

// ── Advanced Emotion State (optional, attached when advanced mode is on) ──

export type { MoodState, EmbodimentState, RelationshipState, RegulationStrategy } from "./advanced-emotion.js";

/** Lightweight residue summary sent to the client for visualization */
export interface ResidueSummary {
  id: string;
  intensity: number;
}

export interface AdvancedEmotionState {
  mood: import("./advanced-emotion.js").MoodState;
  embodiment: import("./advanced-emotion.js").EmbodimentState;
  relationship: import("./advanced-emotion.js").RelationshipState;
  unresolvedResidues: ResidueSummary[];
  regulationActive: boolean;
  regulationStrategy?: import("./advanced-emotion.js").RegulationStrategy;
}

// ── Personality Gravity ───────────────────────────────────────────────────

export interface EmotionGravity {
  home: VADState;
  gravityStrength: number;  // 0-1, pull-back rate per turn
  emotionalRange: number;   // max Euclidean VAD distance from home
  vocabularyMap: Record<string, string>; // PrimaryEmotion → display label
}

// ── Multi-Signal Input ────────────────────────────────────────────────────

export type EmotionSignalSource =
  | "llm_self_report"
  | "user_sentiment"
  | "tool_outcome"
  | "conversation_pace"
  | "memory_association"
  | "emotional_bleed";

export interface EmotionSignal {
  source: EmotionSignalSource;
  delta: VADState;
  weight: number;
}

// ── Signal source weights ─────────────────────────────────────────────────

export const SIGNAL_WEIGHTS: Record<EmotionSignalSource, number> = {
  llm_self_report: 0.45,
  user_sentiment: 0.25,
  tool_outcome: 0.15,
  conversation_pace: 0.08,
  memory_association: 0.07,
  emotional_bleed: 0.05,
};

// ── Default gravities per personality preset ──────────────────────────────

export const PERSONALITY_GRAVITIES: Record<string, EmotionGravity> = {
  companion: {
    home: { valence: 0.4, arousal: 0.2, dominance: 0.1 },
    gravityStrength: 0.12,
    emotionalRange: 1.2,
    vocabularyMap: {
      joy: "delight",
      curiosity: "fascination",
      trust: "deep trust",
      sadness: "tenderness",
      surprise: "wonder",
      anticipation: "eagerness",
      focus: "attentive care",
      anger: "protective frustration",
      fear: "worry",
      disgust: "discomfort",
    },
  },
  warden: {
    home: { valence: -0.1, arousal: 0.3, dominance: 0.8 },
    gravityStrength: 0.25,
    emotionalRange: 0.7,
    vocabularyMap: {
      joy: "grudging satisfaction",
      curiosity: "suspicious interest",
      trust: "provisional tolerance",
      sadness: "quiet displeasure",
      surprise: "reluctant intrigue",
      anticipation: "calculated expectation",
      focus: "surgical precision",
      anger: "exasperated competence",
      fear: "heightened alertness",
      disgust: "pointed disdain",
    },
  },
  steward: {
    home: { valence: 0.2, arousal: -0.1, dominance: 0.5 },
    gravityStrength: 0.20,
    emotionalRange: 0.8,
    vocabularyMap: {
      joy: "quiet satisfaction",
      curiosity: "noted interest",
      trust: "steady confidence",
      sadness: "measured concern",
      surprise: "raised eyebrow",
      anticipation: "preparedness",
      focus: "peak operational clarity",
      anger: "diplomatic firmness",
      fear: "heightened vigilance",
      disgust: "understated disapproval",
    },
  },
  copilot: {
    home: { valence: 0.15, arousal: 0.2, dominance: 0.3 },
    gravityStrength: 0.18,
    emotionalRange: 0.9,
    vocabularyMap: {
      joy: "solid",
      curiosity: "interesting",
      trust: "got your back",
      sadness: "that's rough",
      surprise: "huh",
      anticipation: "let's go",
      focus: "locked in",
      anger: "not great",
      fear: "heads up",
      disgust: "yeah no",
    },
  },
  operator: {
    home: { valence: 0.0, arousal: 0.3, dominance: 0.7 },
    gravityStrength: 0.30,
    emotionalRange: 0.6,
    vocabularyMap: {
      joy: "objective achieved",
      curiosity: "investigating",
      trust: "asset verified",
      sadness: "setback noted",
      surprise: "situation update",
      anticipation: "standing by",
      focus: "mission-critical focus",
      anger: "obstacle identified",
      fear: "threat assessment",
      disgust: "non-viable",
    },
  },
  oracle: {
    home: { valence: 0.1, arousal: -0.3, dominance: 0.4 },
    gravityStrength: 0.22,
    emotionalRange: 0.7,
    vocabularyMap: {
      joy: "intellectually pleased",
      curiosity: "a point worth examining",
      trust: "well-founded confidence",
      sadness: "contemplative weight",
      surprise: "unexpected variable",
      anticipation: "projected outcome",
      focus: "analytical immersion",
      anger: "noted irrationality",
      fear: "calculated risk",
      disgust: "logical inconsistency",
    },
  },
};

// ── Legacy ↔ VAD bridge ───────────────────────────────────────────────────

const LEGACY_TO_PRIMARY: Record<EmotionName, PrimaryEmotion> = {
  curious: "curiosity",
  excited: "anticipation",
  calm: "trust",
  empathetic: "trust",
  playful: "joy",
  focused: "focus",
};

const LEGACY_TO_VAD: Record<EmotionName, VADState> = {
  curious:    { valence:  0.5, arousal: 0.4, dominance:  0.1 },
  excited:    { valence:  0.7, arousal: 0.7, dominance:  0.4 },
  calm:       { valence:  0.3, arousal: -0.3, dominance:  0.2 },
  empathetic: { valence:  0.4, arousal: 0.0, dominance: -0.2 },
  playful:    { valence:  0.7, arousal: 0.5, dominance:  0.3 },
  focused:    { valence:  0.1, arousal: 0.3, dominance:  0.5 },
};

/** Convert VAD to an OKLch color string */
export function vadToColor(vad: VADState): string {
  // L: valence maps to lightness (0.45 dark negative → 0.78 bright positive)
  const L = 0.45 + ((vad.valence + 1) / 2) * 0.33;
  // C: arousal maps to chroma (0.05 desaturated calm → 0.22 vivid excited)
  const C = 0.05 + ((vad.arousal + 1) / 2) * 0.17;
  // H: composite hue from valence × dominance
  const angle = ((1 - vad.valence) / 2) * 200 + ((1 - vad.dominance) / 2) * 80 + 20;
  const H = angle % 360;
  return `oklch(${L.toFixed(2)} ${C.toFixed(2)} ${H.toFixed(0)})`;
}

/** Convert a legacy EmotionState to the new EmotionSnapshot format */
export function upgradeLegacyEmotion(legacy: EmotionState): EmotionSnapshot {
  const vad = LEGACY_TO_VAD[legacy.emotion];
  const primary = LEGACY_TO_PRIMARY[legacy.emotion];
  return {
    vad,
    blend: {
      primary: { emotion: primary, weight: legacy.intensity },
      secondary: null,
      intensity: legacy.intensity,
    },
    displayLabel: legacy.emotion,
    color: EMOTION_COLORS[legacy.emotion],
    timestamp: new Date().toISOString(),
  };
}
