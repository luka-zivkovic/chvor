import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { Skill, Tool, Capability } from "@chvor/shared";
import { logError } from "./error-logger.ts";
import { parseCapabilityMd, parseDirectorySkill } from "./capability-parser.ts";
import { getInstalledRegistryIds } from "./registry-manager.ts";
import { compareSemver } from "./semver.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BUNDLED_SKILLS_DIR = resolve(__dirname, "../../data/bundled-skills");
const BUNDLED_TOOLS_DIR = resolve(__dirname, "../../data/bundled-tools");
const USER_SKILLS_DIR = process.env.CHVOR_SKILLS_DIR || join(homedir(), ".chvor", "skills");
const USER_TOOLS_DIR = process.env.CHVOR_TOOLS_DIR || join(homedir(), ".chvor", "tools");

let cachedSkills: Skill[] | null = null;
let cachedTools: Tool[] | null = null;
let cachedBundled: Capability[] | null = null;

function scanDir(dir: string, source: "bundled" | "user"): Capability[] {
  if (!existsSync(dir)) return [];
  const capabilities: Capability[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  // Process single .md files (existing behavior)
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const filePath = join(dir, entry.name);
      try {
        const content = readFileSync(filePath, "utf8");
        const capability = parseCapabilityMd(content, filePath, source);
        if (capability) capabilities.push(capability);
      } catch (err) {
        console.warn(`[capability-loader] failed to read ${filePath}:`, err);
        logError("capability_error", err, { filePath });
      }
    }
  }

  // Process directory-based skills (new: directories with SKILL.md entry point)
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      const dirPath = join(dir, entry.name);
      try {
        const skill = parseDirectorySkill(dirPath, source);
        if (skill) capabilities.push(skill);
      } catch (err) {
        console.warn(`[capability-loader] failed to parse dir skill ${dirPath}:`, err);
        logError("capability_error", err, { filePath: dirPath });
      }
    }
  }

  return capabilities;
}

/** Returns bundled capabilities (skills + tools) without dedup. Cached until reloadAll(). */
export function getBundledCapabilities(): Capability[] {
  if (!cachedBundled) {
    cachedBundled = [
      ...scanDir(BUNDLED_SKILLS_DIR, "bundled"),
      ...scanDir(BUNDLED_TOOLS_DIR, "bundled"),
    ];
  }
  return cachedBundled;
}

export function loadAll(force = false): { skills: Skill[]; tools: Tool[] } {
  if (cachedSkills && cachedTools && !force) {
    return { skills: cachedSkills, tools: cachedTools };
  }
  if (force) cachedBundled = null;

  mkdirSync(USER_SKILLS_DIR, { recursive: true });
  mkdirSync(USER_TOOLS_DIR, { recursive: true });

  // Migration: remove AI-created onboarding skills (replaced by bundled chvor-guide)
  for (const legacy of ["getting-started.md", "get-started.md"]) {
    const legacyPath = join(USER_SKILLS_DIR, legacy);
    if (existsSync(legacyPath)) {
      try { unlinkSync(legacyPath); console.log(`[capability-loader] cleaned up legacy ${legacy}`); } catch { /* ignore */ }
    }
  }

  const allCapabilities: Capability[] = [];

  const bundledSkills = scanDir(BUNDLED_SKILLS_DIR, "bundled");
  const bundledTools = scanDir(BUNDLED_TOOLS_DIR, "bundled").map((c) => {
    if (c.kind === "tool") c.builtIn = true;
    return c;
  });
  // Check registry lockfile to attribute source correctly
  let registryIds: Set<string>;
  try {
    registryIds = getInstalledRegistryIds();
  } catch {
    registryIds = new Set();
  }

  const userSkills = scanDir(USER_SKILLS_DIR, "user").map((c) => {
    if (registryIds.has(c.id)) c.source = "registry";
    return c;
  });
  const userTools = scanDir(USER_TOOLS_DIR, "user").map((c) => {
    if (c.kind === "tool") c.builtIn = false;
    if (registryIds.has(c.id)) c.source = "registry";
    return c;
  });

  allCapabilities.push(...bundledSkills, ...bundledTools, ...userSkills, ...userTools);

  // Deduplicate by ID — version-aware for bundled vs registry, priority-based otherwise
  const SOURCE_PRIORITY: Record<string, number> = { bundled: 3, user: 2, registry: 1 };
  const deduped = new Map<string, Capability>();
  for (const cap of allCapabilities) {
    const existing = deduped.get(cap.id);
    if (!existing) {
      deduped.set(cap.id, cap);
      continue;
    }

    // Special case: bundled vs registry — version-based resolution
    // Registry wins if strictly newer; bundled wins on tie or if newer
    if (
      (existing.source === "bundled" && cap.source === "registry") ||
      (existing.source === "registry" && cap.source === "bundled")
    ) {
      const bundled = existing.source === "bundled" ? existing : cap;
      const registry = existing.source === "registry" ? existing : cap;
      const cmp = compareSemver(registry.metadata.version, bundled.metadata.version);
      if (cmp > 0) {
        console.warn(`[capability-loader] "${cap.id}": registry v${registry.metadata.version} overrides bundled v${bundled.metadata.version}`);
        deduped.set(cap.id, registry);
      } else {
        console.warn(`[capability-loader] "${cap.id}": bundled v${bundled.metadata.version} takes precedence over registry v${registry.metadata.version}`);
        deduped.set(cap.id, bundled);
      }
      continue;
    }

    // Default: source priority
    const existingPriority = SOURCE_PRIORITY[existing.source] ?? 0;
    const newPriority = SOURCE_PRIORITY[cap.source] ?? 0;
    if (newPriority > existingPriority) {
      console.warn(`[capability-loader] duplicate "${cap.id}": ${cap.source} overrides ${existing.source}`);
      deduped.set(cap.id, cap);
    } else {
      console.warn(`[capability-loader] duplicate "${cap.id}": ${cap.source} shadowed by ${existing.source}`);
    }
  }
  const dedupedList = Array.from(deduped.values());

  cachedSkills = dedupedList.filter((c): c is Skill => c.kind === "skill");
  cachedTools = dedupedList.filter((c): c is Tool => c.kind === "tool");

  const dupCount = allCapabilities.length - dedupedList.length;
  console.log(
    `[capability-loader] loaded ${cachedSkills.length} skills + ${cachedTools.length} tools` +
      (dupCount > 0 ? ` (${dupCount} duplicate(s) resolved)` : ""),
  );

  return { skills: cachedSkills, tools: cachedTools };
}

export function loadSkills(force = false): Skill[] {
  if (cachedSkills && !force) return cachedSkills;
  return loadAll(force).skills;
}

export function loadTools(force = false): Tool[] {
  if (cachedTools && !force) return cachedTools;
  return loadAll(force).tools;
}

export function getSkill(id: string): Skill | undefined {
  return loadSkills().find((s) => s.id === id);
}

export function getTool(id: string): Tool | undefined {
  return loadTools().find((t) => t.id === id);
}

export function getCapability(id: string): Capability | undefined {
  return getSkill(id) ?? getTool(id);
}

export function reloadAll(): { skills: Skill[]; tools: Tool[] } {
  return loadAll(true);
}

export function reloadSkills(): Skill[] {
  return loadSkills(true);
}

