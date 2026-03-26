import { Hono } from "hono";
import type { ModelRole } from "@chvor/shared";
import type { RoleFallbackEntry } from "@chvor/shared";
import {
  getAllRoleConfigs,
  setRoleConfig,
  clearRoleConfig,
  getEmbeddingPreference,
  setEmbeddingPreference,
  getAllRoleFallbacks,
  setRoleFallbacks,
} from "../db/config-store.ts";
import { getDb, isVecAvailable } from "../db/database.ts";
import { resolveRoleConfig } from "../lib/llm-router.ts";
import { reinitEmbedder, isEmbedderAvailable, getActiveProviderId, getLocalModelProgress, getLocalModelStatus, startLocalModelDownload } from "../lib/embedder.ts";
import { EMBEDDING_PROVIDERS, LLM_PROVIDERS } from "../lib/provider-registry.ts";
import { getWSInstance } from "../gateway/ws-instance.ts";

const modelsConfig = new Hono();

const VALID_ROLES: ModelRole[] = ["primary", "reasoning", "lightweight", "heartbeat"];

// ── GET /api/config/models ───────────────────────────────────────

modelsConfig.get("/", (c) => {
  const roles = getAllRoleConfigs();
  const embedding = getEmbeddingPreference();
  const fallbacks = getAllRoleFallbacks();

  // Compute effective defaults for each non-primary role
  const defaults: Record<string, { providerId: string; model: string } | null> = {};
  for (const role of VALID_ROLES) {
    if (role === "primary") continue;
    try {
      const resolved = resolveRoleConfig(role);
      defaults[role] = { providerId: resolved.providerId, model: resolved.model };
    } catch {
      defaults[role] = null;
    }
  }

  return c.json({
    data: { roles, embedding, defaults, fallbacks },
  });
});

// ── PATCH /api/config/models ─────────────────────────────────────

