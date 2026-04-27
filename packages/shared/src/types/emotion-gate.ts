/**
 * Phase H — emotion-modulated risk gate.
 *
 * Tools declare a `riskTag`; the orchestrator buckets the user's current
 * VAD state and, on hostile / frustrated, masks `destructive` tools from
 * the bag. The truly novel chvor bit: affect → action authority.
 */

export type RiskTag =
  | "safe" /** Read-only or chvor-internal mutations only. */
  | "moderate" /** Mutates chvor-local state (skills, schedules, ingested knowledge). */
  | "destructive"; /** Affects the user's machine, accounts, or external systems. */

export type EmotionBucket =
  | "collaborative" /** Pleasant + activated → agentic-friendly. */
  | "neutral" /** Default. */
  | "frustrated" /** Negative valence; bag tightens. */
  | "hostile"; /** Negative valence + high arousal; destructive tools masked. */

/**
 * Per-turn rationale for what the emotion gate did. Emitted only when the
 * gate actually changed the bag, plus once per session when the bucket
 * crosses a threshold.
 */
export interface EmotionGatedToolsEvent {
  /** Bucket the user's VAD landed in for this turn. */
  bucket: EmotionBucket;
  /** Snapshot of the VAD that produced the bucket. */
  vad: { valence: number; arousal: number; dominance: number };
  /** Tools the gate masked from the per-turn bag. */
  masked: Array<{ toolName: string; riskTag: RiskTag }>;
  /** Tools that would have been masked but bypassed via `criticality: always-available`. */
  bypassed: string[];
  /** Number of tools left in the bag after the gate. */
  toolCountAfter: number;
  /** Short, user-facing label for the canvas badge ("cooling-off"). */
  reason: string;
};
