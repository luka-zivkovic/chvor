/**
 * SQLite Adapter — wraps better-sqlite3 behind the DbAdapter interface.
 *
 * This is a thin wrapper that preserves the existing sync API.
 * Used for standalone/self-hosted deployments (default).
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbAdapter, PreparedStatement, RunResult } from "./adapter.ts";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

export function createSqliteAdapter(): DbAdapter {
  const dataDir = process.env.CHVOR_DATA_DIR ?? resolve(__dirname, "../../data");
  mkdirSync(dataDir, { recursive: true });

  const db = new Database(join(dataDir, "chvor.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  let vecAvailable = false;
  try {
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(db);
    vecAvailable = true;
    console.log("[db:sqlite] sqlite-vec extension loaded");
  } catch (err) {
    console.warn(
      "[db:sqlite] sqlite-vec unavailable — falling back to recency-based memory retrieval:",
      (err as Error).message
    );
  }

  console.log(`[db:sqlite] ready (${join(dataDir, "chvor.db")})`);

  return {
    driver: "sqlite" as const,

    exec(sql: string): void {
      db.exec(sql);
    },

    prepare<T = unknown>(sql: string): PreparedStatement<T> {
      const stmt = db.prepare(sql);
      return {
        run(...params: unknown[]): RunResult {
          const result = stmt.run(...params);
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        get(...params: unknown[]): T | undefined {
          return stmt.get(...params) as T | undefined;
        },
        all(...params: unknown[]): T[] {
          return stmt.all(...params) as T[];
        },
      };
    },

    transaction<T>(fn: () => T): () => T {
      return db.transaction(fn);
    },

    pragma(directive: string): unknown {
      return db.pragma(directive);
    },

    isVecAvailable(): boolean {
      return vecAvailable;
    },

    async backup(destPath: string): Promise<void> {
      await db.backup(destPath);
    },

    close(): void {
      db.close();
    },
  };
}
