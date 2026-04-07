import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { A2UISurface, A2UISurfaceListItem, A2UIComponentEntry } from "@chvor/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CHVOR_DATA_DIR ?? resolve(__dirname, "../../data");

let db: Database.Database | null = null;

interface SurfaceRow {
  id: string;
  title: string;
  root: string | null;
  components: string;
  bindings: string;
  rendering: number;
  created_at: string;
  updated_at: string;
}

function rowToSurface(row: SurfaceRow): A2UISurface {
  let components: Record<string, A2UIComponentEntry> = {};
  let bindings: Record<string, unknown> = {};
  try {
    components = JSON.parse(row.components) as Record<string, A2UIComponentEntry>;
  } catch {
    console.error(`[a2ui-db] corrupt components JSON for surface "${row.id}"`);
  }
  try {
    bindings = JSON.parse(row.bindings) as Record<string, unknown>;
  } catch {
    console.error(`[a2ui-db] corrupt bindings JSON for surface "${row.id}"`);
  }
  return {
    surfaceId: row.id,
    title: row.title,
    root: row.root,
    components,
    bindings,
    rendering: row.rendering === 1,
  };
}

function rowToListItem(row: SurfaceRow): A2UISurfaceListItem {
  return {
    id: row.id,
    title: row.title,
    rendering: row.rendering === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function initA2UIDb(): void {
  if (db) return;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(join(DATA_DIR, "a2ui.db"));
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS surfaces (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Untitled',
      root TEXT,
      components TEXT NOT NULL DEFAULT '{}',
      bindings TEXT NOT NULL DEFAULT '{}',
      rendering INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  console.log(`[a2ui-db] ready (${join(DATA_DIR, "a2ui.db")})`);
}

function getA2UIDb(): Database.Database {
  if (!db) throw new Error("A2UI database not initialized — call initA2UIDb() first");
  return db;
}

export function listSurfaces(): A2UISurfaceListItem[] {
  const database = getA2UIDb();
  const rows = database
    .prepare("SELECT id, title, rendering, created_at, updated_at FROM surfaces ORDER BY updated_at DESC")
    .all() as Pick<SurfaceRow, "id" | "title" | "rendering" | "created_at" | "updated_at">[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    rendering: row.rendering === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getSurface(id: string): A2UISurface | null {
  const database = getA2UIDb();
  const row = database
    .prepare("SELECT * FROM surfaces WHERE id = ?")
    .get(id) as SurfaceRow | undefined;
  return row ? rowToSurface(row) : null;
}

export function surfaceExists(id: string): boolean {
  const database = getA2UIDb();
  const row = database
    .prepare("SELECT 1 FROM surfaces WHERE id = ? LIMIT 1")
    .get(id);
  return row !== undefined;
}

/**
 * Upsert a surface. Returns true if a new row was inserted, false if updated.
 */
export function upsertSurface(surface: {
  surfaceId: string;
  title?: string;
  root?: string | null;
  components?: Record<string, A2UIComponentEntry>;
  rendering?: boolean;
}): boolean {
  const database = getA2UIDb();
  const now = new Date().toISOString();
  let inserted = false;

  const upsert = database.transaction(() => {
    const existing = database
      .prepare("SELECT * FROM surfaces WHERE id = ?")
      .get(surface.surfaceId) as SurfaceRow | undefined;

    if (existing) {
      let existingComponents: Record<string, A2UIComponentEntry> = {};
      try {
        existingComponents = JSON.parse(existing.components) as Record<string, A2UIComponentEntry>;
      } catch {
        console.error(`[a2ui-db] corrupt components JSON for "${surface.surfaceId}", resetting`);
      }

      const mergedComponents = surface.components
        ? { ...existingComponents, ...surface.components }
        : existingComponents;

      database.prepare(`
        UPDATE surfaces SET
          title = ?,
          root = ?,
          components = ?,
          rendering = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        surface.title ?? existing.title,
        surface.root !== undefined ? surface.root : existing.root,
        JSON.stringify(mergedComponents),
        surface.rendering !== undefined ? (surface.rendering ? 1 : 0) : existing.rendering,
        now,
        surface.surfaceId,
      );
    } else {
      inserted = true;
      database.prepare(`
        INSERT INTO surfaces (id, title, root, components, bindings, rendering, created_at, updated_at)
        VALUES (?, ?, ?, ?, '{}', ?, ?, ?)
      `).run(
        surface.surfaceId,
        surface.title ?? surface.surfaceId,
        surface.root ?? null,
        JSON.stringify(surface.components ?? {}),
        surface.rendering ? 1 : 0,
        now,
        now,
      );
    }
  });

  upsert();
  return inserted;
}

export function updateBindings(id: string, bindings: Record<string, unknown>): void {
  const database = getA2UIDb();
  const now = new Date().toISOString();

  const update = database.transaction(() => {
    const existing = database
      .prepare("SELECT bindings FROM surfaces WHERE id = ?")
      .get(id) as { bindings: string } | undefined;

    if (!existing) {
      console.error(`[a2ui-db] updateBindings: surface "${id}" not found — bindings dropped`);
      return;
    }

    let existingBindings: Record<string, unknown> = {};
    try {
      existingBindings = JSON.parse(existing.bindings) as Record<string, unknown>;
    } catch {
      console.error(`[a2ui-db] corrupt bindings JSON for "${id}", resetting`);
    }

    const merged = { ...existingBindings, ...bindings };
    database.prepare("UPDATE surfaces SET bindings = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(merged), now, id);
  });

  update();
}

export function updateSurfaceTitle(id: string, title: string): void {
  const database = getA2UIDb();
  const now = new Date().toISOString();
  database.prepare("UPDATE surfaces SET title = ?, updated_at = ? WHERE id = ?")
    .run(title, now, id);
}

export function deleteSurface(id: string): boolean {
  const database = getA2UIDb();
  const result = database.prepare("DELETE FROM surfaces WHERE id = ?").run(id);
  return result.changes > 0;
}

export function deleteAllSurfaces(): void {
  const database = getA2UIDb();
  database.prepare("DELETE FROM surfaces").run();
}
