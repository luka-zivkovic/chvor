import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrations.ts";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CHVOR_DATA_DIR ?? resolve(__dirname, "../../data");

let db: Database.Database | null = null;
let vecAvailable = false;

export function isVecAvailable(): boolean {
  return vecAvailable;
}

export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(join(DATA_DIR, "chvor.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Load sqlite-vec extension for vector search
  try {
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(db);
    vecAvailable = true;
    console.log("[db] sqlite-vec extension loaded");
  } catch (err) {
    console.warn("[db] sqlite-vec unavailable — falling back to recency-based memory retrieval:", (err as Error).message);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      encrypted_data TEXT NOT NULL,
      usage_context TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_tested_at TEXT,
      test_status TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'constellation',
      nodes TEXT NOT NULL DEFAULT '[]',
      edges TEXT NOT NULL DEFAULT '[]',
      viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
      settings TEXT NOT NULL DEFAULT '{"maxRetries":3,"timeoutMs":30000}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      prompt TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_result TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_id TEXT,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      messages TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)`
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      result TEXT,
      error TEXT
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, started_at DESC)`
  );

  runMigrations(db, vecAvailable);

  console.log(`[db] SQLite ready (${join(DATA_DIR, "chvor.db")})`);
  return db;
}

/**
 * Recreate the memory_node_vec virtual table with a new dimension.
 * Called when the embedding provider changes and produces different-sized vectors.
 */
export function rebuildVecTable(newDimensions: number): void {
  if (!vecAvailable || !db) return;
  try {
    db.exec("DROP TABLE IF EXISTS memory_node_vec");
    db.exec(`
      CREATE VIRTUAL TABLE memory_node_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${newDimensions}]
      )
    `);
    console.log(`[db] rebuilt memory_node_vec with ${newDimensions} dimensions`);
  } catch (err) {
    console.error("[db] failed to rebuild vec table:", (err as Error).message);
  }
}

/** Close the database and clear the singleton. Used before restore overwrites the DB file. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
