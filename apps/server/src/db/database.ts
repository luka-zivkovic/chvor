import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CHVOR_DATA_DIR ?? resolve(__dirname, "../../data");

interface MigrationMessage {
  id: string;
  role: string;
  content: string;
  channelType?: string;
  timestamp: string;
  executionId?: string;
  actions?: unknown[];
}

function migrateJsonMessages(database: Database.Database): void {
  const sessions = database.prepare(
    "SELECT id, channel_type, messages FROM sessions WHERE messages != '[]'"
  ).all() as { id: string; channel_type: string; messages: string }[];

  if (sessions.length === 0) return;

  const insert = database.prepare(
    `INSERT OR IGNORE INTO messages (id, session_id, role, content, channel_type, timestamp, execution_id, actions, token_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const migrate = database.transaction(() => {
    let count = 0;
    for (const session of sessions) {
      let msgs: MigrationMessage[];
      try {
        msgs = JSON.parse(session.messages);
      } catch { continue; }

      for (const m of msgs) {
        const tokenCount = Math.ceil(m.content.length / 4);
        insert.run(
          m.id,
          session.id,
          m.role,
          m.content,
          m.channelType ?? session.channel_type,
          m.timestamp,
          m.executionId ?? null,
          m.actions ? JSON.stringify(m.actions) : null,
          tokenCount
        );
        count++;
      }
    }
    return count;
  });

  const migrated = migrate();
  console.log(`[db] migrated ${migrated} messages from ${sessions.length} session(s)`);
}

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

  // Migrations
  try {
    db.exec(`ALTER TABLE schedules ADD COLUMN deliver_to TEXT`);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE schedules ADD COLUMN one_shot INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // Version-based migrations
  const currentVersion = (db.pragma("user_version") as { user_version: number }[])[0].user_version;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        execution_id TEXT,
        actions TEXT,
        token_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)");

    // Add summary column to sessions (prep for future summarization feature)
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT");
    } catch { /* already exists */ }

    // Migrate existing JSON messages to rows
    migrateJsonMessages(db);

    db.pragma("user_version = 1");
    console.log("[db] migration v1 applied: messages table created");
  }

  if (currentVersion < 2) {
    // Add embedding column to memories
    try {
      db.exec("ALTER TABLE memories ADD COLUMN embedding BLOB");
    } catch { /* already exists */ }

    // Create vector search table (requires sqlite-vec)
    if (vecAvailable) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[384]
        )
      `);
    }

    db.pragma("user_version = 2");
    console.log("[db] migration v2 applied: vector embeddings for semantic memory");
  }

  if (currentVersion < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shell_audit (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        working_dir TEXT NOT NULL,
        tier TEXT NOT NULL,
        approved INTEGER NOT NULL,
        denied_reason TEXT,
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT,
        duration_ms INTEGER NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_shell_audit_created ON shell_audit(created_at DESC)"
    );

    db.pragma("user_version = 3");
    console.log("[db] migration v3 applied: shell_audit table for command execution logging");
  }

  if (currentVersion < 4) {
    try {
      db.exec("ALTER TABLE messages ADD COLUMN media TEXT");
    } catch { /* already exists */ }

    db.pragma("user_version = 4");
    console.log("[db] migration v4 applied: media column on messages");
  }

  if (currentVersion < 5) {
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN title TEXT");
    } catch { /* already exists */ }
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN archived_at TEXT");
    } catch { /* already exists */ }
    db.pragma("user_version = 5");
    console.log("[db] migrated to v5: session title + archived_at");
  }

  if (currentVersion < 6) {
    try {
      db.exec("ALTER TABLE schedules ADD COLUMN workflow_id TEXT");
    } catch (e: unknown) {
      if (!(e instanceof Error) || !e.message.includes("duplicate column")) throw e;
    }
    try {
      db.exec("ALTER TABLE schedules ADD COLUMN workflow_params TEXT");
    } catch (e: unknown) {
      if (!(e instanceof Error) || !e.message.includes("duplicate column")) throw e;
    }
    db.pragma("user_version = 6");
    console.log("[db] migrated to v6: workflow_id + workflow_params on schedules");
  }

  if (currentVersion < 7) {
    try {
      db.exec("ALTER TABLE credentials ADD COLUMN usage_context TEXT");
    } catch (e: unknown) {
      if (!(e instanceof Error) || !e.message.includes("duplicate column")) throw e;
    }
    db.pragma("user_version = 7");
    console.log("[db] migrated to v7: usage_context column on credentials");
  }

  if (currentVersion < 8) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS emotion_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT,
        valence REAL NOT NULL,
        arousal REAL NOT NULL,
        dominance REAL NOT NULL,
        primary_emotion TEXT NOT NULL,
        primary_weight REAL NOT NULL,
        secondary_emotion TEXT,
        secondary_weight REAL,
        intensity REAL NOT NULL,
        display_label TEXT NOT NULL,
        signals TEXT,
        trigger TEXT NOT NULL DEFAULT 'message',
        created_at TEXT NOT NULL
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_emotion_session ON emotion_snapshots(session_id, created_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_emotion_created ON emotion_snapshots(created_at DESC)");
    db.pragma("user_version = 8");
    console.log("[db] migration v8 applied: emotion_snapshots table");
  }

  if (currentVersion < 9) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS emotion_residues (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        valence REAL NOT NULL,
        arousal REAL NOT NULL,
        dominance REAL NOT NULL,
        primary_emotion TEXT NOT NULL,
        intensity REAL NOT NULL,
        topic_hint TEXT NOT NULL DEFAULT '',
        unresolved_since TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolved_at TEXT
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_residue_unresolved ON emotion_residues(resolved, unresolved_since)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS relationship_state (
        id TEXT PRIMARY KEY DEFAULT 'singleton',
        total_sessions INTEGER NOT NULL DEFAULT 0,
        total_messages INTEGER NOT NULL DEFAULT 0,
        avg_emotional_depth REAL NOT NULL DEFAULT 0,
        depth REAL NOT NULL DEFAULT 0,
        first_interaction TEXT,
        last_interaction TEXT
      )
    `);
    db.pragma("user_version = 9");
    console.log("[db] migration v9 applied: emotion_residues + relationship_state tables");
  }

  if (currentVersion < 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        secret TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'default-constellation',
        enabled INTEGER NOT NULL DEFAULT 1,
        deliver_to TEXT,
        filters TEXT,
        last_received_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_summary TEXT,
        result TEXT,
        error TEXT,
        received_at TEXT NOT NULL
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_webhook_events_sub ON webhook_events(subscription_id, received_at DESC)"
    );
    db.pragma("user_version = 10");
    console.log("[db] migration v10 applied: webhook_subscriptions + webhook_events tables");
  }

  if (currentVersion < 11) {
    // ── Cognitive Memory System ─────────────────────────────────

    // Create new memory_nodes table
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id            TEXT PRIMARY KEY,
        abstract      TEXT NOT NULL,
        overview      TEXT,
        detail        TEXT,
        category      TEXT NOT NULL,
        space         TEXT NOT NULL DEFAULT 'user',
        strength      REAL NOT NULL DEFAULT 1.0,
        decay_rate    REAL NOT NULL DEFAULT 0.1,
        access_count  INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        confidence    REAL NOT NULL DEFAULT 0.8,
        provenance    TEXT NOT NULL DEFAULT 'extracted',
        emotional_valence   REAL,
        emotional_intensity REAL,
        source_channel    TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_message_id TEXT,
        embedding     BLOB,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_nodes(category)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_strength ON memory_nodes(strength DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_space ON memory_nodes(space, category)");

    // Associative memory graph edges
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_edges (
        id          TEXT PRIMARY KEY,
        source_id   TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        target_id   TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        relation    TEXT NOT NULL,
        weight      REAL NOT NULL DEFAULT 0.5,
        created_at  TEXT NOT NULL,
        UNIQUE(source_id, target_id, relation)
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_edge_source ON memory_edges(source_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_edge_target ON memory_edges(target_id)");

    // Memory access log for predictive preloading
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_access_log (
        id          TEXT PRIMARY KEY,
        memory_id   TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        session_id  TEXT NOT NULL,
        query_text  TEXT,
        topic_hash  TEXT,
        accessed_at TEXT NOT NULL
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_access_session ON memory_access_log(session_id, accessed_at DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_access_topic ON memory_access_log(topic_hash, accessed_at DESC)");

    // Vector table for new memory nodes
    if (vecAvailable) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_node_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[384]
        )
      `);
    }

    // Migrate existing memories to memory_nodes (if legacy table exists)
    const hasLegacyTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
    ).get();

    if (hasLegacyTable) {
      const legacyMemories = db.prepare("SELECT * FROM memories").all() as Array<{
        id: string; content: string; source_channel: string;
        source_session_id: string; embedding: Buffer | null;
        created_at: string; updated_at: string;
      }>;

      const insertNode = db.prepare(`
        INSERT OR IGNORE INTO memory_nodes
          (id, abstract, detail, category, space, strength, decay_rate, confidence, provenance,
           source_channel, source_session_id, embedding, created_at, updated_at)
        VALUES (?, ?, ?, 'profile', 'user', 1.0, 0.1, 0.7, 'extracted', ?, ?, ?, ?, ?)
      `);
      const insertVec = vecAvailable
        ? db.prepare("INSERT OR IGNORE INTO memory_node_vec (id, embedding) VALUES (?, ?)")
        : null;

      // Wrap data migration + rename in a single transaction for atomicity
      const migrateTx = db.transaction(() => {
        for (const m of legacyMemories) {
          const firstLine = m.content.split(/[.\n]/)[0].trim().slice(0, 120);
          const nodeAbstract = firstLine || m.content.slice(0, 120);
          insertNode.run(
            m.id, nodeAbstract, m.content, m.source_channel, m.source_session_id,
            m.embedding, m.created_at, m.updated_at
          );
          if (insertVec && m.embedding) {
            insertVec.run(m.id, m.embedding);
          }
        }
        // Guard against crash-loop: if a previous partial migration already renamed
        // the table but user_version wasn't bumped, don't throw on re-entry.
        const alreadyRenamed = db!.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_v1_backup'"
        ).get();
        if (!alreadyRenamed) {
          db!.exec("ALTER TABLE memories RENAME TO memories_v1_backup");
        }
      });
      migrateTx();

      // DROP IF EXISTS is always safe — remove guard so orphan table is cleaned up
      // even when sqlite-vec is unavailable at this startup
      try {
        db.exec("DROP TABLE IF EXISTS memory_vec");
      } catch { /* may not exist */ }

      console.log(`[db] migrated ${legacyMemories.length} legacy memories to memory_nodes`);
    }

    // PRAGMA user_version writes directly to DB header — it is NOT transactional.
    // Must be set outside any transaction to take effect reliably.
    db.pragma("user_version = 11");

    console.log("[db] migration v11 applied: cognitive memory system (memory_nodes, memory_edges, memory_access_log)");
  }

  if (currentVersion < 12) {
    // ── Authentication & API Keys ─────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_agent TEXT,
        ip_address TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token_hash)");

    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL DEFAULT '*',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix)");

    // Legacy CHVOR_TOKEN migration: import as an API key so existing deployments keep working
    const legacyToken = process.env.CHVOR_TOKEN;
    if (legacyToken && legacyToken.length > 0) {
      const id = randomUUID();
      const prefix = legacyToken.slice(0, 8);
      const keyHash = createHash("sha256").update(legacyToken).digest("hex");
      const now = new Date().toISOString();

      db.prepare(
        `INSERT OR IGNORE INTO api_keys (id, name, key_prefix, key_hash, scopes, created_at)
         VALUES (?, 'Legacy CHVOR_TOKEN', ?, ?, '*', ?)`
      ).run(id, prefix, keyHash, now);

      console.log("[db] migrated CHVOR_TOKEN to legacy API key");
    }

    db.pragma("user_version = 12");
    console.log("[db] migration v12 applied: auth_config, auth_sessions, api_keys tables");
  }

  if (currentVersion < 13) {
    // ── Knowledge Resources (multi-modal ingestion) ──────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_resources (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        title         TEXT NOT NULL,
        source_url    TEXT,
        media_id      TEXT,
        mime_type     TEXT,
        file_size     INTEGER,
        content_text  TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        error         TEXT,
        memory_count  INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_kr_status ON knowledge_resources(status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_kr_created ON knowledge_resources(created_at DESC)");

    // Link memory_nodes to their source resource (nullable)
    const cols = db.prepare("PRAGMA table_info(memory_nodes)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "source_resource_id")) {
      db.exec("ALTER TABLE memory_nodes ADD COLUMN source_resource_id TEXT");
    }

    db.pragma("user_version = 13");
    console.log("[db] migration v13 applied: knowledge_resources table + memory_nodes.source_resource_id");
  }

  if (currentVersion < 14) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_jobs (
        job_id TEXT PRIMARY KEY,
        interval_ms INTEGER NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT
      )
    `);
    // Seed default system jobs (won't duplicate on re-run due to INSERT OR IGNORE)
    const now = new Date().toISOString();
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const seedJob = db.prepare(
      "INSERT OR IGNORE INTO system_jobs (job_id, interval_ms, next_run_at, status) VALUES (?, ?, ?, 'idle')"
    );
    seedJob.run("memory-decay", SIX_HOURS, now);
    seedJob.run("memory-consolidation", SIX_HOURS, now);
    seedJob.run("backup", TWENTY_FOUR_HOURS, now);

    db.pragma("user_version = 14");
    console.log("[db] migration v14 applied: system_jobs table for persistent periodic jobs");
  }

  if (currentVersion < 15) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        priority INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'queued',
        progress TEXT,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_daemon_tasks_status ON daemon_tasks(status, priority DESC, created_at);
    `);
    db.pragma("user_version = 15");
    console.log("[db] migration v15 applied: daemon_tasks table for always-on daemon");
  }

  if (currentVersion < 16) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_category ON memory_nodes(category);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_strength ON memory_nodes(strength);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_created_at ON memory_nodes(created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_source_target ON memory_edges(source_id, target_id);
    `);
    db.pragma("user_version = 16");
    console.log("[db] migration v16 applied: memory indexes for graph & stats queries");
  }

  if (currentVersion < 17) {
    try {
      db.exec(`ALTER TABLE daemon_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column may already exist if a previous run partially applied this migration
    }
    db.pragma("user_version = 17");
    console.log("[db] migration v17 applied: daemon_tasks retry_count column");
  }

  if (currentVersion < 18) {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT OR IGNORE INTO system_jobs (job_id, interval_ms, next_run_at, status) VALUES (?, ?, ?, 'idle')"
    ).run("retention-cleanup", 24 * 60 * 60 * 1000, now);
    db.pragma("user_version = 18");
    console.log("[db] migration v18 applied: retention-cleanup job");
  }

  if (currentVersion < 19) {
    try {
      db.exec("ALTER TABLE credentials ADD COLUMN connection_config TEXT");
    } catch (e: unknown) {
      if (!(e instanceof Error) || !e.message.includes("duplicate column")) throw e;
    }
    db.pragma("user_version = 19");
    console.log("[db] migrated to v19: connection_config column on credentials");
  }

  if (currentVersion < 20) {
    // ── Typed event sourcing: action/observation audit trail ──────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_events (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        kind TEXT NOT NULL,
        tool TEXT NOT NULL,
        args TEXT NOT NULL,
        ts INTEGER NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'session',
        actor_id TEXT,
        parent_action_id TEXT
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_ae_session_ts ON action_events(session_id, ts DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ae_tool_ts ON action_events(tool, ts DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ae_ts ON action_events(ts DESC)");

    db.exec(`
      CREATE TABLE IF NOT EXISTS observation_events (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        action_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT,
        ts INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_oe_action ON observation_events(action_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_oe_session_ts ON observation_events(session_id, ts DESC)");

    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        resource_type TEXT,
        resource_id TEXT,
        action TEXT,
        http_method TEXT,
        http_path TEXT,
        http_status_code INTEGER,
        error TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event_type, created_at DESC)");

    db.pragma("user_version = 20");
    console.log("[db] migration v20 applied: action_events, observation_events, audit_log (typed audit trail)");
  }

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
