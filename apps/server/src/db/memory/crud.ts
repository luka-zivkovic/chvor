import { randomUUID } from "node:crypto";
import type { Memory, MemoryCategory, MemoryProvenance, MemorySpace } from "@chvor/shared";
import { getDb } from "../database.ts";
import { deleteAllMemoryVectors, deleteMemoryVector, embedAndStoreVector } from "./vectors.ts";
import { rowToMemory, type MemoryNodeRow } from "./types.ts";

// ─── CRUD operations ────────────────────────────────────────

export function listMemories(limit: number = 1000): Memory[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM memory_nodes ORDER BY created_at DESC LIMIT ?")
    .all(limit) as MemoryNodeRow[];
  return rows.map(rowToMemory);
}

/** Find a memory by ID prefix (for recall_detail tool). Uses index scan, not full table scan. */
export function findMemoryByIdPrefix(prefix: string): Memory | null {
  if (!prefix || prefix.length < 4) return null;
  // Escape LIKE wildcards (%, _) with backslash to prevent wildcard injection
  const escaped = prefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  if (escaped.length < 4) return null;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM memory_nodes WHERE id LIKE ? ESCAPE '\\' LIMIT 1")
    .get(`${escaped}%`) as MemoryNodeRow | undefined;
  return row ? rowToMemory(row) : null;
}

export function getMemory(id: string): Memory | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM memory_nodes WHERE id = ?")
    .get(id) as MemoryNodeRow | undefined;
  return row ? rowToMemory(row) : null;
}

export interface CreateMemoryOptions {
  abstract: string;
  overview?: string | null;
  detail?: string | null;
  category?: MemoryCategory;
  space?: MemorySpace;
  confidence?: number;
  provenance?: MemoryProvenance;
  emotionalValence?: number | null;
  emotionalIntensity?: number | null;
  initialStrength?: number;
  sourceChannel: string;
  sourceSessionId: string;
  sourceMessageId?: string | null;
  sourceResourceId?: string | null;
}

export function createMemory(
  contentOrOpts: string | CreateMemoryOptions,
  sourceChannel?: string,
  sourceSessionId?: string,
): Memory {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  // Support both legacy (content, channel, session) and new (options object) signatures
  let opts: CreateMemoryOptions;
  if (typeof contentOrOpts === "string") {
    opts = {
      abstract: contentOrOpts,
      sourceChannel: sourceChannel!,
      sourceSessionId: sourceSessionId!,
    };
  } else {
    opts = contentOrOpts;
  }

  // Reject empty or whitespace-only abstracts
  if (!opts.abstract?.trim()) {
    throw new Error("Memory abstract cannot be empty");
  }

  db.prepare(`
    INSERT INTO memory_nodes
      (id, abstract, overview, detail, category, space, strength, decay_rate,
       confidence, provenance, emotional_valence, emotional_intensity,
       source_channel, source_session_id, source_message_id, source_resource_id,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0.1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.abstract,
    opts.overview ?? null,
    opts.detail ?? null,
    opts.category ?? "profile",
    opts.space ?? "user",
    opts.initialStrength ?? 0.8,
    opts.confidence ?? 0.8,
    opts.provenance ?? "extracted",
    opts.emotionalValence ?? null,
    opts.emotionalIntensity ?? null,
    opts.sourceChannel,
    opts.sourceSessionId,
    opts.sourceMessageId ?? null,
    opts.sourceResourceId ?? null,
    now,
    now,
  );

  // Fire-and-forget embedding (embed the abstract for vector search)
  embedAndStoreVector(id, opts.abstract).catch((err) => {
    console.warn("[memory] embedding failed for", id, (err as Error).message);
  });

  return getMemory(id)!;
}

export function updateMemory(id: string, content: string): Memory | null {
  const existing = getMemory(id);
  if (!existing) return null;
  const db = getDb();
  const now = new Date().toISOString();
  // Null out overview and detail so stale L1/L2 content doesn't persist after abstract edit
  db.prepare(
    "UPDATE memory_nodes SET abstract = ?, overview = NULL, detail = NULL, updated_at = ? WHERE id = ?"
  ).run(content, now, id);
  // Fire-and-forget re-embed
  embedAndStoreVector(id, content).catch((err) => {
    console.warn("[memory] re-embedding failed for", id, (err as Error).message);
  });
  return getMemory(id)!;
}

/**
 * Update abstract only, preserving existing overview/detail.
 * Used by knowledge ingestion MERGE to avoid destroying context.
 */
export function mergeMemoryAbstract(id: string, newAbstract: string, newOverview?: string | null): Memory | null {
  const existing = getMemory(id);
  if (!existing) return null;
  const db = getDb();
  const now = new Date().toISOString();
  // Keep existing overview if the new one isn't provided, or if the existing one is already set
  const overview = existing.overview ?? newOverview ?? null;
  db.prepare(
    "UPDATE memory_nodes SET abstract = ?, overview = ?, updated_at = ? WHERE id = ?"
  ).run(newAbstract, overview, now, id);
  // Fire-and-forget re-embed
  embedAndStoreVector(id, newAbstract).catch((err) => {
    console.warn("[memory] re-embedding failed for", id, (err as Error).message);
  });
  return getMemory(id)!;
}

export function updateMemoryOverview(id: string, overview: string): void {
  const db = getDb();
  db.prepare("UPDATE memory_nodes SET overview = ? WHERE id = ? AND overview IS NULL").run(overview, id);
}

export function deleteMemory(id: string): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    deleteMemoryVector(id);
    db.prepare("DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?").run(id, id);
    db.prepare("DELETE FROM memory_access_log WHERE memory_id = ?").run(id);
    const result = db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(id);
    return result.changes > 0;
  });
  return tx();
}

export function deleteAllMemories(): void {
  const db = getDb();
  const tx = db.transaction(() => {
    deleteAllMemoryVectors();
    db.prepare("DELETE FROM memory_access_log").run();
    db.prepare("DELETE FROM memory_edges").run();
    db.prepare("DELETE FROM memory_nodes").run();
  });
  tx();
}

// ─── Memory count (for health manifest) ─────────────────────

export function getMemoryCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get() as { count: number };
  return row.count;
}
