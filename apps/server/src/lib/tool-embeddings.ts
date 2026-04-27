import { createHash } from "node:crypto";
import { getDb, isVecAvailable } from "../db/database.ts";
import { embed, getEmbeddingDim, isEmbedderAvailable } from "./embedder.ts";
import {
  getNativeToolDefinitions,
  getNativeToolGroupMap,
} from "./native-tools.ts";
import { loadTools } from "./capability-loader.ts";

/**
 * Cognitive Tool Graph — semantic embeddings (Phase F).
 *
 * Embeds each tool's `name + description + group` into a sqlite-vec table so
 * the graph can return cold-start sensible rankings before any usage history
 * exists. Plays the role of fail-safe #4 in the design ("strong semantic
 * match surfaces a tool regardless of Hebbian strength").
 *
 * Same patterns as `memory-store.ts` for consistency:
 *   - 384-dim float vectors (matches the existing embedder)
 *   - cosine-equivalent ranking via sqlite-vec L2 distance on normalized
 *     vectors (the embedder produces normalized output)
 *   - INSERT OR REPLACE so re-syncing is idempotent
 *   - Cheap incremental sync via a SHA-256 hash of the source text
 */

interface VercelToolDef {
  description?: string;
}

export interface ToolEmbeddingTextSource {
  toolName: string;
  description: string;
  group: string | undefined;
}

/** Stable canonical form used both for hashing and for the embedder. */
export function canonicalToolText(src: ToolEmbeddingTextSource): string {
  const desc = (src.description ?? "").replace(/\s+/g, " ").trim();
  const group = src.group ?? "integrations-other";
  // The qualified name carries information ("native__web_search" → "web search")
  // so we split it before joining to give the embedder cleaner tokens.
  const friendlyName = src.toolName
    .replace(/^native__/, "")
    .replace(/__/g, " ")
    .replace(/_/g, " ")
    .trim();
  return `tool: ${friendlyName} | group: ${group} | description: ${desc}`;
}

