/**
 * Memory Decay Engine — Ebbinghaus-inspired exponential decay with spaced reinforcement.
 *
 * - Every memory has a `strength` (0–1) that decays exponentially over time
 * - Each access boosts strength and slows the decay rate (spaced repetition)
 * - Emotionally significant memories start stronger (when emotions are enabled)
 * - Memories below a threshold become retrieval-invisible but remain in DB
 */

import { applyDecayPass } from "../db/memory-store.ts";

const DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let decayTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Calculate initial memory strength based on emotional context.
 * When emotions are disabled, returns a fixed neutral default.
 */
export function calculateInitialStrength(
  emotionsEnabled: boolean,
  emotionalIntensity: number | null,
): number {
  if (!emotionsEnabled || emotionalIntensity == null) {
    return 0.8; // neutral default
  }
  // Higher emotional intensity → stronger initial memory (flashbulb effect)
  // Range: 0.6 (no emotion) to 1.0 (max emotion)
  return 0.6 + emotionalIntensity * 0.4;
}

/**
 * Run a decay pass on all memories. Called periodically.
 */
function runDecay(): void {
  try {
    const { decayed, invisible } = applyDecayPass();
    if (decayed > 0) {
      console.log(`[memory-decay] decayed ${decayed} memories (${invisible} now invisible)`);
    }
  } catch (err) {
    console.error("[memory-decay] decay pass failed:", err);
  }
}

/** Start periodic memory decay. Also runs immediately. */
export function startMemoryDecay(): void {
  if (decayTimer) return;
  runDecay();
  decayTimer = setInterval(runDecay, DECAY_INTERVAL_MS);
  decayTimer.unref();
}

/** Stop periodic memory decay. */
export function stopMemoryDecay(): void {
  if (decayTimer) {
    clearInterval(decayTimer);
    decayTimer = null;
  }
}
