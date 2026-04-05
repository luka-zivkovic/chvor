/**
 * PostgreSQL Adapter — wraps `pg` behind the DbAdapter interface.
 *
 * Used for enterprise/Weave-managed deployments where each user gets
 * their own PostgreSQL database in a shared cluster.
 *
 * Design decisions:
 * - Runs pg queries in a dedicated worker thread to avoid the
 *   Atomics.wait deadlock: the main thread blocks on SharedArrayBuffer,
 *   while the worker's event loop processes TCP I/O normally.
 * - Transactions acquire a single pg PoolClient for the entire
 *   BEGIN/queries/COMMIT sequence, ensuring connection affinity.
 * - pg_dump credentials are passed via PGPASSWORD env var (not CLI args)
 *   to prevent leaking passwords in `ps aux` output.
 * - Translates SQLite SQL idioms (?, INSERT OR IGNORE, etc.) to PostgreSQL
 *   equivalents transparently via rewriteSqlForPostgres().
 * - pgvector extension replaces sqlite-vec for vector similarity search.
 *
 * Env vars:
 *   CHVOR_DB_URL=postgres://user:pass@host:5432/chvor_user_xxx
 *   CHVOR_DB_DRIVER=postgres
 */

import { Worker, receiveMessageOnPort, MessageChannel } from "node:worker_threads";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { rewriteSqlForPostgres } from "./adapter.ts";
import type { DbAdapter, PreparedStatement, RunResult } from "./adapter.ts";

/** Timeout for individual queries sent to the worker (ms). */
const QUERY_TIMEOUT_MS = 30_000;

/** Timeout for the worker init handshake (ms). */
const INIT_TIMEOUT_MS = 15_000;

interface WorkerResult {
  result?: { rows: unknown[]; rowCount: number };
  error?: string;
}

/**
 * Sends a message to the worker, blocks until the worker signals completion
 * via SharedArrayBuffer, then synchronously reads the result from the
 * MessageChannel port.
 */
function sendToWorker<T>(
  worker: Worker,
  mainPort: MessagePort,
  msg: { type: string; sql?: string; params?: unknown[] }
): { rows: T[]; rowCount: number } {
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);

  worker.postMessage({ ...msg, sab });

  const waitResult = Atomics.wait(i32, 0, 0, QUERY_TIMEOUT_MS);
  if (waitResult === "timed-out") {
    throw new Error(`[db:postgres] query timed out after ${QUERY_TIMEOUT_MS}ms`);
  }

  const received = receiveMessageOnPort(mainPort);
  if (!received) {
    throw new Error("[db:postgres] no response from worker after signal");
  }

  const data = received.message as WorkerResult;
  if (data.error) {
    throw new Error(`[db:postgres] ${data.error}`);
  }
  if (!data.result) {
    throw new Error("[db:postgres] empty response from worker");
  }

  return { rows: data.result.rows as T[], rowCount: data.result.rowCount };
}

/**
 * Wait for the worker to complete initialization (connection test,
 * pgvector check, meta table creation).
 */