function hashText(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ── Source enumeration ────────────────────────────────────────

/**
 * Build the canonical (toolName → {description, group}) map across native +
 * MCP/synth tools. MCP/synth descriptions live on the parent Tool's metadata
 * + each declared endpoint; we use the parent's `description` for now since
 * per-endpoint embeddings would multiply the row count by 10x without much
 * extra signal.
 */
export function listToolEmbeddingSources(): ToolEmbeddingTextSource[] {
  const out: ToolEmbeddingTextSource[] = [];

  // Native tools — descriptions live on the Vercel AI SDK tool() defs.
  const groupMap = getNativeToolGroupMap();
  const defs = getNativeToolDefinitions();
  for (const [name, def] of Object.entries(defs)) {
    const description =
      typeof (def as VercelToolDef).description === "string"
        ? ((def as VercelToolDef).description as string)
        : "";
    out.push({
      toolName: name,
      description,
      group: groupMap[name]?.group,
    });
  }

  // MCP / synthesized — represent at the Tool level (toolId) so prefix
  // lookups in lookupSemanticScore can fall through cleanly. Endpoint-level
  // embeddings can come later if we observe the tool-level signal isn't sharp
  // enough.
  for (const t of loadTools()) {
    if (!t.mcpServer) continue;
    out.push({
      toolName: t.id,
      description: t.metadata.description,
      group: t.metadata.group,
    });
  }

  return out;
}

// ── Sync ──────────────────────────────────────────────────────

export interface SyncResult {
  attempted: number;
  synced: number;
  skippedHashHit: number;
  skippedNoEmbedder: number;
  errors: number;
  durationMs: number;
}

/**
 * Embed every catalogued tool whose canonical text has changed since the
 * last sync (or all of them when `force=true`). Idempotent — safe to call
 * on every reload + on startup. Returns counters for diagnostics; never
 * throws (failures are absorbed so the orchestrator never blocks on
 * embedder availability).
 */
export async function syncToolEmbeddings(force = false): Promise<SyncResult> {
  const started = Date.now();
  const result: SyncResult = {
    attempted: 0,
    synced: 0,
    skippedHashHit: 0,
    skippedNoEmbedder: 0,
    errors: 0,
    durationMs: 0,
  };

  if (!isVecAvailable()) {
    // Without sqlite-vec the entire feature is a no-op; not an error.
    result.durationMs = Date.now() - started;
    return result;
  }
  if (!isEmbedderAvailable()) {
    // Embedder still warming up (local model download). Caller will retry.
    result.skippedNoEmbedder = 1;
    result.durationMs = Date.now() - started;
    return result;
  }

  const sources = listToolEmbeddingSources();
  result.attempted = sources.length;

  const db = getDb();
  const expectedDim = getEmbeddingDim();
  const now = new Date().toISOString();

  for (const src of sources) {
    try {
      const text = canonicalToolText(src);
      const hash = hashText(text);
      if (!force) {
        const existing = db
          .prepare("SELECT text_hash FROM tool_embedding_meta WHERE tool_name = ?")
          .get(src.toolName) as { text_hash: string } | undefined;
        if (existing && existing.text_hash === hash) {
          result.skippedHashHit++;
          continue;
        }
      }

      const vector = await embed(text);
      if (vector.length !== expectedDim) {
        console.warn(
          `[tool-embeddings] dimension mismatch for ${src.toolName}: got ${vector.length}, expected ${expectedDim} — skipping`
        );
        result.errors++;
        continue;
      }
      const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

      const tx = db.transaction(() => {
        db.prepare("INSERT OR REPLACE INTO tool_vec (id, embedding) VALUES (?, ?)").run(
          src.toolName,
          buf
        );
        db.prepare(
          `INSERT INTO tool_embedding_meta (tool_name, text_hash, last_synced_at)
           VALUES (?, ?, ?)
           ON CONFLICT(tool_name) DO UPDATE SET
             text_hash = excluded.text_hash,
             last_synced_at = excluded.last_synced_at`
        ).run(src.toolName, hash, now);
      });
      tx();
      result.synced++;
    } catch (err) {
      console.warn(
        `[tool-embeddings] failed to embed ${src.toolName}:`,
        err instanceof Error ? err.message : String(err)
      );
      result.errors++;
    }
  }

  // Drop rows for tools that no longer exist in the catalog. Keeps the table
  // honest after skill/tool deletions.
  try {
    const liveNames = new Set(sources.map((s) => s.toolName));
    const all = db
      .prepare("SELECT tool_name FROM tool_embedding_meta")
      .all() as Array<{ tool_name: string }>;
    const stale = all.filter((r) => !liveNames.has(r.tool_name)).map((r) => r.tool_name);
    if (stale.length > 0) {
      const tx = db.transaction(() => {
        const placeholders = stale.map(() => "?").join(",");
        db.prepare(`DELETE FROM tool_vec WHERE id IN (${placeholders})`).run(...stale);
        db.prepare(`DELETE FROM tool_embedding_meta WHERE tool_name IN (${placeholders})`).run(...stale);
      });
      tx();
    }
  } catch (err) {
    console.warn("[tool-embeddings] stale row cleanup failed:", err instanceof Error ? err.message : String(err));
  }

  result.durationMs = Date.now() - started;
  if (result.synced > 0 || result.errors > 0) {
    console.log(
      `[tool-embeddings] synced ${result.synced}/${result.attempted} (skipped: ${result.skippedHashHit}, errors: ${result.errors}) in ${result.durationMs}ms`
    );
  }
  return result;
}

// ── Query ─────────────────────────────────────────────────────

export interface SemanticHit {
  toolName: string;
  similarity: number;
  distance: number;
}

/**
 * Cosine-equivalent top-K query for a free-text question. Returns the
 * tool names with their L2 distance + a similarity score in [0, 1] (1 best)
 * derived assuming the embedder produces L2-normalized vectors.
 *
 * `candidates`, when provided, restricts the result set to tools in that
 * set — used by the orchestrator to keep the semantic signal scoped to the
 * already-resolved bag candidates.
 */
export async function topKBySemantic(
  query: string,
  options: { candidates?: string[]; k?: number } = {}
): Promise<SemanticHit[]> {
  if (!query.trim()) return [];
  if (!isVecAvailable() || !isEmbedderAvailable()) return [];

  const k = Math.min(Math.max(options.k ?? 20, 1), 200);

  try {
    const vector = await embed(query);
    if (vector.length !== getEmbeddingDim()) return [];
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, distance
           FROM tool_vec
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`
      )
      .all(buf, k) as Array<{ id: string; distance: number }>;

    let hits: SemanticHit[] = rows.map((r) => ({
      toolName: r.id,
      distance: r.distance,
      similarity: Math.max(0, Math.min(1, 1 - (r.distance * r.distance) / 2)),
    }));

    if (options.candidates && options.candidates.length > 0) {
      const allowed = new Set(options.candidates);
      // Endpoint-style names ("github__create_issue") map back to the
      // toolId-prefix entry stored in tool_vec ("github").
      hits = hits.filter((h) => {
        if (allowed.has(h.toolName)) return true;
        for (const c of allowed) {
          const sep = c.indexOf("__");
          if (sep > 0 && c.slice(0, sep) === h.toolName) return true;
        }
        return false;
      });
    }

    return hits;
  } catch (err) {
    console.warn(
      "[tool-embeddings] semantic query failed:",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/**
 * Convenience: build a `Map<toolName, similarity>` over a candidate set.
 * Returns an empty map if the embedder isn't available — callers should
 * treat that as a "no semantic signal this turn" rather than an error.
 */
export async function semanticScoresFor(
  query: string,
  candidates: string[]
): Promise<Map<string, number>> {
  const hits = await topKBySemantic(query, { candidates, k: candidates.length });
  const map = new Map<string, number>();
  for (const h of hits) map.set(h.toolName, h.similarity);
  // Spread tool-level scores down to their endpoint children so callers
  // ranking endpoint names (e.g. "github__create_issue") still see a score.
  for (const c of candidates) {
    if (map.has(c)) continue;
    const sep = c.indexOf("__");
    if (sep > 0) {
      const prefix = c.slice(0, sep);
      const fromPrefix = map.get(prefix);
      if (fromPrefix !== undefined) map.set(c, fromPrefix);
    }
  }
  return map;
}
