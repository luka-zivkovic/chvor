import { getDb, isVecAvailable } from "../database.ts";
import { embed, getEmbeddingDim, isEmbedderAvailable } from "../../lib/embedder.ts";

// ─── Vector operations ──────────────────────────────────────

export async function embedAndStoreVector(id: string, content: string): Promise<void> {
  if (!isEmbedderAvailable() || !isVecAvailable()) return;
  try {
    const db = getDb();
    const vector = await embed(content);
    // Dimension safety: reject vectors that don't match the active table dimension
    const expectedDim = getEmbeddingDim();
    if (vector.length !== expectedDim) {
      console.warn(`[memory] dimension mismatch for ${id}: got ${vector.length}, expected ${expectedDim} — skipping embed`);
      return;
    }
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const tx = db.transaction(() => {
      db.prepare("UPDATE memory_nodes SET embedding = ? WHERE id = ?").run(buf, id);
      db.prepare("INSERT OR REPLACE INTO memory_node_vec (id, embedding) VALUES (?, ?)").run(id, buf);
    });
    tx();
  } catch (err) {
    console.warn(`[memory] failed to embed memory ${id}:`, (err as Error).message);
  }
}

export function deleteMemoryVector(id: string): void {
  if (!isVecAvailable()) return;
  try {
    const db = getDb();
    db.prepare("DELETE FROM memory_node_vec WHERE id = ?").run(id);
  } catch { /* vec table may not exist */ }
}

export function deleteAllMemoryVectors(): void {
  if (!isVecAvailable()) return;
  try {
    const db = getDb();
    db.prepare("DELETE FROM memory_node_vec").run();
  } catch { /* vec table may not exist */ }
}

/** Clear all stored embeddings (used when embedding provider/dimension changes). */
export function clearAllEmbeddings(): void {
  const db = getDb();
  db.prepare("UPDATE memory_nodes SET embedding = NULL").run();
  deleteAllMemoryVectors();
}

export function getUnembeddedMemoryIds(): { id: string; content: string }[] {
  const db = getDb();
  return db
    .prepare("SELECT id, abstract AS content FROM memory_nodes WHERE embedding IS NULL")
    .all() as { id: string; content: string }[];
}
