import type { EmotionSnapshot } from "@chvor/shared";
import { vadToColor } from "@chvor/shared";

/** Get the display color for an emotion snapshot as CSS string */
export function getEmotionDisplayColor(snapshot: EmotionSnapshot | null): string {
  if (!snapshot) return "oklch(0.62 0.08 250)"; // default calm blue

  // Use the pre-computed color from the snapshot if available
  if (snapshot.color) return snapshot.color;

  // Fallback: derive from VAD
  return vadToColor(snapshot.vad);
}

/** Re-export for convenience */
export { vadToColor } from "@chvor/shared";

/** Get animation duration based on arousal (calm=4s, excited=1.5s) */
export function getBreatheDuration(arousal: number): number {
  return Math.max(1.5, 4 - ((arousal + 1) / 2) * 2.5);
}

/** Get glow spread based on dominance (high=tight, low=soft) */
export function getGlowSpread(dominance: number): number {
  // Returns blur radius in pixels: 8px (dominant) to 24px (yielding)
  return 24 - ((dominance + 1) / 2) * 16;
}
