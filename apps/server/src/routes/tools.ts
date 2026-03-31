import { Hono } from "hono";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadTools, getTool, reloadAll } from "../lib/capability-loader.ts";
import { parseCapabilityMd } from "../lib/capability-parser.ts";
import { isCapabilityEnabled, setCapabilityEnabled, getInstructionOverride, setInstructionOverride, clearInstructionOverride } from "../db/config-store.ts";
import { invalidateToolCache } from "../lib/tool-builder.ts";

const tools = new Hono();

// GET /api/tools — list all tools with enabled flag
tools.get("/", (c) => {
  try {
    const allTools = loadTools().map((t) => ({
      ...t,
      enabled: isCapabilityEnabled("tool", t.id),
      hasOverride: getInstructionOverride("tool", t.id) !== null,
    }));
    return c.json({ data: allTools });
  } catch (err) {
    console.error("[api] GET /tools error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/tools/reload — force reload from disk
tools.post("/reload", (c) => {
  try {
    const { tools: reloaded } = reloadAll();
    return c.json({ data: reloaded });
  } catch (err) {
    console.error("[api] POST /tools/reload error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/tools/:id — single tool detail
tools.get("/:id", (c) => {
  const id = c.req.param("id");
  const tool = getTool(id);
  if (!tool) return c.json({ error: "not found" }, 404);
  return c.json({ data: { ...tool, enabled: isCapabilityEnabled("tool", tool.id) } });
});

// PATCH /api/tools/:id/toggle — toggle enabled state
tools.patch("/:id/toggle", async (c) => {
  const id = c.req.param("id");
  const tool = getTool(id);
  if (!tool) return c.json({ error: "not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const enabled =
    typeof body.enabled === "boolean" ? body.enabled : !isCapabilityEnabled("tool", id);
  setCapabilityEnabled("tool", id, enabled);
  invalidateToolCache();

  return c.json({ data: { id, enabled } });
});

// DELETE /api/tools/:id — delete tool file from disk (reject 403 if builtIn)
tools.delete("/:id", (c) => {
  const id = c.req.param("id");
  const tool = getTool(id);
  if (!tool) return c.json({ error: "not found" }, 404);

  if (tool.builtIn) {
    return c.json({ error: "Cannot delete built-in tool" }, 403);
  }

  try {
    unlinkSync(tool.path);
    reloadAll();
    return c.json({ data: { id, deleted: true } });
  } catch (err) {
    console.error("[api] DELETE /tools/:id error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/tools/:id/instructions — get original + override
tools.get("/:id/instructions", (c) => {
  const id = c.req.param("id");
  const tool = getTool(id);
  if (!tool) return c.json({ error: "not found" }, 404);
  const override = getInstructionOverride("tool", id);
  return c.json({ data: { id, original: tool.instructions, override, hasOverride: override !== null } });
});

// PATCH /api/tools/:id/instructions — save instruction override
tools.patch("/:id/instructions", async (c) => {
  const id = c.req.param("id");
  const tool = getTool(id);
  if (!tool) return c.json({ error: "not found" }, 404);
  const body = await c.req.json() as { instructions?: string };
  if (typeof body.instructions !== "string") return c.json({ error: "instructions must be a string" }, 400);
  setInstructionOverride("tool", id, body.instructions);
  return c.json({ data: { id, hasOverride: true } });
});

// DELETE /api/tools/:id/instructions — clear instruction override
tools.delete("/:id/instructions", (c) => {
  const id = c.req.param("id");
  const tool = getTool(id);
  if (!tool) return c.json({ error: "not found" }, 404);
  clearInstructionOverride("tool", id);
  return c.json({ data: { id, hasOverride: false } });
});

// GET /api/tools/:id/export — download raw .md file
tools.get("/:id/export", (c) => {
  const id = c.req.param("id");
  const tool = getTool(id);
  if (!tool) return c.json({ error: "not found" }, 404);

  try {
    const content = readFileSync(tool.path, "utf-8");
    c.header("Content-Type", "text/markdown");
    c.header("Content-Disposition", `attachment; filename="${id}.md"`);
    return c.body(content);
  } catch (err) {
    console.error("[api] export tool error:", err);
    return c.json({ error: "Failed to read tool file" }, 500);
  }
});

// POST /api/tools/import — upload .md file to ~/.chvor/tools/
tools.post("/import", async (c) => {
  try {
    const body = await c.req.text();
    if (!body.trim()) {
      return c.json({ error: "Empty tool content" }, 400);
    }
    if (body.length > 100_000) {
      return c.json({ error: "Tool content too large (max 100KB)" }, 400);
    }

    const preview = parseCapabilityMd(body, "import.md", "user");
    if (!preview || preview.kind !== "tool") {
      return c.json({ error: "Invalid tool .md format: must have mcp config or type: tool" }, 400);
    }

    // Derive slug from tool name
    const slug =
      preview.metadata.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "imported-tool";

    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
      return c.json({ error: "Invalid tool name — cannot derive a safe file name" }, 400);
    }

    const userDir = join(homedir(), ".chvor", "tools");
    mkdirSync(userDir, { recursive: true });
    const filePath = join(userDir, `${slug}.md`);
    writeFileSync(filePath, body, "utf-8");

    const { tools: reloaded } = reloadAll();
    const imported = reloaded.find((t) => t.id === slug);

    if (!imported) {
      return c.json({ error: "Tool written but not found after reload" }, 500);
    }

    return c.json({ data: imported });
  } catch (err) {
    console.error("[api] import tool error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

export default tools;
