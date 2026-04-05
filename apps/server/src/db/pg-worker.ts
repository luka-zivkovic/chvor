/**
 * PostgreSQL Worker Thread
 *
 * Runs pg queries in a dedicated worker thread with its own event loop,
 * avoiding the Atomics.wait deadlock that occurs when blocking the main
 * thread's event loop (which pg needs for TCP I/O).
 *
 * Communication protocol:
 * - parentPort: used only for init handshake (ready / init-error)
 * - MessageChannel port (via workerData.port): used for query results
 * - SharedArrayBuffer: used for Atomics.wait/notify signaling
 *
 * Transaction safety:
 * - A single txClient is held for the duration of a transaction,
 *   ensuring BEGIN/queries/COMMIT all use the same connection.
 */

import { parentPort, workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import pg from "pg";

const { Pool } = pg;

interface WorkerData {
  connectionString: string;
  port: MessagePort;
}

interface QueryMessage {
  type: "query" | "begin" | "commit" | "rollback" | "close";
  sql?: string;
  params?: unknown[];
  sab: SharedArrayBuffer;
}

const { connectionString, port } = workerData as WorkerData;

const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/** Held for the duration of a transaction to guarantee single-connection semantics. */
let txClient: pg.PoolClient | null = null;

async function init(): Promise<void> {
  // Test connectivity
  const client = await pool.connect();
  client.release();

  // Check pgvector availability
  let vecAvailable = false;
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    vecAvailable = true;
  } catch {
    // pgvector not installed — not fatal
  }

  // Schema version tracking table (replaces SQLite PRAGMA user_version)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _chvor_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Signal ready to main thread via parentPort (not the MessageChannel)
  parentPort!.postMessage({ type: "ready", vecAvailable });
}

parentPort!.on("message", async (msg: QueryMessage) => {
  const { type, sql, params, sab } = msg;
  const i32 = new Int32Array(sab);

  try {
    switch (type) {
      case "query": {
        const client = txClient || pool;
        const res = await client.query(sql!, params);
        port.postMessage({
          result: { rows: res.rows, rowCount: res.rowCount ?? 0 },
        });
        break;
      }

      case "begin": {
        txClient = await pool.connect();
        await txClient.query("BEGIN");
        port.postMessage({ result: { rows: [], rowCount: 0 } });
        break;
      }

      case "commit": {
        if (txClient) {
          await txClient.query("COMMIT");
          txClient.release();
          txClient = null;
        }
        port.postMessage({ result: { rows: [], rowCount: 0 } });
        break;
      }

      case "rollback": {
        if (txClient) {
          try {
            await txClient.query("ROLLBACK");
          } catch {
            /* best-effort rollback */
          }
          txClient.release();
          txClient = null;
        }
        port.postMessage({ result: { rows: [], rowCount: 0 } });
        break;
      }

      case "close": {
        if (txClient) {
          try {
            await txClient.query("ROLLBACK");
          } catch {
            /* best-effort rollback */
          }
          txClient.release();
          txClient = null;
        }
        await pool.end();
        port.postMessage({ result: { rows: [], rowCount: 0 } });
        break;
      }
    }
  } catch (err) {
    port.postMessage({ error: (err as Error).message });
  }

  // Wake the main thread
  Atomics.store(i32, 0, 1);
  Atomics.notify(i32, 0);
});

init().catch((err) => {
  parentPort!.postMessage({
    type: "init-error",
    error: (err as Error).message,
  });
});
