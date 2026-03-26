import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { RegistryLock, InstalledRegistryEntry, RegistryEntryKind, RegistryEntry, Skill, Tool, Capability, TemplateManifest } from "@chvor/shared";
import { fetchRegistryIndex, fetchEntryContent, computeSha256, getDefaultRegistryUrl } from "./registry-client.ts";
import { reloadAll } from "./capability-loader.ts";
import { getPersona, updatePersona } from "../db/config-store.ts";
import { createSchedule, deleteSchedule } from "../db/schedule-store.ts";
import { getOrCreateDefault, saveWorkspace } from "../db/workspace-store.ts";

const USER_SKILLS_DIR = process.env.CHVOR_SKILLS_DIR || join(homedir(), ".chvor", "skills");
const USER_TOOLS_DIR = process.env.CHVOR_TOOLS_DIR || join(homedir(), ".chvor", "tools");
const USER_TEMPLATES_DIR = process.env.CHVOR_TEMPLATES_DIR || join(homedir(), ".chvor", "templates");

const SAFE_ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function getDirForKind(kind: RegistryEntryKind): string {
  switch (kind) {
    case "skill": return USER_SKILLS_DIR;
    case "tool": return USER_TOOLS_DIR;
    case "template": return USER_TEMPLATES_DIR;
    default: throw new Error(`Unsupported entry kind for install: "${kind}"`);
  }
}

function getExtForKind(kind: RegistryEntryKind): string {
  return kind === "template" ? "yaml" : "md";
}

/** Validates that an entry ID is safe for use as a filename (no path traversal). */
export function assertSafeEntryId(id: string): void {
  if (!id || id.length > 100 || !SAFE_ENTRY_ID_RE.test(id)) {
    throw new Error(`Invalid entry ID: "${id}" — must be lowercase alphanumeric with hyphens/underscores only`);
  }
}

/** @deprecated Use assertSafeEntryId */
export const assertSafeSkillId = assertSafeEntryId;

function getLockPath(): string {
  const dataDir = process.env.CHVOR_DATA_DIR || join(homedir(), ".chvor", "data");
  return join(dataDir, "registry-lock.json");
}

export function readLock(): RegistryLock {
  const lockPath = getLockPath();
  if (!existsSync(lockPath)) {
    return {
      installed: {},
      registryUrl: getDefaultRegistryUrl(),
      lastChecked: "",
    };
  }
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as RegistryLock;
  } catch {
    return {
      installed: {},
      registryUrl: getDefaultRegistryUrl(),
      lastChecked: "",
    };
  }
}

export function writeLock(lock: RegistryLock): void {
  const lockPath = getLockPath();
  const tmpPath = lockPath + ".tmp";
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(lock, null, 2), "utf8");
  renameSync(tmpPath, lockPath);
}

