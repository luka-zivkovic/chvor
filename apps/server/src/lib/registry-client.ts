import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { RegistryIndex, RegistryEntryKind } from "@chvor/shared";

const DEFAULT_REGISTRY_URL = "https://registry.chvor.ai/v1";

const FETCH_TIMEOUT_MS = 8_000;

/** Validates that a registry URL uses HTTPS (or localhost for development). */
function assertValidRegistryUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid registry URL: "${url}"`);
  }
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error(`Registry URL must use HTTPS (got ${parsed.protocol}). HTTP is only allowed for localhost.`);
  }
}

/** Runtime validation of the registry index JSON shape. */
function validateRegistryIndex(data: unknown): RegistryIndex {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid registry index: expected JSON object");
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.version !== "number") {
    throw new Error("Invalid registry index: missing or invalid 'version' field");
  }
  if (typeof obj.updatedAt !== "string") {
    throw new Error("Invalid registry index: missing or invalid 'updatedAt' field");
  }
  if (!Array.isArray(obj.entries)) {
    throw new Error("Invalid registry index: missing or invalid 'entries' array");
  }
  for (const entry of obj.entries) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Invalid registry entry: expected object");
    }
    const e = entry as Record<string, unknown>;
    for (const field of ["id", "name", "description", "version", "sha256"]) {
      if (typeof e[field] !== "string" || !(e[field] as string).length) {
        throw new Error(`Invalid registry entry: missing or empty '${field}' in entry "${e.id ?? "unknown"}"`);
      }
    }
  }
  return data as RegistryIndex;
}

/** Atomically writes a file by writing to a temp path then renaming. */
function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + ".tmp";
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmpPath, data, "utf8");
  renameSync(tmpPath, filePath);
}

function getCacheDir(): string {
  return process.env.CHVOR_DATA_DIR || join(homedir(), ".chvor", "data");
}

function getCachePath(): string {
  return join(getCacheDir(), "registry-index-cache.json");
}

/**
 * Returns the registry URL, checking (in order):
 * 1. CHVOR_REGISTRY_URL env var
 * 2. Fallback to default
 */
export function getDefaultRegistryUrl(): string {
  return process.env.CHVOR_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

export function computeSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Parse chvor-registry structured error responses. */
function parseRegistryError(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (obj.error && typeof obj.error === "object") {
      const err = obj.error as { code?: string; message?: string };
      if (err.message) return err.message;
      if (err.code) return err.code;
    }
    if (typeof obj.error === "string") return obj.error;
  }
  return `HTTP ${status}`;
}

interface IndexCache {
  index: RegistryIndex;
  etag: string | null;
  fetchedAt: string;
}

function readCacheFile(): IndexCache | null {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    // Support both old format (bare index) and new format (with etag)
    if (raw.index && raw.fetchedAt) {
      return { index: validateRegistryIndex(raw.index), etag: raw.etag ?? null, fetchedAt: raw.fetchedAt };
    }
    // Old format: raw is the index itself
    return { index: validateRegistryIndex(raw), etag: null, fetchedAt: "" };
  } catch {
    return null;
  }
}

function writeCacheFile(cache: IndexCache): void {
  try {
    atomicWriteFileSync(getCachePath(), JSON.stringify(cache));
  } catch {
    // Non-critical
  }
}

export async function fetchRegistryIndex(
  registryUrl = getDefaultRegistryUrl(),
): Promise<RegistryIndex> {
  assertValidRegistryUrl(registryUrl);
  const url = `${registryUrl}/index.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const cached = readCacheFile();

    const headers: Record<string, string> = {
      "Accept-Encoding": "gzip",
    };
    if (cached?.etag) {
      headers["If-None-Match"] = cached.etag;
    }

    const res = await fetch(url, { signal: controller.signal, headers });

    // 304 Not Modified — cached index is still valid
    if (res.status === 304 && cached) {
      return cached.index;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(`Registry fetch failed: ${parseRegistryError(res.status, body)}`);
    }

    const raw = await res.json();
    const index = validateRegistryIndex(raw);

    // Cache with ETag
    const etag = res.headers.get("etag");
    writeCacheFile({ index, etag, fetchedAt: new Date().toISOString() });

    return index;
  } catch (err) {
    // Try cached copy on network failure
    const cached = readCacheFile();
    if (cached) {
      console.warn("[registry-client] network failed, using cached index");
      return cached.index;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function readCachedIndex(): RegistryIndex | null {
  const cache = readCacheFile();
  return cache?.index ?? null;
}

/** Fetch content for any entry kind (skill, tool, or template). */
export async function fetchEntryContent(
  registryUrl: string,
  kind: RegistryEntryKind,
  id: string,
): Promise<string> {
  assertValidRegistryUrl(registryUrl);
  const ext = kind === "template" ? "yaml" : "md";
  const url = `${registryUrl}/${kind}s/${encodeURIComponent(id)}/${kind}.${ext}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(`Failed to fetch ${kind} "${id}": ${parseRegistryError(res.status, body)}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** @deprecated Use fetchEntryContent(url, "skill", id) */
export async function fetchSkillContent(
  registryUrl: string,
  skillId: string,
): Promise<string> {
  return fetchEntryContent(registryUrl, "skill", skillId);
}
