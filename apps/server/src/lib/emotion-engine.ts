import type {
  VADState,
  PrimaryEmotion,
  SecondaryEmotion,
  EmotionBlend,
  EmotionSnapshot,
  EmotionGravity,
  EmotionSignal,
  EmotionSignalSource,
} from "@chvor/shared";
import {
  PRIMARY_EMOTION_REGIONS,
  SECONDARY_EMOTION_DEFS,
  SIGNAL_WEIGHTS,
  DEFAULT_VAD,
  PERSONALITY_GRAVITIES,
  vadToColor,
  vadDistance,
} from "@chvor/shared";

// Re-export vadDistance for existing consumers
export { vadDistance };

// ── VAD Math ──────────────────────────────────────────────────────────────

export function vadLerp(a: VADState, b: VADState, t: number): VADState {
  return {
    valence: a.valence + (b.valence - a.valence) * t,
    arousal: a.arousal + (b.arousal - a.arousal) * t,
    dominance: a.dominance + (b.dominance - a.dominance) * t,
  };
}

export function vadAdd(a: VADState, b: VADState): VADState {
  return {
    valence: a.valence + b.valence,
    arousal: a.arousal + b.arousal,
    dominance: a.dominance + b.dominance,
  };
}

export function vadScale(v: VADState, s: number): VADState {
  return {
    valence: v.valence * s,
    arousal: v.arousal * s,
    dominance: v.dominance * s,
  };
}

export function vadClamp(v: VADState): VADState {
  return {
    valence: Math.max(-1, Math.min(1, v.valence)),
    arousal: Math.max(-1, Math.min(1, v.arousal)),
    dominance: Math.max(-1, Math.min(1, v.dominance)),
  };
}

// ── Emotion Resolution ────────────────────────────────────────────────────

/** Find the closest primary emotion to a VAD point */
export function findClosestPrimary(vad: VADState): { emotion: PrimaryEmotion; distance: number } {
  let best = PRIMARY_EMOTION_REGIONS[0];
  let bestDist = vadDistance(vad, best.center);

  for (let i = 1; i < PRIMARY_EMOTION_REGIONS.length; i++) {
    const dist = vadDistance(vad, PRIMARY_EMOTION_REGIONS[i].center);
    if (dist < bestDist) {
      best = PRIMARY_EMOTION_REGIONS[i];
      bestDist = dist;
    }
  }

  return { emotion: best.id, distance: bestDist };
}

/** Find activated secondary emotion (if the VAD point is near the midpoint of two parent primaries) */
export function findSecondaryEmotion(
  vad: VADState,
  primaryEmotion: PrimaryEmotion
): { emotion: SecondaryEmotion; weight: number } | null {
  const regionMap = new Map(PRIMARY_EMOTION_REGIONS.map((r) => [r.id, r]));

  let bestSecondary: SecondaryEmotion | null = null;
  let bestWeight = 0;
  const threshold = 0.6;

  for (const def of SECONDARY_EMOTION_DEFS) {
    // Only consider secondaries that share the primary parent
    if (!def.parents.includes(primaryEmotion)) continue;

    const parentA = regionMap.get(def.parents[0]);
    const parentB = regionMap.get(def.parents[1]);
    if (!parentA || !parentB) continue;

    // Secondary center = midpoint of parents
    const center: VADState = {
      valence: (parentA.center.valence + parentB.center.valence) / 2,
      arousal: (parentA.center.arousal + parentB.center.arousal) / 2,
      dominance: (parentA.center.dominance + parentB.center.dominance) / 2,
    };

    const dist = vadDistance(vad, center);
    if (dist < threshold) {
      const weight = 1 - dist / threshold;
      if (weight > bestWeight) {
        bestSecondary = def.id;
        bestWeight = weight;
      }
    }
  }

  if (bestSecondary && bestWeight > 0.15) {
    return { emotion: bestSecondary, weight: Math.min(1, bestWeight) };
  }
  return null;
}

/** Resolve a full emotion blend from a VAD point */
export function resolveEmotionBlend(vad: VADState): EmotionBlend {
  const { emotion: primaryEmotion, distance } = findClosestPrimary(vad);
  const secondary = findSecondaryEmotion(vad, primaryEmotion);

  // Intensity based on distance from origin — further from neutral = more intense
  const distFromOrigin = vadDistance(vad, DEFAULT_VAD);
  const intensity = Math.min(1, distFromOrigin / 1.2);

  // Primary weight: inverse of distance to closest primary center (clamped)
  const primaryWeight = Math.min(1, Math.max(0.3, 1 - distance / 1.0));

  return {
    primary: { emotion: primaryEmotion, weight: primaryWeight },
    secondary,
    intensity,
  };
}

// ── Signal Generators ─────────────────────────────────────────────────────

/** Generate emotion signal from LLM self-report (parsed marker).
 *  `reportedVAD` is the absolute position the LLM reported;
 *  `currentVAD` is the engine's current state. The delta is the
 *  direction toward the reported position, not the absolute value. */
