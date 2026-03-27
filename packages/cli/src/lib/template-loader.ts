import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { TemplateManifest, TemplateIndexEntry } from "../types/template.js";
import { getAppDir } from "./paths.js";

const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/chvor-community/skill-registry/main";
const FETCH_TIMEOUT_MS = 8_000;
const SAFE_ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

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

/** Validates that an entry ID is safe for use as a filename (no path traversal). */
function assertSafeEntryId(id: string): void {
  if (!id || id.length > 100 || !SAFE_ENTRY_ID_RE.test(id)) {
    throw new Error(`Invalid entry ID: "${id}" — must be lowercase alphanumeric with hyphens/underscores only`);
  }
}

function getBundledTemplatesDir(): string {
  return join(getAppDir(), "apps", "server", "data", "bundled-templates");
}

export function validateTemplate(manifest: unknown): manifest is TemplateManifest {
  if (!manifest || typeof manifest !== "object") return false;
  const m = manifest as Record<string, unknown>;
  return (
    typeof m.name === "string" &&
    typeof m.description === "string" &&
    typeof m.version === "string"
  );
}

export function loadTemplateFromPath(templateDir: string): TemplateManifest {
  const manifestPath = join(templateDir, "template.yaml");
  if (!existsSync(manifestPath)) {
    throw new Error(`No template.yaml found in ${templateDir}`);
  }

  const raw = readFileSync(manifestPath, "utf-8");
  const manifest = parseYaml(raw);

  if (!validateTemplate(manifest)) {
    throw new Error(
      `Invalid template manifest in ${manifestPath}. Required fields: name, description, version`
    );
  }

  return manifest;
}

export function listBundledTemplates(): TemplateIndexEntry[] {
  const dir = getBundledTemplatesDir();
  if (!existsSync(dir)) return [];

  const entries: TemplateIndexEntry[] = [];
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const d of dirs) {
    const templateDir = join(dir, d.name);
    try {
      const manifest = loadTemplateFromPath(templateDir);
      entries.push({
        id: d.name,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        author: manifest.author,
        icon: manifest.icon,
        tags: manifest.tags,
        path: templateDir,
      });
    } catch (err) {
      console.warn(`  Warning: skipping invalid template in ${d.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return entries;
}

export function resolveBundledTemplate(nameOrId: string): string | null {
  const dir = getBundledTemplatesDir();
  if (!existsSync(dir)) return null;

  // Direct match by directory name
  const directPath = join(dir, nameOrId);
  if (existsSync(join(directPath, "template.yaml"))) {
    return directPath;
  }

  // Search by manifest name
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const d of dirs) {
    const templateDir = join(dir, d.name);
    try {
      const manifest = loadTemplateFromPath(templateDir);
      if (manifest.name === nameOrId) return templateDir;
    } catch {
      // Skip — template may be invalid while searching by name
    }
  }

  return null;
}

export function resolveTemplate(source: string): { path: string; manifest: TemplateManifest } {
  // Try as local path first
  if (existsSync(join(source, "template.yaml"))) {
    return { path: source, manifest: loadTemplateFromPath(source) };
  }

  // Try as bundled template name
  const bundledPath = resolveBundledTemplate(source);
  if (bundledPath) {
    return { path: bundledPath, manifest: loadTemplateFromPath(bundledPath) };
  }

  throw new Error(
    `Template "${source}" not found. Use "chvor init" to see available templates.`
  );
}

export function getTemplateSkillsDir(templatePath: string): string | null {
  const dir = join(templatePath, "skills");
  return existsSync(dir) ? dir : null;
}

export function getTemplateToolsDir(templatePath: string): string | null {
  const dir = join(templatePath, "tools");
  return existsSync(dir) ? dir : null;
}

/**
 * Resolve a template from the community registry.
 * Fetches the template.yaml and any included skills/tools into a temp directory.
 */
export async function resolveRegistryTemplate(
  id: string,
): Promise<{ path: string; manifest: TemplateManifest }> {
  assertSafeEntryId(id);
  const registryUrl = process.env.CHVOR_REGISTRY_URL || DEFAULT_REGISTRY_URL;
  assertValidRegistryUrl(registryUrl);

  // Fetch registry index
  const indexRes = await fetch(`${registryUrl}/index.json`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!indexRes.ok) {
    throw new Error(`Failed to fetch registry index (${indexRes.status})`);
  }

  const index = (await indexRes.json()) as {
    entries: Array<{ id: string; kind: string; includes?: string[] }>;
  };
  const entry = index.entries.find((e) => e.id === id && e.kind === "template");
  if (!entry) {
    throw new Error(
      `Template "${id}" not found in registry. Check the ID and try again.`,
    );
  }

  // Fetch template.yaml
  const yamlRes = await fetch(
    `${registryUrl}/templates/${encodeURIComponent(id)}/template.yaml`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!yamlRes.ok) {
    throw new Error(`Failed to fetch template "${id}" (${yamlRes.status})`);
  }
  const yamlContent = await yamlRes.text();

  // Create temp directory and write manifest
  const tempDir = join(tmpdir(), `chvor-template-${id}-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, "template.yaml"), yamlContent, "utf-8");

  const manifest = parseYaml(yamlContent) as unknown;
  if (!validateTemplate(manifest)) {
    throw new Error(
      `Invalid template manifest from registry for "${id}". Required fields: name, description, version`,
    );
  }

  // Fetch included skills/tools
  if (entry.includes?.length) {
    for (const includedId of entry.includes) {
      try {
        assertSafeEntryId(includedId);
      } catch {
        console.warn(`  Warning: included entry "${includedId}" has invalid ID, skipping.`);
        continue;
      }

      const included = index.entries.find((e) => e.id === includedId);
      if (!included || (included.kind !== "skill" && included.kind !== "tool")) {
        console.warn(
          `  Warning: included entry "${includedId}" not found or unsupported kind in registry, skipping.`,
        );
        continue;
      }

      const contentUrl = `${registryUrl}/${included.kind}s/${encodeURIComponent(includedId)}/${included.kind}.md`;
      const contentRes = await fetch(contentUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!contentRes.ok) {
        console.warn(
          `  Warning: failed to fetch included ${included.kind} "${includedId}" (${contentRes.status}), skipping.`,
        );
        continue;
      }

      const content = await contentRes.text();
      const destDir = join(
        tempDir,
        included.kind === "skill" ? "skills" : "tools",
      );
      mkdirSync(destDir, { recursive: true });
      writeFileSync(join(destDir, `${includedId}.md`), content, "utf-8");
    }
  }

  // Note: caller is responsible for cleaning up tempDir after use
  return { path: tempDir, manifest };
}
