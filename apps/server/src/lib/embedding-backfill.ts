import { isEmbedderAvailable } from "./embedder.ts";
import { isVecAvailable } from "../db/database.ts";
import { getUnembeddedMemoryIds, embedAndStoreVector } from "../db/memory-store.ts";
// Note: getUnembeddedMemoryIds and embedAndStoreVector now operate on
// the memory_nodes / memory_node_vec tables (migration v11).

const BATCH_SIZE = 10;

export async function backfillEmbeddings(): Promise<void> {
  if (!isEmbedderAvailable() || !isVecAvailable()) {
    console.log("[embedder] skipping backfill — embedder or sqlite-vec unavailable");
    return;
  }

  const unembedded = getUnembeddedMemoryIds();
  if (unembedded.length === 0) return;

  console.log(`[embedder] backfilling ${unembedded.length} memories...`);
  const start = Date.now();
  let processed = 0;

  for (let i = 0; i < unembedded.length; i += BATCH_SIZE) {
    const batch = unembedded.slice(i, i + BATCH_SIZE);
    for (const { id, content } of batch) {
      try {
        await embedAndStoreVector(id, content);
        processed++;
      } catch (err) {
        console.warn(`[embedder] backfill failed for ${id}:`, (err as Error).message);
      }
    }
    // Yield to event loop between batches
    if (i + BATCH_SIZE < unembedded.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  console.log(`[embedder] backfill complete (${processed}/${unembedded.length} in ${((Date.now() - start) / 1000).toFixed(1)}s)`);
}
