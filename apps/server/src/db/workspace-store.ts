import type {
  Workspace,
  WorkspaceMode,
  WorkspaceNode,
  WorkspaceEdge,
  WorkspaceSettings,
} from "@chvor/shared";
import { getDb } from "./database.ts";

interface WorkspaceRow {
  id: string;
  name: string;
  mode: string;
  nodes: string;
  edges: string;
  viewport: string;
  settings: string;
  created_at: string;
  updated_at: string;
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode as WorkspaceMode,
    nodes: safeJsonParse<WorkspaceNode[]>(row.nodes, []),
    edges: safeJsonParse<WorkspaceEdge[]>(row.edges, []),
    viewport: safeJsonParse(row.viewport, { x: 0, y: 0, zoom: 1 }),
    settings: safeJsonParse<WorkspaceSettings>(row.settings, { maxRetries: 3, timeoutMs: 30000 }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getWorkspace(id: string): Workspace | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .get(id) as WorkspaceRow | undefined;
  return row ? rowToWorkspace(row) : null;
}

export function getOrCreateDefault(mode: WorkspaceMode): Workspace {
  const id = `default-${mode}`;
  const existing = getWorkspace(id);
  if (existing) return existing;

  const db = getDb();
  const now = new Date().toISOString();
  const name = "Constellation";

  db.prepare(
    `INSERT INTO workspaces (id, name, mode, nodes, edges, viewport, settings, created_at, updated_at)
     VALUES (?, ?, ?, '[]', '[]', '{"x":0,"y":0,"zoom":1}', '{"maxRetries":3,"timeoutMs":30000}', ?, ?)`
  ).run(id, name, mode, now, now);

  const ws = getWorkspace(id);
  if (!ws) throw new Error(`Failed to create default workspace: ${id}`);
  return ws;
}

export interface SaveWorkspaceData {
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
  viewport: { x: number; y: number; zoom: number };
  settings: WorkspaceSettings;
}

export function saveWorkspace(id: string, data: SaveWorkspaceData): Workspace {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = getWorkspace(id);
  if (!existing) {
    // Auto-create if not found
    const mode: WorkspaceMode = "constellation";
    db.prepare(
      `INSERT INTO workspaces (id, name, mode, nodes, edges, viewport, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      "Constellation",
      mode,
      JSON.stringify(data.nodes),
      JSON.stringify(data.edges),
      JSON.stringify(data.viewport),
      JSON.stringify(data.settings),
      now,
      now
    );
  } else {
    db.prepare(
      `UPDATE workspaces
       SET nodes = ?, edges = ?, viewport = ?, settings = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      JSON.stringify(data.nodes),
      JSON.stringify(data.edges),
      JSON.stringify(data.viewport),
      JSON.stringify(data.settings),
      now,
      id
    );
  }

  const ws = getWorkspace(id);
  if (!ws) throw new Error(`Failed to save workspace: ${id}`);
  return ws;
}

export function deleteWorkspace(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  return result.changes > 0;
}

export function listWorkspaces(): Workspace[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM workspaces ORDER BY created_at ASC")
    .all() as WorkspaceRow[];
  return rows.map(rowToWorkspace);
}