modelsConfig.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as {
      role?: string;
      providerId?: string | null;
      model?: string | null;
      fallbacks?: RoleFallbackEntry[];
      embedding?: { providerId: string; model: string };
    };

    // Handle role update
    if (body.role) {
      if (!VALID_ROLES.includes(body.role as ModelRole)) {
        return c.json({ error: `Invalid role: ${body.role}` }, 400);
      }
      const role = body.role as ModelRole;

      // Handle fallback chain update
      if (body.fallbacks !== undefined) {
        if (!Array.isArray(body.fallbacks)) {
          return c.json({ error: "fallbacks must be an array" }, 400);
        }
        const validProviderIds = new Set(LLM_PROVIDERS.map((p) => p.id));
        for (const fb of body.fallbacks) {
          if (!fb.providerId || !fb.model?.trim()) {
            return c.json({ error: "Each fallback must have a non-empty providerId and model" }, 400);
          }
          if (!validProviderIds.has(fb.providerId)) {
            return c.json({ error: `Unknown provider in fallback: ${fb.providerId}` }, 400);
          }
        }
        setRoleFallbacks(role, body.fallbacks);
      }

      // Clear role config (revert to default)
      if (body.providerId === null || body.model === null) {
        if (role === "primary") {
          return c.json({ error: "Cannot clear primary role" }, 400);
        }
        clearRoleConfig(role);
      } else if (body.providerId && body.model) {
        setRoleConfig(role, body.providerId, body.model);
      } else if (body.fallbacks === undefined) {
        // Only require providerId/model if not just updating fallbacks
        return c.json({ error: "providerId and model are required" }, 400);
      }
    }

    // Handle embedding update
    if (body.embedding) {
      const { providerId, model } = body.embedding;
      if (!providerId || !model) {
        return c.json({ error: "embedding.providerId and embedding.model are required" }, 400);
      }
      // Look up dimensions from registry
      const providerDef = EMBEDDING_PROVIDERS.find((p) => p.id === providerId);
      const modelDef = providerDef?.models.find((m) => m.id === model);
      if (!modelDef) {
        return c.json({ error: `Unknown embedding model: ${providerId}/${model}` }, 400);
      }
      setEmbeddingPreference({ providerId, model, dimensions: modelDef.dimensions });
      // Re-initialize the embedder with new config
      await reinitEmbedder();
    }

    // Return updated state (include defaults so client stays in sync)
    const roles = getAllRoleConfigs();
    const embedding = getEmbeddingPreference();
    const fallbacks = getAllRoleFallbacks();
    const defaults: Record<string, { providerId: string; model: string } | null> = {};
    for (const r of VALID_ROLES) {
      if (r === "primary") continue;
      try {
        const resolved = resolveRoleConfig(r);
        defaults[r] = { providerId: resolved.providerId, model: resolved.model };
      } catch {
        defaults[r] = null;
      }
    }
    return c.json({ data: { roles, embedding, defaults, fallbacks } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── POST /api/config/embedding/reembed ───────────────────────────

let reembedStatus: { status: "idle" | "running"; done: number; total: number } = {
  status: "idle",
  done: 0,
  total: 0,
};

modelsConfig.post("/embedding/reembed", async (c) => {
  if (reembedStatus.status === "running") {
    return c.json({ error: "Re-embedding already in progress" }, 409);
  }

  const config = getEmbeddingPreference();
  const db = getDb();

  // Count memories to re-embed
  const countRow = db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number };
  const total = countRow.cnt;

  if (total === 0) {
    return c.json({ data: { total: 0 } });
  }

  reembedStatus = { status: "running", done: 0, total };

  // Fire-and-forget the re-embed process
  (async () => {
    try {
      // Validate dimensions before SQL interpolation
      const dims = Number(config.dimensions);
      if (!Number.isInteger(dims) || dims <= 0 || dims > 10000) {
        console.error(`[reembed] invalid dimensions: ${config.dimensions}`);
        reembedStatus = { status: "idle", done: 0, total: 0 };
        return;
      }

      // 1. Drop and recreate memory_vec with new dimensions + clear embeddings (transactional)
      db.exec("BEGIN");
      try {
        if (isVecAvailable()) {
          db.exec("DROP TABLE IF EXISTS memory_vec");
          db.exec(`
            CREATE VIRTUAL TABLE memory_vec USING vec0(
              id TEXT PRIMARY KEY,
              embedding float[${dims}]
            )
          `);
        }
        db.exec("UPDATE memories SET embedding = NULL");
        db.exec("COMMIT");
      } catch (txErr) {
        db.exec("ROLLBACK");
        throw txErr;
      }

      // 3. Re-initialize embedder
      await reinitEmbedder();

      // 4. Backfill with progress tracking
      const { isEmbedderAvailable } = await import("../lib/embedder.ts");
      const { embedAndStoreVector, getUnembeddedMemoryIds } = await import("../db/memory-store.ts");

      if (!isEmbedderAvailable()) {
        console.error("[reembed] embedder not available after reinit");
        reembedStatus = { status: "idle", done: 0, total };
        return;
      }

      const unembedded = getUnembeddedMemoryIds();
      for (const { id, content } of unembedded) {
        try {
          await embedAndStoreVector(id, content);
          reembedStatus.done++;
          // Broadcast progress every 10 items
          if (reembedStatus.done % 10 === 0) {
            const ws = getWSInstance();
            ws?.broadcast({
              type: "embedding.progress",
              data: { done: reembedStatus.done, total: reembedStatus.total },
            } as any);
          }
        } catch (err) {
          console.warn(`[reembed] failed for ${id}:`, (err as Error).message);
        }
      }

      // Final broadcast
      const ws = getWSInstance();
      ws?.broadcast({
        type: "embedding.progress",
        data: { done: reembedStatus.done, total: reembedStatus.total },
      } as any);

      console.log(`[reembed] complete: ${reembedStatus.done}/${reembedStatus.total}`);
    } catch (err) {
      console.error("[reembed] failed:", err);
    } finally {
      reembedStatus = { status: "idle", done: 0, total: 0 };
    }
  })();

  return c.json({ data: { total } });
});

// ── GET /api/config/embedding/status ─────────────────────────────

modelsConfig.get("/embedding/status", (c) => {
  return c.json({
    data: {
      status: reembedStatus.status,
      progress: { done: reembedStatus.done, total: reembedStatus.total },
    },
  });
});

// ── GET /api/config/models/embedding/health ──────────────────────

modelsConfig.get("/embedding/health", (c) => {
  return c.json({
    data: {
      embedderAvailable: isEmbedderAvailable(),
      activeProvider: getActiveProviderId(),
      vecAvailable: isVecAvailable(),
    },
  });
});

// ── GET /api/config/models/embedding/model-status ────────────────

modelsConfig.get("/embedding/model-status", (c) => {
  return c.json({ data: getLocalModelProgress() });
});

// ── POST /api/config/models/embedding/download ───────────────────

modelsConfig.post("/embedding/download", async (c) => {
  const status = getLocalModelStatus();
  if (status === "ready") {
    return c.json({ ok: true, status: "ready" });
  }
  if (status === "downloading") {
    return c.json({ ok: true, status: "downloading" });
  }

  // Fire-and-forget — client polls model-status for progress
  startLocalModelDownload()
    .then(async () => {
      // After successful download, trigger backfill
      const { backfillEmbeddings } = await import("../lib/embedding-backfill.ts");
      await backfillEmbeddings();
    })
    .catch((err) => {
      console.error("[embedder] model download failed:", err);
    });

  return c.json({ ok: true, status: "downloading" });
});

export default modelsConfig;
