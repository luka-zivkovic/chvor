/**
 * Database Adapter Interface
 *
 * Abstracts SQLite and PostgreSQL behind a common interface.
 * - Standalone/self-hosted: SQLite (zero-config, default)
 * - Enterprise/Weave-managed: PostgreSQL (one database per user)
 *
 * Selection: CHVOR_DB_DRIVER=sqlite|postgres (default: sqlite)
 */

// ─── Types ─────────────────────────────────────────────────

export interface PreparedStatement<T = unknown> {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
}

export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface DbAdapter {
  /** Execute raw SQL (DDL, multi-statement). No return value. */
  exec(sql: string): void;

  /** Prepare a parameterized statement for run/get/all. */
  prepare<T = unknown>(sql: string): PreparedStatement<T>;

  /** Wrap operations in a transaction. Returns the transaction result. */
  transaction<T>(fn: () => T): () => T;

  /** Execute a pragma (SQLite) or equivalent config (PostgreSQL). */
  pragma(directive: string): unknown;

  /** Whether the vector search extension is available. */
  isVecAvailable(): boolean;

  /** Back up the database to a file path. SQLite: online backup API. PostgreSQL: pg_dump-style SQL dump. */
  backup(destPath: string): Promise<void>;

  /** Close the database connection. */
  close(): void;

  /** The underlying driver name. */
  readonly driver: "sqlite" | "postgres";
}

// ─── Parameter placeholder rewriting ───────────────────────

/**
 * Converts SQLite-style `?` placeholders to PostgreSQL-style `$1, $2, ...`
 * Handles quoted strings and avoids rewriting `?` inside them.
 */
export function sqliteToPostgresParams(sql: string): string {
  let idx = 0;
  let inSingleQuote = false;
  let result = "";

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inSingleQuote) {
        if (sql[i + 1] === "'") {
          // Escaped quote ('') — emit both and skip next
          result += "''";
          i++;
          continue;
        }
        inSingleQuote = false;
      } else {
        inSingleQuote = true;
      }
      result += ch;
    } else if (ch === "?" && !inSingleQuote) {
      idx++;
      result += `$${idx}`;
    } else {
      result += ch;
    }
  }
  return result;
}

/** Find the closing ) of the VALUES (...) clause. Returns -1 if not found. */
function findValuesClauseEnd(sql: string): number {
  const valuesMatch = sql.match(/\bVALUES\s*\(/i);
  if (!valuesMatch || valuesMatch.index === undefined) return -1;

  let depth = 0;
  let inQuote = false;
  const start = valuesMatch.index + valuesMatch[0].length - 1; // position of opening (

  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inQuote) {
      inQuote = true;
    } else if (ch === "'" && inQuote) {
      if (sql[i + 1] === "'") {
        i++; // skip escaped ''
      } else {
        inQuote = false;
      }
    } else if (!inQuote) {
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

/**
 * Rewrites common SQLite SQL idioms to PostgreSQL equivalents.
 * Applied transparently by the PostgreSQL adapter.
 */
export function rewriteSqlForPostgres(sql: string): string {
  let result = sql;

  // INSERT OR REPLACE → INSERT ... ON CONFLICT (pk) DO UPDATE SET ...
  if (/INSERT\s+OR\s+REPLACE\s+INTO/i.test(result)) {
    result = result.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, "INSERT INTO");
    // Extract column list to build ON CONFLICT clause
    const colMatch = result.match(/INSERT\s+INTO\s+\w+\s*\(([^)]+)\)/i);
    if (colMatch) {
      const cols = colMatch[1].split(",").map(c => c.trim());
      const pk = cols[0]; // first column is always the PK in our schema
      const updateCols = cols.slice(1);
      const updateSet = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(", ");
      const valuesEnd = findValuesClauseEnd(result);
      if (valuesEnd !== -1 && !result.includes("ON CONFLICT")) {
        result = result.slice(0, valuesEnd + 1) + ` ON CONFLICT (${pk}) DO UPDATE SET ${updateSet}` + result.slice(valuesEnd + 1);
      }
    }
  }

  // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
  if (/INSERT\s+OR\s+IGNORE/i.test(result)) {
    result = result.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");
    const valuesEnd = findValuesClauseEnd(result);
    if (valuesEnd !== -1 && !result.includes("ON CONFLICT")) {
      result = result.slice(0, valuesEnd + 1) + " ON CONFLICT DO NOTHING" + result.slice(valuesEnd + 1);
    }
  }

  // datetime('now') → CURRENT_TIMESTAMP
  result = result.replace(/datetime\s*\(\s*'now'\s*\)/gi, "CURRENT_TIMESTAMP");

  // Convert ? placeholders to $N
  result = sqliteToPostgresParams(result);

  return result;
}

// ─── Factory ───────────────────────────────────────────────

let adapterInstance: DbAdapter | null = null;

/**
 * Get the database adapter. For SQLite, lazily creates the adapter on first call
 * (backward-compatible with existing sync code paths).
 * For PostgreSQL, initAdapter() must be called first (during async server startup).
 */
export function getAdapter(): DbAdapter {
  if (adapterInstance) return adapterInstance;

  // Lazy init for SQLite only (sync, backward-compatible)
  const driver = process.env.CHVOR_DB_DRIVER ?? "sqlite";
  if (driver === "sqlite") {
    const { createSqliteAdapter } = _sqliteAdapterModule;
    adapterInstance = createSqliteAdapter();
    return adapterInstance;
  }

  throw new Error("[db] PostgreSQL adapter not initialized. Call initAdapter() at server startup.");
}

// Import SQLite adapter eagerly — it's always bundled and has no side effects.
// This avoids async/dynamic import issues for the lazy SQLite init path.
import * as _sqliteAdapterModule from "./sqlite-adapter.ts";

export async function initAdapter(): Promise<DbAdapter> {
  if (adapterInstance) return adapterInstance;

  const driver = (process.env.CHVOR_DB_DRIVER ?? "sqlite") as "sqlite" | "postgres";

  if (driver === "postgres") {
    const { createPostgresAdapter } = await import("./postgres-adapter.ts");
    adapterInstance = await createPostgresAdapter();
  } else {
    const { createSqliteAdapter } = await import("./sqlite-adapter.ts");
    adapterInstance = createSqliteAdapter();
  }

  return adapterInstance;
}

/** Close the adapter and clear the singleton. */
export function closeAdapter(): void {
  if (adapterInstance) {
    adapterInstance.close();
    adapterInstance = null;
  }
}
