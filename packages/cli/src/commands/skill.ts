import { readConfig } from "../lib/config.js";
import { readFileSync } from "node:fs";
import { validateSkillForPublishing } from "@chvor/shared";

function getBaseUrl(): string {
  const config = readConfig();
  return `http://localhost:${config.port}`;
}

function getHeaders(): Record<string, string> {
  const config = readConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
  return headers;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getBaseUrl()}/api${path}`, {
    ...init,
    headers: { ...getHeaders(), ...(init?.headers as Record<string, string>) },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  const json = (await res.json()) as { data: T };
  return json.data;
}

// --- Skill commands ---

export async function skillSearch(query: string): Promise<void> {
  return registrySearch(query, "skill");
}

export async function skillInstall(name: string): Promise<void> {
  return registryInstall(name, "skill");
}

export async function skillUninstall(name: string): Promise<void> {
  return registryUninstall(name);
}

export async function skillUpdate(name?: string): Promise<void> {
  return registryUpdate(name);
}

export async function skillList(): Promise<void> {
  try {
    const skills = await apiRequest<Array<{
      id: string;
      metadata: { name: string; version: string; category?: string };
      source: string;
      enabled: boolean;
    }>>("/skills");

    if (skills.length === 0) {
      console.log("No skills installed.");
      return;
    }

    console.log(`\n${skills.length} skill(s) installed:\n`);
    const maxName = Math.max(...skills.map((s) => s.metadata.name.length), 4);

    console.log(`${"Name".padEnd(maxName)}  Version   Source     Enabled  Category`);
    console.log("-".repeat(maxName + 50));

    for (const s of skills) {
      console.log(
        `${s.metadata.name.padEnd(maxName)}  ${(s.metadata.version ?? "").padEnd(9)} ${s.source.padEnd(10)} ${String(s.enabled).padEnd(8)} ${s.metadata.category ?? ""}`,
      );
    }
    console.log();
  } catch (err) {
    console.error("List failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

export async function skillInfo(name: string): Promise<void> {
  return registryInfo(name);
}

export async function skillPublish(filePath: string): Promise<void> {
  try {
    const content = readFileSync(filePath, "utf8");
    const result = validateSkillForPublishing(content);

    if (result.warnings.length > 0) {
      console.log("\nWarnings:");
      for (const w of result.warnings) console.log(`  - ${w}`);
    }

    if (!result.valid) {
      console.log("\nValidation errors:");
      for (const e of result.errors) console.log(`  - ${e}`);
      console.log("\nFix these issues before publishing.");
      process.exit(1);
    }

    console.log("\nSkill file is valid for publishing.");

    // Try to submit to registry
    const registryUrl = getRegistryUrl();
    await submitToRegistry(registryUrl, content, "skill");
  } catch (err) {
    console.error("Publish failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

export async function toolPublish(filePath: string): Promise<void> {
  try {
    const content = readFileSync(filePath, "utf8");
    // Use same validation — tools also need frontmatter with name/description/version/author
    const result = validateSkillForPublishing(content);

    if (result.warnings.length > 0) {
      console.log("\nWarnings:");
      for (const w of result.warnings) console.log(`  - ${w}`);
    }

    if (!result.valid) {
      console.log("\nValidation errors:");
      for (const e of result.errors) console.log(`  - ${e}`);
      console.log("\nFix these issues before publishing.");
      process.exit(1);
    }

    console.log("\nTool file is valid for publishing.");

    const registryUrl = getRegistryUrl();
    await submitToRegistry(registryUrl, content, "tool");
  } catch (err) {
    console.error("Publish failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

function getRegistryUrl(): string {
  return process.env.CHVOR_REGISTRY_URL || "https://raw.githubusercontent.com/chvor-community/skill-registry/main";
}

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

async function submitToRegistry(registryUrl: string, content: string, kind: "skill" | "tool"): Promise<void> {
  assertValidRegistryUrl(registryUrl);
  const { getRegistryToken, authenticate } = await import("../lib/registry-auth.js");

  // Check if registry supports submissions
  let supportsSubmissions = false;
  try {
    const healthRes = await fetch(`${registryUrl.replace(/\/v1$/, "")}/health`, { method: "GET" });
    supportsSubmissions = healthRes.ok;
  } catch {
    // Registry not reachable — show fallback message
  }

  if (!supportsSubmissions) {
    console.log(
      "\nThe community registry is not yet available for submissions.",
    );
    const dir = kind === "tool" ? "~/.chvor/tools/" : "~/.chvor/skills/";
    console.log(`For now, you can use this file locally by placing it in ${dir}`);
    console.log();
    return;
  }

  // Authenticate if needed
  let token = getRegistryToken(registryUrl);
  if (!token) {
    console.log("\nYou need to authenticate to publish.\n");
    const auth = await authenticate(registryUrl);
    token = auth.token;
  }

  // Extract ID from frontmatter
  const idMatch = content.match(/^---[\s\S]*?name:\s*["']?(.+?)["']?\s*$/m);
  const nameRaw = idMatch?.[1] ?? "untitled";
  const id = nameRaw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // Submit
  console.log(`\nSubmitting ${kind} "${id}" to registry...`);
  const res = await fetch(`${registryUrl}/submissions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ id, kind, content }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const errObj = body as { error?: string | { message?: string } };
    const msg = typeof errObj.error === "object" ? errObj.error?.message : errObj.error;
    throw new Error(`Submission failed: ${msg ?? `HTTP ${res.status}`}`);
  }

  const data = await res.json() as { id: string; status: string };
  console.log(`\nSubmission created (ID: ${data.id})`);
  console.log(`Status: ${data.status}`);
  console.log("\nYour submission will be reviewed by the registry maintainers.");
  console.log("Track its status at the creator portal.");
  console.log();
}