/** Get the set of installed registry entry IDs */
export function getInstalledRegistryIds(): Set<string> {
  return new Set(Object.keys(readLock().installed));
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Runtime validation of a parsed template manifest.
 * Ensures all fields have the expected types before provisioning.
 */
function validateManifest(entryId: string, raw: unknown): TemplateManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid template manifest for "${entryId}": expected an object`);
  }
  const obj = raw as Record<string, unknown>;

  // Required string fields
  for (const field of ["name", "description", "version"] as const) {
    if (typeof obj[field] !== "string" || !(obj[field] as string).trim()) {
      throw new Error(`Invalid template manifest for "${entryId}": "${field}" must be a non-empty string`);
    }
  }

  // Optional string fields
  for (const field of ["author", "icon"] as const) {
    if (obj[field] !== undefined && typeof obj[field] !== "string") {
      throw new Error(`Invalid template manifest for "${entryId}": "${field}" must be a string`);
    }
  }

  // Optional string array
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || !obj.tags.every((t: unknown) => typeof t === "string")) {
      throw new Error(`Invalid template manifest for "${entryId}": "tags" must be an array of strings`);
    }
  }

  // Validate persona if present
  if (obj.persona !== undefined) {
    if (typeof obj.persona !== "object" || obj.persona === null) {
      throw new Error(`Invalid template manifest for "${entryId}": "persona" must be an object`);
    }
    const persona = obj.persona as Record<string, unknown>;
    for (const field of ["profile", "directives", "aiName", "tone", "boundaries"] as const) {
      if (persona[field] !== undefined && typeof persona[field] !== "string") {
        throw new Error(`Invalid template manifest for "${entryId}": "persona.${field}" must be a string`);
      }
    }
  }

  // Validate schedules if present
  if (obj.schedules !== undefined) {
    if (!Array.isArray(obj.schedules)) {
      throw new Error(`Invalid template manifest for "${entryId}": "schedules" must be an array`);
    }
    for (let i = 0; i < obj.schedules.length; i++) {
      const s = obj.schedules[i] as Record<string, unknown>;
      if (!s || typeof s !== "object") {
        throw new Error(`Invalid template manifest for "${entryId}": schedules[${i}] must be an object`);
      }
      if (typeof s.name !== "string" || !s.name.trim()) {
        throw new Error(`Invalid template manifest for "${entryId}": schedules[${i}].name must be a non-empty string`);
      }
      if (typeof s.cronExpression !== "string" || !s.cronExpression.trim()) {
        throw new Error(`Invalid template manifest for "${entryId}": schedules[${i}].cronExpression must be a non-empty string`);
      }
      if (typeof s.prompt !== "string" || !s.prompt.trim()) {
        throw new Error(`Invalid template manifest for "${entryId}": schedules[${i}].prompt must be a non-empty string`);
      }
      if (s.oneShot !== undefined && typeof s.oneShot !== "boolean") {
        throw new Error(`Invalid template manifest for "${entryId}": schedules[${i}].oneShot must be a boolean`);
      }
    }
  }

  // Validate pipeline if present
  if (obj.pipeline !== undefined) {
    if (typeof obj.pipeline !== "object" || obj.pipeline === null) {
      throw new Error(`Invalid template manifest for "${entryId}": "pipeline" must be an object`);
    }
    const p = obj.pipeline as Record<string, unknown>;
    if (!Array.isArray(p.nodes)) {
      throw new Error(`Invalid template manifest for "${entryId}": "pipeline.nodes" must be an array`);
    }
    if (!Array.isArray(p.edges)) {
      throw new Error(`Invalid template manifest for "${entryId}": "pipeline.edges" must be an array`);
    }
  }

  return raw as TemplateManifest;
}

/**
 * Install a template from the registry.
 * Downloads the template YAML, installs included skills/tools, and provisions
 * persona, schedules, and pipelines.
 *
 * Security: Schedules are created in a disabled state so the user can review
 * prompt content before enabling. Persona changes are backed up so uninstall
 * can restore them.
 */
async function installTemplate(
  entryId: string,
  entry: RegistryEntry,
  registryUrl: string,
  lock: RegistryLock,
  installing: Set<string>,
): Promise<{ installed: Capability; dependencies: string[]; failedDependencies: string[] }> {
  // Download template YAML and verify integrity
  const content = await fetchEntryContent(registryUrl, "template", entryId);
  const sha256 = computeSha256(content);
  if (entry.sha256 && sha256 !== entry.sha256) {
    throw new Error(
      `Integrity check failed for "${entryId}": expected sha256 ${entry.sha256}, got ${sha256}`,
    );
  }

  // Parse and validate manifest with runtime checks
  const raw = parseYaml(content);
  const manifest = validateManifest(entryId, raw);

  // Write template YAML to templates directory
  const dir = getDirForKind("template");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${entryId}.yaml`);
  writeFileSync(filePath, content, "utf8");

  // Snapshot current persona before any changes (for undo on uninstall)
  let previousPersona: Record<string, unknown> | undefined;
  if (manifest.persona) {
    try {
      previousPersona = getPersona() as unknown as Record<string, unknown>;
    } catch {
      // First run, no persona to snapshot
    }
  }

  // Track provisioned resource IDs for cascading uninstall
  const provisionedScheduleIds: string[] = [];
  let provisionedPipelineId: string | undefined;

  // Install included skills/tools
  const includes = entry.includes ?? [];
  const installedIncludes: string[] = [];
  const failedIncludes: string[] = [];
  for (const includedId of includes) {
    if (!lock.installed[includedId]) {
      try {
        await installEntry(includedId, undefined, installing);
        installedIncludes.push(includedId);
      } catch (err) {
        console.warn(`[registry-manager] failed to install included entry "${includedId}":`, err);
        failedIncludes.push(includedId);
      }
    }
  }

  // Provision: apply persona (with backup stored in lockfile)
  if (manifest.persona) {
    try {
      updatePersona(manifest.persona);
    } catch (err) {
      console.warn("[registry-manager] failed to apply template persona:", err);
    }
  }

  // Provision: create schedules (disabled by default — user must review prompts and enable)
  if (manifest.schedules?.length) {
    const workspace = getOrCreateDefault("constellation");
    const workspaceId = workspace.id;

    for (const schedule of manifest.schedules) {
      try {
        const created = createSchedule({
          name: schedule.name,
          cronExpression: schedule.cronExpression,
          prompt: schedule.prompt,
          workspaceId,
          oneShot: schedule.oneShot,
          enabled: false,
        });
        provisionedScheduleIds.push(created.id);
      } catch (err) {
        console.warn(`[registry-manager] failed to create schedule "${schedule.name}":`, err);
      }
    }
  }

  // Provision: create pipeline
  if (manifest.pipeline) {
    try {
      provisionedPipelineId = `template-${entryId}-pipeline`;
      saveWorkspace(provisionedPipelineId, {
        nodes: manifest.pipeline.nodes,
        edges: manifest.pipeline.edges,
        viewport: { x: 0, y: 0, zoom: 1 },
        settings: { maxRetries: 3, timeoutMs: 30000 },
      });
    } catch (err) {
      console.warn("[registry-manager] failed to create template pipeline:", err);
      provisionedPipelineId = undefined;
    }
  }

  // Update lockfile with template entry and provisioning metadata
  lock.installed[entryId] = {
    kind: "template",
    version: entry.version,
    installedAt: new Date().toISOString(),
    sha256,
    source: "registry",
    userModified: false,
    includedEntries: installedIncludes.length > 0 ? installedIncludes : undefined,
    provisionedScheduleIds: provisionedScheduleIds.length > 0 ? provisionedScheduleIds : undefined,
    provisionedPipelineId,
    previousPersona,
  };
  lock.lastChecked = new Date().toISOString();
  writeLock(lock);

  // Reload capabilities so any new skills/tools are available
  reloadAll();

  // Return a synthetic Capability so the API response stays compatible
  // Note: kind is set to "skill" because Capability = Skill | Tool (no template variant yet)
  const installed: Capability = {
    id: entryId,
    kind: "skill",
    skillType: "prompt",
    metadata: {
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      author: manifest.author,
      tags: manifest.tags,
    },
    instructions: `[Template] ${manifest.description}`,
    source: "registry",
    path: filePath,
  };

  return {
    installed,
    dependencies: includes,
    failedDependencies: failedIncludes,
  };
}

