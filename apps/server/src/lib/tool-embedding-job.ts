import { startPeriodicJob, stopPeriodicJob } from "./job-runner.ts";
import { syncToolEmbeddings } from "./tool-embeddings.ts";

/**
 * Background sync job for the Cognitive Tool Graph's semantic embeddings
 * (Phase F). Hash-based dedup inside `syncToolEmbeddings` makes the steady
 * state cheap (a few SELECTs); only newly-installed or edited tools incur
 * a real embed call.
 */

// Hourly cadence — fast enough that a freshly installed tool gets a
// semantic signal within an hour, slow enough that we don't waste cycles
// when nothing changed. The hash check is the real guard.
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

async function runSync(): Promise<void> {
  await syncToolEmbeddings(false);
}

export function startToolEmbeddingSync(): void {
  startPeriodicJob({ id: "tool-embedding-sync", intervalMs: SYNC_INTERVAL_MS, run: runSync });
}

export function stopToolEmbeddingSync(): void {
  stopPeriodicJob("tool-embedding-sync");
}

/**
 * Best-effort startup sync — kicked off after the embedder boots so the
 * very first turn has semantic scores even on a fresh install. Returns a
 * promise the caller can ignore (no need to await).
 */
export async function bootstrapToolEmbeddings(): Promise<void> {
  try {
    await syncToolEmbeddings(false);
  } catch (err) {
    console.warn(
      "[tool-embedding-sync] startup sync failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}