// --- Tool commands ---

export async function toolSearch(query: string): Promise<void> {
  return registrySearch(query, "tool");
}

export async function toolInstall(name: string): Promise<void> {
  return registryInstall(name, "tool");
}

export async function toolUninstall(name: string): Promise<void> {
  return registryUninstall(name);
}

export async function toolUpdate(name?: string): Promise<void> {
  return registryUpdate(name);
}

export async function toolList(): Promise<void> {
  try {
    const tools = await apiRequest<Array<{
      id: string;
      metadata: { name: string; version: string; category?: string };
      source: string;
      enabled: boolean;
      builtIn: boolean;
    }>>("/tools");

    if (tools.length === 0) {
      console.log("No tools installed.");
      return;
    }

    console.log(`\n${tools.length} tool(s) installed:\n`);
    const maxName = Math.max(...tools.map((t) => t.metadata.name.length), 4);

    console.log(`${"Name".padEnd(maxName)}  Version   Source     Enabled  Category`);
    console.log("-".repeat(maxName + 50));

    for (const t of tools) {
      console.log(
        `${t.metadata.name.padEnd(maxName)}  ${(t.metadata.version ?? "").padEnd(9)} ${t.source.padEnd(10)} ${String(t.enabled).padEnd(8)} ${t.metadata.category ?? ""}`,
      );
    }
    console.log();
  } catch (err) {
    console.error("List failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

export async function toolInfo(name: string): Promise<void> {
  return registryInfo(name);
}

// --- Shared registry operations ---

async function registrySearch(query: string, kind: "skill" | "tool"): Promise<void> {
  try {
    const results = await apiRequest<Array<{
      id: string;
      kind: string;
      name: string;
      description: string;
      version: string;
      author?: string;
      category?: string;
      installed: boolean;
      installedVersion: string | null;
    }>>(`/registry/search?q=${encodeURIComponent(query)}&kind=${kind}`);

    if (results.length === 0) {
      console.log(`No ${kind}s found matching your query.`);
      return;
    }

    console.log(`\nFound ${results.length} ${kind}(s):\n`);
    const maxName = Math.max(...results.map((r) => r.name.length), 4);
    const maxVer = Math.max(...results.map((r) => r.version.length), 7);

    console.log(
      `${"Name".padEnd(maxName)}  ${"Version".padEnd(maxVer)}  Status       Category    Description`,
    );
    console.log("-".repeat(maxName + maxVer + 60));

    for (const r of results) {
      const status = r.installed
        ? r.installedVersion !== r.version
          ? `update ${r.installedVersion}`
          : "installed"
        : "available";
      console.log(
        `${r.name.padEnd(maxName)}  ${r.version.padEnd(maxVer)}  ${status.padEnd(12)} ${(r.category ?? "").padEnd(11)} ${r.description.slice(0, 50)}`,
      );
    }
    console.log();
  } catch (err) {
    console.error("Search failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function registryInstall(name: string, kind: "skill" | "tool"): Promise<void> {
  try {
    console.log(`Installing "${name}" from registry...`);
    const result = await apiRequest<{
      entry: { id: string; metadata: { name: string; version: string } };
      skill: { id: string; metadata: { name: string; version: string } };
      dependencies: string[];
    }>("/registry/install", {
      method: "POST",
      body: JSON.stringify({ id: name, kind }),
    });

    const installed = result.entry ?? result.skill;
    console.log(`Installed ${installed.metadata.name} v${installed.metadata.version}`);
    if (result.dependencies.length > 0) {
      console.log(`  Dependencies installed: ${result.dependencies.join(", ")}`);
    }
  } catch (err) {
    console.error("Install failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function registryUninstall(name: string): Promise<void> {
  try {
    await apiRequest<{ id: string; uninstalled: boolean }>(
      `/registry/entry/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    console.log(`Uninstalled "${name}"`);
  } catch (err) {
    console.error("Uninstall failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function registryUpdate(name?: string): Promise<void> {
  try {
    if (name) {
      console.log(`Updating "${name}"...`);
      const result = await apiRequest<{ id: string; updated: boolean; conflict: boolean }>(
        "/registry/update",
        { method: "POST", body: JSON.stringify({ id: name }) },
      );
      if (result.conflict) {
        console.log(`Skipped — "${name}" was locally modified. Use --force to overwrite.`);
      } else if (result.updated) {
        console.log(`Updated "${name}"`);
      } else {
        console.log(`"${name}" is already up to date.`);
      }
    } else {
      console.log("Checking for updates...");
      const results = await apiRequest<Array<{ id: string; updated: boolean; conflict: boolean }>>(
        "/registry/update",
        { method: "POST", body: JSON.stringify({ all: true }) },
      );
      const updated = results.filter((r) => r.updated);
      const conflicts = results.filter((r) => r.conflict);
      console.log(`Updated ${updated.length} entries`);
      if (conflicts.length > 0) {
        console.log(
          `Skipped ${conflicts.length} locally modified: ${conflicts.map((c) => c.id).join(", ")}`,
        );
      }
    }
  } catch (err) {
    console.error("Update failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function registryInfo(name: string): Promise<void> {
  try {
    const entry = await apiRequest<{
      id: string;
      kind: string;
      name: string;
      description: string;
      version: string;
      author?: string;
      category?: string;
      tags?: string[];
      license?: string;
      downloads?: number;
      dependencies?: string[];
      installed: boolean;
      installedVersion: string | null;
    }>(`/registry/entry/${encodeURIComponent(name)}`).catch(() => null);

    if (entry) {
      console.log(`\n${entry.name} (${entry.id})`);
      console.log(`  ${entry.description}`);
      console.log(`  Kind:     ${entry.kind}`);
      console.log(`  Version:  ${entry.version}`);
      if (entry.author) console.log(`  Author:   ${entry.author}`);
      if (entry.category) console.log(`  Category: ${entry.category}`);
      if (entry.tags?.length) console.log(`  Tags:     ${entry.tags.join(", ")}`);
      if (entry.license) console.log(`  License:  ${entry.license}`);
      if (entry.downloads !== undefined) console.log(`  Downloads: ${entry.downloads}`);
      if (entry.dependencies?.length) console.log(`  Depends:  ${entry.dependencies.join(", ")}`);
      console.log(
        `  Status:   ${entry.installed ? `installed (v${entry.installedVersion})` : "not installed"}`,
      );
      console.log();
    } else {
      console.log(`"${name}" not found in registry.`);
    }
  } catch (err) {
    console.error("Info failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
