import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "./database.ts";
import { getMediaDir, mimeToExt } from "../lib/media-store.ts";
import type {
  KnowledgeResource,
  KnowledgeResourceType,
  KnowledgeStatus,
} from "@chvor/shared";
import type { Memory } from "@chvor/shared";
import { rowToMemory } from "./memory-store.ts";
import type { MemoryNodeRow } from "./memory-store.ts";

// ─── Row mapping ──────────────────────────────────────────

interface KnowledgeResourceRow {
  id: string;
  type: string;
  title: string;
  source_url: string | null;
  media_id: string | null;
  mime_type: string | null;
  file_size: number | null;
  content_text: string | null;
  status: string;
  error: string | null;
  memory_count: number;
  created_at: string;
  updated_at: string;
}

function rowToResource(row: KnowledgeResourceRow): KnowledgeResource {
  return {
    id: row.id,
    type: row.type as KnowledgeResourceType,
    title: row.title,
    sourceUrl: row.source_url,
    mediaId: row.media_id,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    contentText: null, // Raw text omitted from API responses — may contain sensitive data
    status: row.status as KnowledgeStatus,
    error: row.error,
    memoryCount: row.memory_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── CRUD ─────────────────────────────────────────────────

export interface CreateResourceOptions {
  type: KnowledgeResourceType;
  title: string;
  sourceUrl?: string | null;
  mediaId?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}

export function createResource(opts: CreateResourceOptions): KnowledgeResource {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO knowledge_resources
      (id, type, title, source_url, media_id, mime_type, file_size, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    id,
    opts.type,
    opts.title,
    opts.sourceUrl ?? null,
    opts.mediaId ?? null,
    opts.mimeType ?? null,
    opts.fileSize ?? null,
    now,
    now,
  );

  return getResource(id)!;
}

export function getResource(id: string): KnowledgeResource | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM knowledge_resources WHERE id = ?")
    .get(id) as KnowledgeResourceRow | undefined;
  return row ? rowToResource(row) : null;
}

const LIST_COLUMNS = "id, type, title, source_url, media_id, mime_type, file_size, status, error, memory_count, created_at, updated_at";

export function listResources(): KnowledgeResource[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT ${LIST_COLUMNS} FROM knowledge_resources ORDER BY created_at DESC`)
    .all() as KnowledgeResourceRow[];
  return rows.map(rowToResource);
}

export function listStuckResources(): KnowledgeResource[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT ${LIST_COLUMNS} FROM knowledge_resources WHERE status IN ('pending', 'processing') ORDER BY created_at ASC`)
    .all() as KnowledgeResourceRow[];
  return rows.map(rowToResource);
}

export function updateResourceStatus(
  id: string,
  status: KnowledgeStatus,
  error?: string | null,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE knowledge_resources SET status = ?, error = ?, updated_at = ? WHERE id = ?",
  ).run(status, error ?? null, now, id);
}

export function updateResourceContentText(id: string, contentText: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE knowledge_resources SET content_text = ?, updated_at = ? WHERE id = ?",
  ).run(contentText, now, id);
}

export function setMemoryCount(id: string, count: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE knowledge_resources SET memory_count = ?, updated_at = ? WHERE id = ?",
  ).run(count, now, id);
}

export function deleteResource(id: string): boolean {
  const db = getDb();

  // Look up resource before deleting so we can clean up media file
  const resource = getResource(id);

  // Atomically nullify linked memories and delete the resource row
  const result = db.transaction(() => {
    db.prepare(
      "UPDATE memory_nodes SET source_resource_id = NULL WHERE source_resource_id = ?",
    ).run(id);
    return db
      .prepare("DELETE FROM knowledge_resources WHERE id = ?")
      .run(id);
  })();

  // Clean up media file from disk (outside transaction — best-effort)
  if (result.changes > 0 && resource?.mediaId && resource.mimeType) {
    try {
      const ext = mimeToExt(resource.mimeType);
      const filePath = join(getMediaDir(), `${resource.mediaId}.${ext}`);
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch (err) {
      console.warn(`[knowledge] failed to clean up media file for ${id}:`, err);
    }
  }

  return result.changes > 0;
}

export function deleteMemoriesForResource(id: string): number {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM memory_nodes WHERE source_resource_id = ?")
    .run(id);
  return result.changes;
}

/**
 * Atomically check status, set to pending, and delete linked memories.
 * Returns removed count, or null if resource is currently processing.
 */
export function prepareReprocess(id: string): { removed: number } | null {
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .prepare("SELECT status FROM knowledge_resources WHERE id = ?")
      .get(id) as { status: string } | undefined;
    if (!row) return null;
    if (row.status === "processing") return null;
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE knowledge_resources SET status = 'pending', error = NULL, updated_at = ? WHERE id = ?",
    ).run(now, id);
    const result = db
      .prepare("DELETE FROM memory_nodes WHERE source_resource_id = ?")
      .run(id);
    db.prepare(
      "UPDATE knowledge_resources SET memory_count = 0, updated_at = ? WHERE id = ?",
    ).run(now, id);
    return { removed: result.changes };
  })();
}

export function getMemoriesForResource(resourceId: string): Memory[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM memory_nodes WHERE source_resource_id = ? ORDER BY created_at DESC")
    .all(resourceId) as MemoryNodeRow[];
  return rows.map(rowToMemory);
}
