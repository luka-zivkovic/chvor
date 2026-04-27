import { startPeriodicJob, stopPeriodicJob } from "./job-runner.ts";
import { decayStrengths } from "./tool-graph.ts";

/**
 * Periodic decay loop for the Cognitive Tool Graph (Phase G).
 *
 * Mirrors `memory-decay.ts`: a job-runner-backed timer that gently decays
 * every tool node's strength toward the floor. Frequent enough that idle
 * tools fade in days, slow enough that a tool you used yesterday still
 * looks strong today.
 */

// 12 hours — half-cadence of memory-decay (6h) so we don't double-spike DB load.
const DECAY_INTERVAL_MS = 12 * 60 * 60 * 1000;

function runToolGraphDecay(): void {
  try {
    const { rowsAffected } = decayStrengths();
    if (rowsAffected > 0) {
      console.log(`[tool-graph-decay] decayed ${rowsAffected} tool node(s)`);
    }
  } catch (err) {
    console.warn(
      "[tool-graph-decay] decay pass failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

export function startToolGraphDecay(): void {
  startPeriodicJob({ id: "tool-graph-decay", intervalMs: DECAY_INTERVAL_MS, run: runToolGraphDecay });
}

export function stopToolGraphDecay(): void {
  stopPeriodicJob("tool-graph-decay");
}
