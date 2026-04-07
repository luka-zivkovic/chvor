import { createWriteStream, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, relative, basename, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getDb, closeDb } from "../db/database.ts";
import { getConfig, setConfig } from "../db/config-store.ts";
import AdmZip from "adm-zip";
import type { BackupManifest, BackupInfo, BackupConfig, UpdateBackupConfigRequest } from "@chvor/shared";

// ── Paths ────────────────────────────────────────────────────────

const DATA_DIR = process.env.CHVOR_DATA_DIR ?? resolve(join(import.meta.dirname ?? ".", "../../data"));
const SKILLS_DIR = process.env.CHVOR_SKILLS_DIR ?? join(homedir(), ".chvor", "skills");
const TOOLS_DIR = process.env.CHVOR_TOOLS_DIR ?? join(homedir(), ".chvor", "tools");

export function getBackupDir(): string {
  const configured = getConfig("backup.directory");
  if (configured) return configured;
  // Default: sibling to data dir
  return resolve(DATA_DIR, "..", "backups");
}

// ── Config ───────────────────────────────────────────────────────

export function getBackupConfig(): BackupConfig {
  const parseIntSafe = (raw: string | null, fallback: number): number => {
    if (raw === null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? fallback : n;
  };

  return {
    enabled: (getConfig("backup.enabled") ?? "false") === "true",
    intervalHours: parseIntSafe(getConfig("backup.intervalHours"), 24),
    maxCount: parseIntSafe(getConfig("backup.maxCount"), 10),
    maxAgeDays: parseIntSafe(getConfig("backup.maxAgeDays"), 30),
    directory: getConfig("backup.directory") ?? "",
    lastRunAt: getConfig("backup.lastRunAt") || null,
    lastError: getConfig("backup.lastError") || null,
  };
}

export function updateBackupConfig(updates: UpdateBackupConfigRequest): BackupConfig {
  if (updates.enabled !== undefined) {
    if (typeof updates.enabled !== "boolean") throw new Error("enabled must be a boolean");
    setConfig("backup.enabled", String(updates.enabled));
  }
  if (updates.intervalHours !== undefined) {
    if (typeof updates.intervalHours !== "number" || Number.isNaN(updates.intervalHours)) {
      throw new Error("intervalHours must be a number");
    }
    setConfig("backup.intervalHours", String(Math.max(1, Math.min(720, Math.floor(updates.intervalHours)))));
  }
  if (updates.maxCount !== undefined) {
    if (typeof updates.maxCount !== "number" || Number.isNaN(updates.maxCount)) {
      throw new Error("maxCount must be a number");
    }
    setConfig("backup.maxCount", String(Math.max(1, Math.floor(updates.maxCount))));
  }
  if (updates.maxAgeDays !== undefined) {
    if (typeof updates.maxAgeDays !== "number" || Number.isNaN(updates.maxAgeDays)) {
      throw new Error("maxAgeDays must be a number");
    }
    setConfig("backup.maxAgeDays", String(Math.max(0, Math.floor(updates.maxAgeDays))));
  }
  if (updates.directory !== undefined) {
    if (typeof updates.directory !== "string") throw new Error("directory must be a string");
    const dir = updates.directory.trim();
    if (dir === "") {
      setConfig("backup.directory", "");
    } else {
      if (!isAbsolute(dir)) {
        throw new Error("Backup directory must be an absolute path");
      }
      setConfig("backup.directory", resolve(dir));
    }
  }
  return getBackupConfig();
}

// ── Read package version ─────────────────────────────────────────

function getChvorVersion(): string {
  try {
    const pkgPath = resolve(import.meta.dirname ?? ".", "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── Create Backup ────────────────────────────────────────────────

export async function createBackup(
  source: "manual" | "scheduled" = "manual"
): Promise<BackupInfo> {
  const archiver = (await import("archiver")).default;
  const backupDir = getBackupDir();
  mkdirSync(backupDir, { recursive: true });

  const id = randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `chvor-backup-${timestamp}.chvor-backup`;
  const outPath = join(backupDir, filename);

  // Stage: backup database to temp file
  const tempDir = join(tmpdir(), `chvor-backup-${id}`);
  mkdirSync(tempDir, { recursive: true });
  const tempDbPath = join(tempDir, "chvor.db");

  try {
    // Use SQLite online backup API
    const db = getDb();
    await db.backup(tempDbPath);
    const dbSize = statSync(tempDbPath).size;

    // Count skills and tools
    let skillCount = 0;
    let toolCount = 0;
    if (existsSync(SKILLS_DIR)) {
      skillCount = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md")).length;
    }
    if (existsSync(TOOLS_DIR)) {
      toolCount = readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".md")).length;
    }

    // Build manifest
    const manifest: BackupManifest = {
      version: 1,
      chvorVersion: getChvorVersion(),
      createdAt: new Date().toISOString(),
      source,
      platform: process.platform,
      dbSizeBytes: dbSize,
      skillCount,
      toolCount,
      id,
    };

    // Create ZIP
    const output = createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    const done = new Promise<void>((resolve, reject) => {
      output.on("close", resolve);
      archive.on("error", reject);
    });

    archive.pipe(output);

    const prefix = `chvor-backup-${timestamp}`;
    archive.append(JSON.stringify(manifest, null, 2), { name: `${prefix}/manifest.json` });
    archive.file(tempDbPath, { name: `${prefix}/data/chvor.db` });

    // Encryption key
    const keyPath = join(DATA_DIR, ".encryption-key");
    if (existsSync(keyPath)) {
      archive.file(keyPath, { name: `${prefix}/data/.encryption-key` });
    }

    // Skills directory
    if (existsSync(SKILLS_DIR)) {
      archive.directory(SKILLS_DIR, `${prefix}/skills`);
    }

    // Tools directory
    if (existsSync(TOOLS_DIR)) {
      archive.directory(TOOLS_DIR, `${prefix}/tools`);
    }

    // Config dump (human-readable)
    const configDb = getDb();
    const configs = configDb
      .prepare("SELECT key, value FROM config")
      .all() as Array<{ key: string; value: string }>;
    const configObj: Record<string, string> = {};
    for (const c of configs) configObj[c.key] = c.value;
    archive.append(JSON.stringify(configObj, null, 2), { name: `${prefix}/config.json` });

    await archive.finalize();
    await done;

    const sizeBytes = statSync(outPath).size;

    // Apply retention
    applyRetention();

    return {
      id,
      filename,
      createdAt: manifest.createdAt,
      source,
      sizeBytes,
    };
  } finally {
    // Clean up temp
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── List Backups ─────────────────────────────────────────────────

export function listBackups(): BackupInfo[] {
  const backupDir = getBackupDir();
  if (!existsSync(backupDir)) return [];

  const files = readdirSync(backupDir)
    .filter((f) => f.endsWith(".chvor-backup"))
    .sort()
    .reverse();

  const results: BackupInfo[] = [];
  for (const f of files) {
    const filePath = join(backupDir, f);
    const stat = statSync(filePath);

    // Read manifest from ZIP to get accurate source and createdAt
    let source: "manual" | "scheduled" = "manual";
    let createdAt = stat.mtime.toISOString();
    try {
      const zip = new AdmZip(filePath);
      const manifestEntry = zip.getEntries().find((e: { entryName: string }) => e.entryName.endsWith("/manifest.json"));
      if (manifestEntry) {
        const manifest: BackupManifest = JSON.parse(manifestEntry.getData().toString("utf8"));
        source = manifest.source;
        createdAt = manifest.createdAt;
      }
    } catch {
      // Fall back to filesystem metadata if manifest is unreadable
    }

    results.push({
      id: f,
      filename: f,
      createdAt,
      source,
      sizeBytes: stat.size,
    });
  }

  return results;
}

// ── Safe path resolution (prevents path traversal) ───────────────

function safeBackupPath(id: string): string | null {
  const backupDir = resolve(getBackupDir());
  const filePath = resolve(backupDir, id);
  // Prevent path traversal: resolved path must stay within backupDir
  const rel = relative(backupDir, filePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return filePath;
}

// ── Delete Backup ────────────────────────────────────────────────

export function deleteBackup(id: string): boolean {
  const filePath = safeBackupPath(id);
  if (!filePath || !existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

// ── Get backup file path ─────────────────────────────────────────

export function getBackupPath(id: string): string | null {
  const filePath = safeBackupPath(id);
  if (!filePath || !existsSync(filePath)) return null;
  return filePath;
}

// ── Restore ──────────────────────────────────────────────────────

export async function performRestore(buffer: Buffer): Promise<void> {
  const yauzl = await import("yauzl");

  // Create a pre-restore safety backup
  try {
    await createBackup("manual");
    console.log("[backup] pre-restore safety backup created");
  } catch (err) {
    console.warn("[backup] failed to create pre-restore backup:", err);
  }

  // Extract using yauzl
  const zipfile = await new Promise<import("yauzl").ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err: Error | null, zf: import("yauzl").ZipFile) => {
      if (err) reject(err);
      else resolve(zf);
    });
  });

  const entries: Array<{ name: string; data: Buffer }> = [];
  await new Promise<void>((resolve, reject) => {
    zipfile.readEntry();
    zipfile.on("entry", (entry: import("yauzl").Entry) => {
      if (/\/$/.test(entry.fileName)) {
        // Directory
        zipfile.readEntry();
        return;
      }
      zipfile.openReadStream(entry, (err: Error | null, readStream: import("node:stream").Readable) => {
        if (err) { reject(err); return; }
        const chunks: Buffer[] = [];
        readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        readStream.on("end", () => {
          entries.push({ name: entry.fileName, data: Buffer.concat(chunks) });
          zipfile.readEntry();
        });
        readStream.on("error", reject);
      });
    });
    zipfile.on("end", resolve);
    zipfile.on("error", reject);
  });

  // Find manifest and validate
  const manifestEntry = entries.find((e) => e.name.endsWith("/manifest.json"));
  if (!manifestEntry) throw new Error("Invalid backup: missing manifest.json");

  const manifest: BackupManifest = JSON.parse(manifestEntry.data.toString("utf8"));
  if (manifest.version !== 1) throw new Error(`Unsupported backup version: ${manifest.version}`);

  // Close database and clear singleton so no stale handle is reused
  closeDb();
  console.log("[backup] database closed for restore");

  // Small delay for Windows file lock release
  await new Promise((r) => setTimeout(r, 200));

  // Replace files (with path traversal protection)
  const resolvedSkillsDir = resolve(SKILLS_DIR);
  const resolvedToolsDir = resolve(TOOLS_DIR);

  // Determine if the backup contains skills/tools so we can clean stale files
  const hasSkills = entries.some((e) => {
    const parts = e.name.split("/").slice(1);
    return parts.length > 0 && parts[0] === "skills";
  });
  const hasTools = entries.some((e) => {
    const parts = e.name.split("/").slice(1);
    return parts.length > 0 && parts[0] === "tools";
  });

  // Remove existing skills/tools before restoring to prevent stale files
  if (hasSkills && existsSync(SKILLS_DIR)) {
    rmSync(SKILLS_DIR, { recursive: true, force: true });
    mkdirSync(SKILLS_DIR, { recursive: true });
  }
  if (hasTools && existsSync(TOOLS_DIR)) {
    rmSync(TOOLS_DIR, { recursive: true, force: true });
    mkdirSync(TOOLS_DIR, { recursive: true });
  }

  for (const entry of entries) {
    // Strip the top-level directory prefix
    const parts = entry.name.split("/").slice(1); // remove "chvor-backup-xxx/"
    if (parts.length === 0 || parts[0] === "") continue;

    const relativePath = parts.join("/");

    if (relativePath === "data/chvor.db") {
      writeFileSync(join(DATA_DIR, "chvor.db"), entry.data, { mode: 0o600 });
    } else if (relativePath === "data/.encryption-key") {
      writeFileSync(join(DATA_DIR, ".encryption-key"), entry.data, { mode: 0o600 });
    } else if (relativePath.startsWith("skills/")) {
      const dest = resolve(SKILLS_DIR, relativePath.slice("skills/".length));
      const rel = relative(resolvedSkillsDir, dest);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Invalid path in backup: ${relativePath}`);
      }
      mkdirSync(resolve(dest, ".."), { recursive: true });
      writeFileSync(dest, entry.data);
    } else if (relativePath.startsWith("tools/")) {
      const dest = resolve(TOOLS_DIR, relativePath.slice("tools/".length));
      const rel = relative(resolvedToolsDir, dest);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Invalid path in backup: ${relativePath}`);
      }
      mkdirSync(resolve(dest, ".."), { recursive: true });
      writeFileSync(dest, entry.data);
    }
  }

  console.log("[backup] restore complete — server will restart");
}

// ── Retention ────────────────────────────────────────────────────

export function applyRetention(): void {
  const config = getBackupConfig();
  let backups = listBackups();

  // Age-based: delete anything older than maxAgeDays
  if (config.maxAgeDays > 0) {
    const cutoff = Date.now() - config.maxAgeDays * 86400_000;
    for (const b of backups) {
      if (new Date(b.createdAt).getTime() < cutoff) {
        deleteBackup(b.id);
      }
    }
    backups = listBackups();
  }

  // Count-based: keep only maxCount
  if (config.maxCount > 0 && backups.length > config.maxCount) {
    const excess = backups.length - config.maxCount;
    // Delete oldest first (list is sorted newest first)
    const toDelete = backups.slice(-excess);
    for (const b of toDelete) {
      deleteBackup(b.id);
    }
  }
}