export function llmSelfReportSignal(reportedVAD: VADState, currentVAD: VADState): EmotionSignal {
  return {
    source: "llm_self_report",
    delta: {
      valence: reportedVAD.valence - currentVAD.valence,
      arousal: reportedVAD.arousal - currentVAD.arousal,
      dominance: reportedVAD.dominance - currentVAD.dominance,
    },
    weight: SIGNAL_WEIGHTS.llm_self_report,
  };
}

/** Generate signal from tool execution outcome */
export function toolOutcomeSignal(success: boolean, severity: "low" | "medium" | "high" = "medium"): EmotionSignal {
  const severityMultiplier = severity === "low" ? 0.3 : severity === "high" ? 1.0 : 0.6;

  if (success) {
    return {
      source: "tool_outcome",
      delta: { valence: 0.3 * severityMultiplier, arousal: -0.1, dominance: 0.2 },
      weight: SIGNAL_WEIGHTS.tool_outcome,
    };
  }
  return {
    source: "tool_outcome",
    delta: { valence: -0.4 * severityMultiplier, arousal: 0.3 * severityMultiplier, dominance: -0.1 },
    weight: SIGNAL_WEIGHTS.tool_outcome,
  };
}

/** Generate signal from conversation pace */
export function conversationPaceSignal(timeSinceLastMs: number, avgGapMs: number): EmotionSignal {
  const ratio = avgGapMs > 0 ? timeSinceLastMs / avgGapMs : 1;

  if (ratio < 0.5) {
    // Rapid exchange → excitement/energy
    return {
      source: "conversation_pace",
      delta: { valence: 0.1, arousal: 0.3, dominance: 0.0 },
      weight: SIGNAL_WEIGHTS.conversation_pace,
    };
  } else if (ratio > 3) {
    // Long silence → calm, slight concern
    return {
      source: "conversation_pace",
      delta: { valence: -0.1, arousal: -0.3, dominance: -0.1 },
      weight: SIGNAL_WEIGHTS.conversation_pace,
    };
  }
  // Normal pace → neutral
  return {
    source: "conversation_pace",
    delta: { valence: 0, arousal: 0, dominance: 0 },
    weight: SIGNAL_WEIGHTS.conversation_pace,
  };
}

// Keyword sets for simple sentiment detection
const POSITIVE_WORDS = new Set([
  "thanks", "thank", "great", "awesome", "perfect", "love", "amazing", "excellent",
  "wonderful", "brilliant", "nice", "good", "happy", "excited", "cool", "fantastic",
  "appreciate", "helpful", "beautiful", "impressive",
]);

const NEGATIVE_WORDS = new Set([
  "broken", "error", "bug", "wrong", "fail", "crash", "hate", "terrible",
  "awful", "frustrated", "annoyed", "angry", "sad", "stuck", "confused",
  "impossible", "horrible", "worst", "problem", "issue",
]);

const URGENT_WORDS = new Set([
  "urgent", "asap", "emergency", "critical", "immediately", "hurry",
  "deadline", "blocking", "production", "down", "outage",
]);

/** Generate signal from user message sentiment (keyword-based heuristic) */
export function userSentimentSignal(text: string): EmotionSignal {
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  let positiveCount = 0;
  let negativeCount = 0;
  let urgentCount = 0;

  for (const word of words) {
    if (POSITIVE_WORDS.has(word)) positiveCount++;
    if (NEGATIVE_WORDS.has(word)) negativeCount++;
    if (URGENT_WORDS.has(word)) urgentCount++;
  }

  const total = Math.max(1, words.length);
  const posRatio = positiveCount / total;
  const negRatio = negativeCount / total;
  const urgRatio = urgentCount / total;

  return {
    source: "user_sentiment",
    delta: {
      valence: (posRatio - negRatio) * 3,    // amplified
      arousal: (urgRatio + negRatio) * 2,
      dominance: posRatio > negRatio ? 0.1 : -0.2,
    },
    weight: SIGNAL_WEIGHTS.user_sentiment,
  };
}

// ── Emotion Engine (stateful per-session) ─────────────────────────────────

export class EmotionEngine {
  private currentVAD: VADState;
  private previousVAD: VADState | null = null;
  private gravity: EmotionGravity;
  private turnCount = 0;
  private momentumFactor: number = 0.3;
  private lastMessageTimestamps: number[] = [];

  constructor(gravity: EmotionGravity, initialVAD?: VADState) {
    this.gravity = gravity;
    this.currentVAD = initialVAD ?? { ...gravity.home };
  }

  /** Get the current VAD state */
  getCurrentVAD(): VADState {
    return { ...this.currentVAD };
  }

  /** Set momentum factor (used by advanced engine for per-emotion inertia) */
  setMomentumFactor(factor: number): void {
    this.momentumFactor = factor;
  }

  /** Get the current turn count */
  getTurnCount(): number {
    return this.turnCount;
  }

  /** Get the personality gravity config */
  getGravity(): EmotionGravity {
    return this.gravity;
  }

  /** Temporarily override emotional range (used by advanced engine for energy modulation) */
  setEmotionalRange(range: number): void {
    this.gravity = { ...this.gravity, emotionalRange: range };
  }

