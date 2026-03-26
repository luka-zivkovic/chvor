import type { EmotionState, EmotionName, EmotionSnapshot, VADState, PrimaryEmotion, SecondaryEmotion } from "@chvor/shared";
import { vadToColor } from "@chvor/shared";
import { resolveEmotionBlend } from "./emotion-engine.ts";

// ── Inlined validation sets (can't use runtime workspace imports on Windows junction) ──

const VALID_EMOTIONS = new Set(["curious", "excited", "calm", "empathetic", "playful", "focused"]);
const DEFAULT_EMOTION: EmotionState = { emotion: "calm", intensity: 0.5 };

const VALID_PRIMARY = new Set([
  "joy", "sadness", "anger", "fear", "surprise",
  "disgust", "trust", "anticipation", "curiosity", "focus",
]);

const VALID_SECONDARY = new Set([
  "love", "awe", "contempt", "remorse", "optimism",
  "anxiety", "frustration", "amusement", "pride", "nostalgia",
  "serenity", "determination", "compassion", "irritation", "melancholy",
  "wonder", "grudging_satisfaction", "protective_concern",
  "quiet_confidence", "restless_energy",
]);

// ── Regex patterns ────────────────────────────────────────────────────────

// Enhanced: [E:primary/intensity+secondary/intensity|V,A,D]
const ENHANCED_MARKER_RE = /^\[E:([\w]+)\/([\d.]+)(?:\+([\w]+)\/([\d.]+))?\|(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]\s*/;

// Legacy: [EMOTION:name:intensity]
const LEGACY_MARKER_RE = /^\[EMOTION:(\w+):([\d.]+)\]\s*/;

const MAX_BUFFER_CHARS = 150;

// ── Legacy → VAD lookup ───────────────────────────────────────────────────

const LEGACY_TO_PRIMARY: Record<string, PrimaryEmotion> = {
  curious: "curiosity",
  excited: "anticipation",
  calm: "trust",
  empathetic: "trust",
  playful: "joy",
  focused: "focus",
};

const LEGACY_TO_VAD: Record<string, VADState> = {
  curious:    { valence:  0.5, arousal: 0.4, dominance:  0.1 },
  excited:    { valence:  0.7, arousal: 0.7, dominance:  0.4 },
  calm:       { valence:  0.3, arousal: -0.3, dominance:  0.2 },
  empathetic: { valence:  0.4, arousal: 0.0, dominance: -0.2 },
  playful:    { valence:  0.7, arousal: 0.5, dominance:  0.3 },
  focused:    { valence:  0.1, arousal: 0.3, dominance:  0.5 },
};

// ── Parser result types ───────────────────────────────────────────────────

export interface EmotionParserResult {
  emotion: EmotionState;
  snapshot: EmotionSnapshot;
  strippedText: string;
}

// ── Parse functions ───────────────────────────────────────────────────────

function parseEnhancedMarker(text: string): { snapshot: EmotionSnapshot; remainder: string } | null {
  const match = text.match(ENHANCED_MARKER_RE);
  if (!match) return null;

  const primaryName = match[1].toLowerCase();
  const primaryIntensity = parseFloat(match[2]);
  const secondaryName = match[3]?.toLowerCase();
  const secondaryIntensity = match[4] ? parseFloat(match[4]) : 0;
  const v = parseFloat(match[5]);
  const a = parseFloat(match[6]);
  const d = parseFloat(match[7]);

  // Validate primary — must be a known emotion (primary or secondary)
  if (!VALID_PRIMARY.has(primaryName) && !VALID_SECONDARY.has(primaryName)) return null;
  if (isNaN(primaryIntensity)) return null;
  if (isNaN(v) || isNaN(a) || isNaN(d)) return null;

  // Validate secondary if present — can be primary or secondary emotion
  if (secondaryName && !VALID_PRIMARY.has(secondaryName) && !VALID_SECONDARY.has(secondaryName)) {
    return null;
  }

  const vad: VADState = {
    valence: Math.max(-1, Math.min(1, v)),
    arousal: Math.max(-1, Math.min(1, a)),
    dominance: Math.max(-1, Math.min(1, d)),
  };

  const snapshot: EmotionSnapshot = {
    vad,
    blend: {
      primary: {
        emotion: primaryName as PrimaryEmotion,
        weight: Math.max(0, Math.min(1, primaryIntensity)),
      },
      secondary: secondaryName
        ? { emotion: secondaryName as SecondaryEmotion, weight: Math.max(0, Math.min(1, secondaryIntensity)) }
        : null,
      intensity: Math.max(0, Math.min(1, primaryIntensity)),
    },
    displayLabel: primaryName,
    color: vadToColor(vad),
    timestamp: new Date().toISOString(),
  };

  return { snapshot, remainder: text.slice(match[0].length) };
}

function parseLegacyMarker(text: string): { snapshot: EmotionSnapshot; remainder: string } | null {
  const match = text.match(LEGACY_MARKER_RE);
  if (!match) return null;

  const name = match[1].toLowerCase();
  const rawIntensity = parseFloat(match[2]);

  if (!VALID_EMOTIONS.has(name) || isNaN(rawIntensity)) return null;

  const intensity = Math.max(0, Math.min(1, rawIntensity));
  const vad = LEGACY_TO_VAD[name] ?? { valence: 0, arousal: 0, dominance: 0 };
  const primary = LEGACY_TO_PRIMARY[name] ?? "curiosity";

  const snapshot: EmotionSnapshot = {
    vad,
    blend: {
      primary: { emotion: primary as PrimaryEmotion, weight: intensity },
      secondary: null,
      intensity,
    },
    displayLabel: name,
    color: vadToColor(vad),
    timestamp: new Date().toISOString(),
  };

  return { snapshot, remainder: text.slice(match[0].length) };
}

// ── Default snapshot ──────────────────────────────────────────────────────

function defaultSnapshot(): EmotionSnapshot {
  const vad: VADState = { valence: 0.3, arousal: -0.3, dominance: 0.2 };
  return {
    vad,
    blend: resolveEmotionBlend(vad),
    displayLabel: "calm",
    color: vadToColor(vad),
    timestamp: new Date().toISOString(),
  };
}

// ── Streaming parser ──────────────────────────────────────────────────────

/**
 * Streaming-aware emotion marker parser.
 *
 * Buffers initial chunks until the marker is found or determined absent.
 * Supports both enhanced [E:...] and legacy [EMOTION:...] formats.
 * If the response doesn't start with `[`, passes through immediately.
 */
export function createEmotionParser() {
  let buffer = "";
  let resolved = false;
  let snapshot: EmotionSnapshot = defaultSnapshot();
  // Keep legacy emotion for backward compat
  let legacyEmotion: EmotionState = DEFAULT_EMOTION;

  function tryParse(): { matched: boolean; remainder: string } {
    // Try enhanced format first
    const enhanced = parseEnhancedMarker(buffer);
    if (enhanced) {
      snapshot = enhanced.snapshot;
      legacyEmotion = {
        emotion: (VALID_EMOTIONS.has(snapshot.displayLabel) ? snapshot.displayLabel : "calm") as EmotionName,
        intensity: snapshot.blend.intensity,
      };
      return { matched: true, remainder: enhanced.remainder };
    }

    // Fall back to legacy format
    const legacy = parseLegacyMarker(buffer);
    if (legacy) {
      snapshot = legacy.snapshot;
      legacyEmotion = {
        emotion: (VALID_EMOTIONS.has(legacy.snapshot.displayLabel) ? legacy.snapshot.displayLabel : "calm") as EmotionName,
        intensity: legacy.snapshot.blend.intensity,
      };
      return { matched: true, remainder: legacy.remainder };
    }

    return { matched: false, remainder: buffer };
  }

  return {
    /**
     * Feed a streaming chunk. Returns text to pass through to onChunk,
     * or null if still buffering.
     */
    feed(chunk: string): string | null {
      if (resolved) return chunk;

      buffer += chunk;

      // If buffer doesn't start with "[", marker is absent — flush everything
      if (!buffer.startsWith("[")) {
        resolved = true;
        const toFlush = buffer;
        buffer = "";
        return toFlush;
      }

      // Buffer starts with "[" and contains "]" — try to parse
      if (buffer.includes("]")) {
        const { matched, remainder } = tryParse();
        resolved = true;
        if (matched) {
          return remainder.length > 0 ? remainder : null;
        }
        // Has "]" but didn't match any pattern — flush raw buffer
        return buffer;
      }

      // Buffer starts with "[" but exceeds max without "]" — flush as-is
      if (buffer.length >= MAX_BUFFER_CHARS) {
        resolved = true;
        return buffer;
      }

      // Still accumulating — suppress output
      return null;
    },

    /**
     * Called after streaming ends. Returns the detected emotion and any
     * remaining buffered text that was not yet flushed.
     */
    finalize(): { emotion: EmotionState; snapshot: EmotionSnapshot; remainder: string | null } {
      if (!resolved) {
        const { matched, remainder } = tryParse();
        resolved = true;
        if (matched) {
          return { emotion: legacyEmotion, snapshot, remainder: remainder.length > 0 ? remainder : null };
        }
        return {
          emotion: DEFAULT_EMOTION,
          snapshot: defaultSnapshot(),
          remainder: buffer.length > 0 ? buffer : null,
        };
      }
      return { emotion: legacyEmotion, snapshot, remainder: null };
    },

    getEmotion(): EmotionState {
      return legacyEmotion;
    },

    getSnapshot(): EmotionSnapshot {
      return snapshot;
    },

    isResolved(): boolean {
      return resolved;
    },
  };
}

/**
 * Strip emotion marker from a complete string (for non-streaming paths).
 */
export function stripEmotionMarker(text: string): EmotionParserResult {
  // Try enhanced format first
  const enhanced = parseEnhancedMarker(text);
  if (enhanced) {
    const emotionName = VALID_EMOTIONS.has(enhanced.snapshot.displayLabel)
      ? enhanced.snapshot.displayLabel as EmotionName
      : "calm" as EmotionName;
    return {
      emotion: { emotion: emotionName, intensity: enhanced.snapshot.blend.intensity },
      snapshot: enhanced.snapshot,
      strippedText: enhanced.remainder,
    };
  }

  // Try legacy format
  const legacy = parseLegacyMarker(text);
  if (legacy) {
    const emotionName = VALID_EMOTIONS.has(legacy.snapshot.displayLabel)
      ? legacy.snapshot.displayLabel as EmotionName
      : "calm" as EmotionName;
    return {
      emotion: { emotion: emotionName, intensity: legacy.snapshot.blend.intensity },
      snapshot: legacy.snapshot,
      strippedText: legacy.remainder,
    };
  }

  return {
    emotion: DEFAULT_EMOTION,
    snapshot: defaultSnapshot(),
    strippedText: text,
  };
}
