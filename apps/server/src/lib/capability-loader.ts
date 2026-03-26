import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { Skill, Tool, Capability } from "@chvor/shared";
import { logError } from "./error-logger.ts";
import { parseCapabilityMd } from "./capability-parser.ts";
import { getInstalledRegistryIds } from "./registry-manager.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BUNDLED_SKILLS_DIR = resolve(__dirname, "../../data/bundled-skills");
const BUNDLED_TOOLS_DIR = resolve(__dirname, "../../data/bundled-tools");
const USER_SKILLS_DIR = process.env.CHVOR_SKILLS_DIR || join(homedir(), ".chvor", "skills");
const USER_TOOLS_DIR = process.env.CHVOR_TOOLS_DIR || join(homedir(), ".chvor", "tools");

let cachedSkills: Skill[] | null = null;
let cachedTools: Tool[] | null = null;

function scanDir(dir: string, source: "bundled" | "user"): Capability[] {
  if (!existsSync(dir)) return [];
  const capabilities: Capability[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const content = readFileSync(filePath, "utf8");
      const capability = parseCapabilityMd(content, filePath, source);
      if (capability) capabilities.push(capability);
    } catch (err) {
      console.warn(`[capability-loader] failed to read ${filePath}:`, err);
      logError("capability_error", err, { filePath });
    }
  }
  return capabilities;
}

export function loadAll(force = false): { skills: Skill[]; tools: Tool[] } {
  if (cachedSkills && cachedTools && !force) {
    return { skills: cachedSkills, tools: cachedTools };
  }

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

  cachedSkills = allCapabilities.filter((c): c is Skill => c.kind === "skill");
  cachedTools = allCapabilities.filter((c): c is Tool => c.kind === "tool");

  console.log(
    `[capability-loader] loaded ${cachedSkills.length} skills (${bundledSkills.filter((c) => c.kind === "skill").length} bundled + ${userSkills.filter((c) => c.kind === "skill").length} user) ` +
      `+ ${cachedTools.length} tools (${bundledTools.filter((c) => c.kind === "tool").length} bundled + ${userTools.filter((c) => c.kind === "tool").length} user)`,
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