/**
 * Install an entry (skill, tool, or template) from the registry.
 * If kind is not specified, auto-detects from the registry index.
 */
export async function installEntry(
  entryId: string,
  kind?: RegistryEntryKind,
  installing = new Set<string>(),
): Promise<{ installed: Capability; dependencies: string[]; failedDependencies: string[] }> {
  assertSafeEntryId(entryId);
  if (installing.has(entryId)) {
    throw new Error(`Circular dependency detected: ${entryId}`);
  }
  installing.add(entryId);

  const lock = readLock();
  const registryUrl = lock.registryUrl || getDefaultRegistryUrl();

  // Fetch registry index to get metadata
  const index = await fetchRegistryIndex(registryUrl);
  const entry = index.entries.find((e) => e.id === entryId);
  if (!entry) {
    throw new Error(`Entry "${entryId}" not found in registry`);
  }

  const resolvedKind = kind ?? entry.kind ?? "skill";
  if (resolvedKind === "template") {
    return installTemplate(entryId, entry, registryUrl, lock, installing);
  }

  // Download content and verify integrity
  const content = await fetchEntryContent(registryUrl, resolvedKind, entryId);
  const sha256 = computeSha256(content);
  if (entry.sha256 && sha256 !== entry.sha256) {
    throw new Error(
      `Integrity check failed for "${entryId}": expected sha256 ${entry.sha256}, got ${sha256}`,
    );
  }

  // Write to appropriate dir
  const dir = getDirForKind(resolvedKind);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${entryId}.md`);
  writeFileSync(filePath, content, "utf8");

  // Update lockfile
  lock.installed[entryId] = {
    kind: resolvedKind,
    version: entry.version,
    installedAt: new Date().toISOString(),
    sha256,
    source: "registry",
    userModified: false,
  };
  lock.lastChecked = new Date().toISOString();
  writeLock(lock);

  // Reload capabilities
  const { skills, tools } = reloadAll();
  const installed: Capability | undefined =
    resolvedKind === "skill"
      ? skills.find((s) => s.id === entryId)
      : tools.find((t) => t.id === entryId);
  if (!installed) {
    throw new Error(`Entry "${entryId}" installed but not found after reload`);
  }

  // Install dependencies
  const deps = entry.dependencies ?? [];
  const failedDependencies: string[] = [];
  for (const dep of deps) {
    if (!lock.installed[dep]) {
      try {
        await installEntry(dep, undefined, installing);
      } catch (err) {
        console.warn(`[registry-manager] failed to install dependency "${dep}":`, err);
        failedDependencies.push(dep);
      }
    }
  }

  return { installed, dependencies: deps, failedDependencies };
}

/** @deprecated Use installEntry */
export async function installSkill(
  skillId: string,
  installing = new Set<string>(),
): Promise<{ installed: Skill; dependencies: string[]; failedDependencies: string[] }> {
  const result = await installEntry(skillId, "skill", installing);
  return { ...result, installed: result.installed as Skill };
}

/**
 * Uninstall an entry installed from the registry.
 * Reads kind from lockfile to delete from correct directory.
 * For templates: cascading-removes provisioned schedules, restores persona,
 * and removes included skills/tools that were installed by the template.
 */
export async function uninstallEntry(entryId: string): Promise<void> {
  assertSafeEntryId(entryId);
  const lock = readLock();
  const info = lock.installed[entryId];
  if (!info) {
    throw new Error(`"${entryId}" is not installed from registry`);
  }

  // For templates: clean up provisioned resources
  if (info.kind === "template") {
    // Remove provisioned schedules
    if (info.provisionedScheduleIds?.length) {
      for (const scheduleId of info.provisionedScheduleIds) {
        try {
          deleteSchedule(scheduleId);
        } catch (err) {
          console.warn(`[registry-manager] failed to delete schedule "${scheduleId}":`, err);
        }
      }
    }

    // Restore persona if we have a backup
    if (info.previousPersona) {
      try {
        updatePersona(info.previousPersona as Parameters<typeof updatePersona>[0]);
      } catch (err) {
        console.warn("[registry-manager] failed to restore previous persona:", err);
      }
    }

    // Remove included skills/tools that were installed by this template
    if (info.includedEntries?.length) {
      for (const includedId of info.includedEntries) {
        if (lock.installed[includedId]) {
          try {
            const includedDir = getDirForKind(lock.installed[includedId].kind);
            const includedExt = getExtForKind(lock.installed[includedId].kind);
            const includedPath = join(includedDir, `${includedId}.${includedExt}`);
            if (existsSync(includedPath)) {
              unlinkSync(includedPath);
            }
            delete lock.installed[includedId];
          } catch (err) {
            console.warn(`[registry-manager] failed to remove included entry "${includedId}":`, err);
          }
        }
      }
    }

    // Note: pipeline workspace is not deleted because no deleteWorkspace exists.
    // The workspace becomes inert once the template is removed.
  }

  // Remove file from the correct directory
  const dir = getDirForKind(info.kind);
  const ext = getExtForKind(info.kind);
  const filePath = join(dir, `${entryId}.${ext}`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }

  // Remove from lockfile
  delete lock.installed[entryId];
  writeLock(lock);

  // Reload
  reloadAll();
}

/** @deprecated Use uninstallEntry */
export async function uninstallSkill(skillId: string): Promise<void> {
  return uninstallEntry(skillId);
}

export interface UpdateInfo {
  id: string;
  kind: RegistryEntryKind;
  current: string;
  available: string;
  userModified: boolean;
}

export async function checkForUpdates(): Promise<UpdateInfo[]> {
  const lock = readLock();
  const registryUrl = lock.registryUrl || getDefaultRegistryUrl();

  const index = await fetchRegistryIndex(registryUrl);
  const updates: UpdateInfo[] = [];

  for (const [id, info] of Object.entries(lock.installed)) {
    const entry = index.entries.find((e) => e.id === id);
    if (!entry) continue;

    // Check if file was modified by user
    const dir = getDirForKind(info.kind);
    const ext = getExtForKind(info.kind);
    const filePath = join(dir, `${id}.${ext}`);
    let userModified = info.userModified;
    if (existsSync(filePath)) {
      const currentSha = computeSha256(readFileSync(filePath, "utf8"));
      if (currentSha !== info.sha256) {
        userModified = true;
        lock.installed[id].userModified = true;
      }
    }

    if (compareSemver(entry.version, info.version) > 0) {
      updates.push({
        id,
        kind: info.kind,
        current: info.version,
        available: entry.version,
        userModified,
      });
    }
  }

  lock.lastChecked = new Date().toISOString();
  writeLock(lock);

  return updates;
}

export async function updateEntry(
  entryId: string,
  force = false,
): Promise<{ updated: boolean; conflict: boolean }> {
  assertSafeEntryId(entryId);
  const lock = readLock();
  const info = lock.installed[entryId];
  if (!info) {
    throw new Error(`"${entryId}" is not installed from registry`);
  }

  // For templates, uninstall then reinstall to properly re-provision resources
  if (info.kind === "template") {
    await uninstallEntry(entryId);
    try {
      await installEntry(entryId, "template");
      return { updated: true, conflict: false };
    } catch (err) {
      // Reinstall failed — entry is now uninstalled
      throw new Error(`Template update failed for "${entryId}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Check user modification
  const dir = getDirForKind(info.kind);
  const ext = getExtForKind(info.kind);
  const filePath = join(dir, `${entryId}.${ext}`);
  if (existsSync(filePath) && !force) {
    const currentSha = computeSha256(readFileSync(filePath, "utf8"));
    if (currentSha !== info.sha256) {
      return { updated: false, conflict: true };
    }
  }

  const registryUrl = lock.registryUrl || getDefaultRegistryUrl();

  // Get version from index
  const index = await fetchRegistryIndex(registryUrl);
  const entry = index.entries.find((e) => e.id === entryId);

  const content = await fetchEntryContent(registryUrl, info.kind, entryId);
  const sha256 = computeSha256(content);

  // Verify integrity against registry index
  if (entry?.sha256 && sha256 !== entry.sha256) {
    throw new Error(
      `Integrity check failed for "${entryId}": expected sha256 ${entry.sha256}, got ${sha256}`,
    );
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, "utf8");

  lock.installed[entryId] = {
    kind: entry?.kind ?? info.kind ?? "skill",
    version: entry?.version ?? info.version,
    installedAt: info.installedAt,
    sha256,
    source: "registry",
    userModified: false,
  };
  writeLock(lock);

  reloadAll();
  return { updated: true, conflict: false };
}

/** @deprecated Use updateEntry */
export async function updateSkill(
  skillId: string,
  force = false,
): Promise<{ updated: boolean; conflict: boolean }> {
  return updateEntry(skillId, force);
}

export async function updateAll(
  force = false,
): Promise<Array<{ id: string; updated: boolean; conflict: boolean }>> {
  const updates = await checkForUpdates();
  const results: Array<{ id: string; updated: boolean; conflict: boolean }> = [];

  for (const update of updates) {
    try {
      const result = await updateEntry(update.id, force);
      results.push({ id: update.id, ...result });
    } catch (err) {
      console.warn(`[registry-manager] failed to update "${update.id}":`, err);
      results.push({ id: update.id, updated: false, conflict: false });
    }
  }

  return results;
}
