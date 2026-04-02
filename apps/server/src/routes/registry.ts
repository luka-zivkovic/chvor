import { Hono } from "hono";
import { fetchRegistryIndex, readCachedIndex } from "../lib/registry-client.ts";
import {
  installEntry,
  uninstallEntry,
  checkForUpdates,
  updateEntry,
  updateAll,
  readLock,
  assertSafeEntryId,
} from "../lib/registry-manager.ts";
import { getBundledCapabilities } from "../lib/capability-loader.ts";
import type { RegistryEntry, RegistryEntryKind } from "@chvor/shared";

const registry = new Hono();

// GET /api/registry/search?q=&category=&tags=&kind=
registry.get("/search", async (c) => {
  try {
    const q = c.req.query("q")?.toLowerCase() ?? "";
    const category = c.req.query("category") ?? "";
    const tags = c.req.query("tags")?.split(",").filter(Boolean) ?? [];
    const kind = c.req.query("kind") as RegistryEntryKind | undefined;

    // Try cached first, fallback to fetch
    let index = readCachedIndex();
    if (!index) {
      index = await fetchRegistryIndex();
    }

    let results: RegistryEntry[] = index.entries;

    // Filter by kind
    if (kind) {
      results = results.filter((e) => e.kind === kind);
    }

    if (q) {
      results = results.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.id.toLowerCase().includes(q) ||
          e.tags?.some((t) => t.toLowerCase().includes(q)),
      );
    }

    if (category) {
      results = results.filter((e) => e.category === category);
    }

    if (tags.length > 0) {
      results = results.filter((e) =>
        tags.every((t) => e.tags?.includes(t)),
      );
    }

    // Annotate with install status and bundled info
    const lock = readLock();
    const bundledMap = new Map(
      getBundledCapabilities().map((c) => [c.id, c.metadata.version]),
    );
    const annotated = results.map((e) => ({
      ...e,
      installed: !!lock.installed[e.id],
      installedVersion: lock.installed[e.id]?.version ?? null,
      hasBundledVersion: bundledMap.has(e.id),
      bundledVersion: bundledMap.get(e.id) ?? null,
    }));

    return c.json({ data: annotated });
  } catch (err) {
    console.error("[api] GET /registry/search error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/registry/entry/:id — generic entry detail (works for skills, tools, templates)
registry.get("/entry/:id", async (c) => {
  try {
    const id = c.req.param("id");
    assertSafeEntryId(id);

    let index = readCachedIndex();
    if (!index) {
      index = await fetchRegistryIndex();
    }

    const entry = index.entries.find((e) => e.id === id);
    if (!entry) return c.json({ error: "not found in registry" }, 404);

    const lock = readLock();
    const installInfo = lock.installed[id] ?? null;
    const bundled = getBundledCapabilities().find((c) => c.id === id);

    return c.json({
      data: {
        ...entry,
        installed: !!installInfo,
        installedVersion: installInfo?.version ?? null,
        userModified: installInfo?.userModified ?? false,
        hasBundledVersion: !!bundled,
        bundledVersion: bundled?.metadata.version ?? null,
      },
    });
  } catch (err) {
    console.error("[api] GET /registry/entry error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/registry/skill/:id — single registry entry detail (backward compat)
registry.get("/skill/:id", async (c) => {
  try {
    const id = c.req.param("id");

    let index = readCachedIndex();
    if (!index) {
      index = await fetchRegistryIndex();
    }

    const entry = index.entries.find((e) => e.id === id);
    if (!entry) return c.json({ error: "not found in registry" }, 404);

    const lock = readLock();
    const installInfo = lock.installed[id] ?? null;

    return c.json({
      data: {
        ...entry,
        installed: !!installInfo,
        installedVersion: installInfo?.version ?? null,
        userModified: installInfo?.userModified ?? false,
      },
    });
  } catch (err) {
    console.error("[api] GET /registry/skill error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/registry/install — install an entry from registry
registry.post("/install", async (c) => {
  try {
    const body = (await c.req.json()) as { id?: string; kind?: RegistryEntryKind; skillId?: string };
    const entryId = body.id ?? body.skillId;
    if (!entryId) {
      return c.json({ error: "id (or skillId) is required" }, 400);
    }
    assertSafeEntryId(entryId);

    const result = await installEntry(entryId, body.kind);
    return c.json({
      data: {
        entry: result.installed,
        // backward compat
        skill: result.installed,
        dependencies: result.dependencies,
        failedDependencies: result.failedDependencies,
      },
    });
  } catch (err) {
    console.error("[api] POST /registry/install error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// DELETE /api/registry/entry/:id — uninstall a registry entry (generic)
registry.delete("/entry/:id", async (c) => {
  try {
    const id = c.req.param("id");
    assertSafeEntryId(id);
    const lock = readLock();
    const wasShadowingBundled = lock.installed[id]?.shadowsBundled ?? false;
    await uninstallEntry(id);
    return c.json({ data: { id, uninstalled: true, restoredBundled: wasShadowingBundled } });
  } catch (err) {
    console.error("[api] DELETE /registry/entry error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// DELETE /api/registry/skill/:id — uninstall a registry skill (backward compat)
registry.delete("/skill/:id", async (c) => {
  try {
    const id = c.req.param("id");
    assertSafeEntryId(id);
    await uninstallEntry(id);
    return c.json({ data: { id, uninstalled: true } });
  } catch (err) {
    console.error("[api] DELETE /registry/skill error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/registry/updates — check for available updates
registry.get("/updates", async (c) => {
  try {
    const updates = await checkForUpdates();
    return c.json({ data: updates });
  } catch (err) {
    console.error("[api] GET /registry/updates error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/registry/update — apply update(s)
registry.post("/update", async (c) => {
  try {
    const body = (await c.req.json()) as {
      id?: string;
      skillId?: string;
      all?: boolean;
      force?: boolean;
    };

    if (body.all) {
      const results = await updateAll(body.force);
      return c.json({ data: results });
    }

    const entryId = body.id ?? body.skillId;
    if (!entryId) {
      return c.json({ error: "id (or skillId) or all:true is required" }, 400);
    }
    assertSafeEntryId(entryId);

    const result = await updateEntry(entryId, body.force);
    return c.json({ data: { id: entryId, ...result } });
  } catch (err) {
    console.error("[api] POST /registry/update error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/registry/refresh — re-fetch index.json
registry.post("/refresh", async (c) => {
  try {
    const lock = readLock();
    const index = await fetchRegistryIndex(lock.registryUrl);
    return c.json({ data: { entryCount: index.entries.length, skillCount: index.entries.length, updatedAt: index.updatedAt } });
  } catch (err) {
    console.error("[api] POST /registry/refresh error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

export default registry;