function waitForWorkerInit(worker: Worker): Promise<{ vecAvailable: boolean }> {
  return new Promise<{ vecAvailable: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("[db:postgres] worker init timed out"));
    }, INIT_TIMEOUT_MS);

    worker.once("message", (msg: { type: string; vecAvailable?: boolean; error?: string }) => {
      clearTimeout(timer);
      if (msg.type === "ready") {
        resolve({ vecAvailable: msg.vecAvailable ?? false });
      } else if (msg.type === "init-error") {
        reject(new Error(`[db:postgres] worker init failed: ${msg.error}`));
      } else {
        reject(new Error(`[db:postgres] unexpected init message: ${msg.type}`));
      }
    });

    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function createPostgresAdapter(): Promise<DbAdapter> {
  const connectionString = process.env.CHVOR_DB_URL;
  if (!connectionString) {
    throw new Error("[db:postgres] CHVOR_DB_URL environment variable is required");
  }

  // MessageChannel: mainPort stays in main thread, workerPort is transferred to the worker.
  const { port1: mainPort, port2: workerPort } = new MessageChannel();

  const worker = new Worker(new URL("./pg-worker.ts", import.meta.url), {
    workerData: {
      connectionString,
      port: workerPort,
    },
    transferList: [workerPort],
  });

  const { vecAvailable } = await waitForWorkerInit(worker);

  if (vecAvailable) {
    console.log("[db:postgres] pgvector extension loaded");
  } else {
    console.warn(
      "[db:postgres] pgvector unavailable — falling back to recency-based memory retrieval"
    );
  }

  console.log(`[db:postgres] ready (${connectionString.replace(/:[^:@]+@/, ":***@")})`);

  /**
   * Convenience: send a query to the worker and block until complete.
   */
  function querySync<T>(sql: string, params?: unknown[]): { rows: T[]; rowCount: number } {
    return sendToWorker<T>(worker, mainPort, { type: "query", sql, params });
  }

  /**
   * Send a transaction control message (begin/commit/rollback) to the worker.
   */
  function txControl(type: "begin" | "commit" | "rollback"): void {
    sendToWorker(worker, mainPort, { type });
  }

  return {
    driver: "postgres" as const,

    exec(sql: string): void {
      const pgSql = rewriteSqlForPostgres(sql);
      querySync(pgSql);
    },

    prepare<T = unknown>(sql: string): PreparedStatement<T> {
      const pgSql = rewriteSqlForPostgres(sql);

      return {
        run(...params: unknown[]): RunResult {
          const pgParams = params.map(normalizeParam);
          const res = querySync(pgSql, pgParams);
          return { changes: res.rowCount };
        },
        get(...params: unknown[]): T | undefined {
          const pgParams = params.map(normalizeParam);
          const res = querySync<T>(pgSql, pgParams);
          return res.rows[0];
        },
        all(...params: unknown[]): T[] {
          const pgParams = params.map(normalizeParam);
          const res = querySync<T>(pgSql, pgParams);
          return res.rows;
        },
      };
    },

    transaction<T>(fn: () => T): () => T {
      return () => {
        txControl("begin");
        try {
          const result = fn();
          txControl("commit");
          return result;
        } catch (err) {
          txControl("rollback");
          throw err;
        }
      };
    },

    pragma(directive: string): unknown {
      if (directive === "journal_mode = WAL" || directive === "foreign_keys = ON") {
        return []; // N/A for PostgreSQL
      }

      if (directive.startsWith("user_version")) {
        if (directive.includes("=")) {
          // SET: pragma("user_version = 5")
          const version = directive.split("=")[1].trim();
          querySync(
            `INSERT INTO _chvor_meta (key, value) VALUES ('schema_version', $1)
             ON CONFLICT (key) DO UPDATE SET value = $1`,
            [version]
          );
          return [];
        }
        // GET: pragma("user_version")
        const res = querySync<{ value: string }>(
          "SELECT value FROM _chvor_meta WHERE key = 'schema_version'"
        );
        const version = res.rows[0]?.value ?? "0";
        return [{ user_version: parseInt(version, 10) }];
      }

      // table_info pragma — used in migration v13 to check column existence
      const tableInfoMatch = directive.match(/^table_info\((\w+)\)$/);
      if (tableInfoMatch) {
        const tableName = tableInfoMatch[1];
        const res = querySync<{ name: string }>(
          `SELECT column_name AS name FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = 'public'`,
          [tableName]
        );
        return res.rows;
      }

      return []; // Unknown pragma — ignore silently
    },

    isVecAvailable(): boolean {
      return vecAvailable;
    },

    async backup(destPath: string): Promise<void> {
      // Parse connection string and pass credentials via env vars
      // to avoid leaking the password in `ps aux` output.
      const url = new URL(connectionString);
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
      };
      if (url.hostname) env.PGHOST = url.hostname;
      if (url.port) env.PGPORT = url.port;
      if (url.username) env.PGUSER = decodeURIComponent(url.username);
      if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
      if (url.pathname.length > 1) env.PGDATABASE = url.pathname.slice(1);

      return new Promise<void>((resolve, reject) => {
        execFile("pg_dump", ["--no-owner", "--no-acl"], { env }, (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`[db:postgres] pg_dump failed: ${stderr || err.message}`));
            return;
          }
          writeFile(destPath, stdout, "utf-8").then(resolve, reject);
        });
      });
    },

    close(): void {
      try {
        sendToWorker(worker, mainPort, { type: "close" });
      } catch {
        // Timeout or worker already dead — proceed to terminate
      }
      worker.terminate();
    },
  };
}

/** Normalize parameter values for PostgreSQL compatibility. */
function normalizeParam(param: unknown): unknown {
  if (param === undefined) return null;
  return param;
}