  /** Record a message timestamp for pace calculation */
  recordMessageTimestamp(): void {
    this.lastMessageTimestamps.push(Date.now());
    if (this.lastMessageTimestamps.length > 20) {
      this.lastMessageTimestamps.shift();
    }
  }

  /** Get average gap between messages in ms */
  getAverageGap(): number {
    const ts = this.lastMessageTimestamps;
    if (ts.length < 2) return 30000; // default 30s
    let sum = 0;
    for (let i = 1; i < ts.length; i++) {
      sum += ts[i] - ts[i - 1];
    }
    return sum / (ts.length - 1);
  }

  /** Get time since last message in ms */
  getTimeSinceLast(): number {
    if (this.lastMessageTimestamps.length === 0) return 30000;
    return Date.now() - this.lastMessageTimestamps[this.lastMessageTimestamps.length - 1];
  }

  /** Apply decay: pull current VAD toward home position */
  private applyDecay(): void {
    const range = this.gravity.emotionalRange || 1;
    const dist = vadDistance(this.currentVAD, this.gravity.home);
    // Strong emotions decay slower (resist pull-back)
    const effectiveDecay =
      this.gravity.gravityStrength * (1 - 0.5 * Math.min(1, dist / range));

    this.currentVAD = vadLerp(this.currentVAD, this.gravity.home, effectiveDecay);
  }

  /** Apply momentum: blend proposed change with previous trajectory */
  private applyMomentum(proposed: VADState): VADState {
    if (!this.previousVAD) return proposed;

    // Previous direction
    const prevDelta: VADState = {
      valence: this.currentVAD.valence - this.previousVAD.valence,
      arousal: this.currentVAD.arousal - this.previousVAD.arousal,
      dominance: this.currentVAD.dominance - this.previousVAD.dominance,
    };

    return vadLerp(proposed, vadAdd(proposed, vadScale(prevDelta, 0.3)), this.momentumFactor);
  }

  /** Soft sigmoid clamp: gradually resist moving beyond emotional range */
  private clampToRange(vad: VADState): VADState {
    const range = this.gravity.emotionalRange || 1;
    const dist = vadDistance(vad, this.gravity.home);
    if (dist <= range || dist === 0) return vad;

    // Soft clamp: sigmoid falloff beyond range
    const overshoot = dist - range;
    const dampening = 1 / (1 + overshoot * 2);
    return vadLerp(this.gravity.home, vad, (range / dist) * dampening + (1 - dampening));
  }

  /** Aggregate multiple signals into a combined VAD delta */
  private aggregateSignals(signals: EmotionSignal[]): VADState {
    let totalWeight = 0;
    const combined: VADState = { valence: 0, arousal: 0, dominance: 0 };

    for (const signal of signals) {
      const w = signal.weight;
      combined.valence += signal.delta.valence * w;
      combined.arousal += signal.delta.arousal * w;
      combined.dominance += signal.delta.dominance * w;
      totalWeight += w;
    }

    if (totalWeight === 0) return { valence: 0, arousal: 0, dominance: 0 };

    return {
      valence: combined.valence / totalWeight,
      arousal: combined.arousal / totalWeight,
      dominance: combined.dominance / totalWeight,
    };
  }

  /** Apply the display label based on personality vocabulary */
  private resolveDisplayLabel(primaryEmotion: PrimaryEmotion): string {
    return this.gravity.vocabularyMap[primaryEmotion] || primaryEmotion;
  }

  /** Process a full turn: decay → collect signals → aggregate → resolve → snapshot */
  processTurn(signals: EmotionSignal[]): EmotionSnapshot {
    this.turnCount++;

    // 1. Decay toward home
    this.applyDecay();

    // 2. Aggregate signals
    const delta = this.aggregateSignals(signals);

    // 3. Propose new position
    let proposed = vadAdd(this.currentVAD, delta);

    // 4. Apply momentum
    proposed = this.applyMomentum(proposed);

    // 5. Clamp to range
    proposed = this.clampToRange(proposed);

    // 6. Clamp to valid VAD bounds
    proposed = vadClamp(proposed);

    // 7. Update state
    this.previousVAD = { ...this.currentVAD };
    this.currentVAD = proposed;

    // 8. Resolve blend
    const blend = resolveEmotionBlend(this.currentVAD);

    // 9. Build snapshot
    const displayLabel = this.resolveDisplayLabel(blend.primary.emotion);
    const color = vadToColor(this.currentVAD);

    return {
      vad: { ...this.currentVAD },
      blend,
      displayLabel,
      color,
      signals,
      timestamp: new Date().toISOString(),
    };
  }

  /** Restore engine state from a persisted snapshot */
  restoreFromSnapshot(snapshot: EmotionSnapshot): void {
    this.currentVAD = { ...snapshot.vad };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

/** Create an EmotionEngine for a personality preset */
export function createEmotionEngine(presetId?: string, initialVAD?: VADState): EmotionEngine {
  const gravity = (presetId && PERSONALITY_GRAVITIES[presetId]) || PERSONALITY_GRAVITIES.companion;
  return new EmotionEngine(gravity, initialVAD);
}
