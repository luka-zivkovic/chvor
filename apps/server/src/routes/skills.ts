import { Hono } from "hono";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadSkills, getSkill, reloadAll } from "../lib/capability-loader.ts";
import { parseCapabilityMd } from "../lib/capability-parser.ts";
import { isCapabilityEnabled, setCapabilityEnabled, getConfig, setConfig, getInstructionOverride, setInstructionOverride, clearInstructionOverride } from "../db/config-store.ts";

const skills = new Hono();

// GET /api/skills — list all skills
skills.get("/", (c) => {
  try {
    const allSkills = loadSkills().map((s) => ({
      ...s,
      enabled: isCapabilityEnabled("skill", s.id),
      hasOverride: getInstructionOverride("skill", s.id) !== null,
    }));
    return c.json({ data: allSkills });
  } catch (err) {
    console.error("[api] GET /skills error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/skills/reload — force reload from disk
skills.post("/reload", (c) => {
  try {
    const { skills } = reloadAll();
    return c.json({ data: skills });
  } catch (err) {
    console.error("[api] POST /skills/reload error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/skills/:id — single skill detail
skills.get("/:id", (c) => {
  const id = c.req.param("id");
  const skill = getSkill(id);
  if (!skill) return c.json({ error: "not found" }, 404);
  return c.json({ data: { ...skill, enabled: isCapabilityEnabled("skill", skill.id) } });
});

// PATCH /api/skills/:id/toggle — toggle enabled state
skills.patch("/:id/toggle", async (c) => {
  const id = c.req.param("id");
  const skill = getSkill(id);
  if (!skill) return c.json({ error: "not found" }, 404);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : !isCapabilityEnabled("skill", id);
  setCapabilityEnabled("skill", id, enabled);

  return c.json({ data: { id, enabled } });
});

// DELETE /api/skills/:id — delete skill file from disk (reject 403 if bundled)
skills.delete("/:id", (c) => {
  const id = c.req.param("id");
  const skill = getSkill(id);
  if (!skill) return c.json({ error: "not found" }, 404);

  if (skill.source === "bundled") {
    return c.json({ error: "Cannot delete bundled skill" }, 403);
  }

  try {
    unlinkSync(skill.path);
    reloadAll();
    return c.json({ data: { id, deleted: true } });
  } catch (err) {
    console.error("[api] DELETE /skills/:id error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/skills/:id/instructions — get original + override
skills.get("/:id/instructions", (c) => {
  const id = c.req.param("id");
  const skill = getSkill(id);
  if (!skill) return c.json({ error: "not found" }, 404);
  const override = getInstructionOverride("skill", id);
  return c.json({ data: { id, original: skill.instructions, override, hasOverride: override !== null } });
});

// PATCH /api/skills/:id/instructions — save instruction override
skills.patch("/:id/instructions", async (c) => {
  const id = c.req.param("id");
  const skill = getSkill(id);
  if (!skill) return c.json({ error: "not found" }, 404);
  const body = await c.req.json() as { instructions?: string };
  if (typeof body.instructions !== "string") return c.json({ error: "instructions must be a string" }, 400);
  setInstructionOverride("skill", id, body.instructions);
  return c.json({ data: { id, hasOverride: true } });
});

// DELETE /api/skills/:id/instructions — clear instruction override
skills.delete("/:id/instructions", (c) => {
  const id = c.req.param("id");
  const skill = getSkill(id);
  if (!skill) return c.json({ error: "not found" }, 404);
  clearInstructionOverride("skill", id);
  return c.json({ data: { id, hasOverride: false } });
});

// GET /api/skills/:id/export — download raw SKILL.md
skills.get("/:id/export", (c) => {
  const id = c.req.param("id");
  const skill = getSkill(id);
  if (!skill) return c.json({ error: "not found" }, 404);

  try {
    const content = readFileSync(skill.path, "utf-8");
    c.header("Content-Type", "text/markdown");
    c.header("Content-Disposition", `attachment; filename="${id}.md"`);
    return c.body(content);
  } catch (err) {
    console.error("[api] export skill error:", err);
    return c.json({ error: "Failed to read skill file" }, 500);
  }
});

// POST /api/skills/import — import a SKILL.md file
skills.post("/import", async (c) => {
  try {
    const body = await c.req.text();
    if (!body.trim()) {
      return c.json({ error: "Empty skill content" }, 400);
    }
    if (body.length > 100_000) {
      return c.json({ error: "Skill content too large (max 100KB)" }, 400);
    }

    const preview = parseCapabilityMd(body, "import.md", "user");
    if (!preview || preview.kind !== "skill") {
      return c.json({ error: "Invalid SKILL.md format: must be a skill (prompt or workflow type)" }, 400);
    }

    // Derive slug from skill name
    const slug = preview.metadata.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "imported-skill";

    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
      return c.json({ error: "Invalid skill name — cannot derive a safe file name" }, 400);
    }

    // Guard: reject if a bundled skill with the same ID exists
    const existing = getSkill(slug);
    if (existing?.source === "bundled") {
      return c.json({ error: `Cannot import — a bundled skill "${slug}" already exists. Rename the skill.` }, 409);
    }

    const userDir = join(homedir(), ".chvor", "skills");
    mkdirSync(userDir, { recursive: true });
    const filePath = join(userDir, `${slug}.md`);
    writeFileSync(filePath, body, "utf-8");

    const { skills: reloaded } = reloadAll();
    const imported = reloaded.find((s) => s.id === slug);

    if (!imported) {
      return c.json({ error: "Skill written but not found after reload" }, 500);
    }

    return c.json({ data: imported });
  } catch (err) {
    console.error("[api] import skill error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/skills/:id/config — get per-skill config values
skills.get("/:id/config", (c) => {
  const id = c.req.param("id");
  const skill = getSkill(id);
  if (!skill) return c.json({ error: "not found" }, 404);

  const configParams = skill.metadata.config ?? [];
  const values: Record<string, unknown> = {};

  for (const param of configParams) {
    const stored = getConfig(`skill.config.${id}.${param.name}`);
    if (stored !== null) {
      // Coerce to declared type
      if (param.type === "number") values[param.name] = Number(stored);
      else if (param.type === "boolean") values[param.name] = stored === "true";
      else values[param.name] = stored;
    } else if (param.default !== undefined) {
      values[param.name] = param.default;
    }
  }

  return c.json({ data: { params: configParams, values } });
});

// PATCH /api/skills/:id/config — save per-skill config values
skills.patch("/:id/config", async (c) => {
  const id = c.req.param("id");
  const skill = getSkill(id);
  if (!skill) return c.json({ error: "not found" }, 404);

  const body = (await c.req.json()) as Record<string, unknown>;
  const configParams = skill.metadata.config ?? [];
  const validKeys = new Set(configParams.map((p) => p.name));

  for (const [key, value] of Object.entries(body)) {
    if (!validKeys.has(key)) continue;
    setConfig(`skill.config.${id}.${key}`, String(value));
  }

  return c.json({ data: { id, updated: true } });
});

export default skills;
