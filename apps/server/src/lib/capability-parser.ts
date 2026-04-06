import matter from "gray-matter";
import { basename, join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type {
  Skill,
  Tool,
  Capability,
  CapabilityMetadata,
  CapabilityParam,
  SkillConfigParam,
  SkillCategory,
  SkillType,
  McpServerConfig,
  SkillAgentDef,
  SkillResourceManifest,
} from "@chvor/shared";

const VALID_CATEGORIES: SkillCategory[] = [
  "ai", "communication", "data", "developer", "file", "productivity", "web",
];

const VALID_PARAM_TYPES = ["string", "number", "boolean", "json", "file"];
const VALID_CONFIG_TYPES = ["string", "number", "boolean"];
const VALID_SKILL_TYPES: SkillType[] = ["prompt", "workflow"];

function parseParams(raw: unknown): CapabilityParam[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      name: String(p.name ?? ""),
      type: VALID_PARAM_TYPES.includes(String(p.type)) ? (String(p.type) as CapabilityParam["type"]) : "string",
      description: String(p.description ?? ""),
      required: Boolean(p.required),
      default: p.default,
    }));
}

function parseMcp(raw: unknown): McpServerConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  // Require either a command (stdio) or a url (sse/http)
  if (!m.command && !m.url) return undefined;
  const transport = m.transport === "http" ? "http" : m.transport === "sse" ? "sse" : "stdio";
  return {
    command: m.command ? String(m.command) : undefined,
    args: Array.isArray(m.args) ? m.args.map(String) : undefined,
    env: typeof m.env === "object" && m.env !== null
      ? Object.fromEntries(Object.entries(m.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined,
    transport,
    url: typeof m.url === "string" ? m.url : undefined,
  };
}

function parseTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((t) => typeof t === "string") as string[];
}

function parseConfigParams(raw: unknown): SkillConfigParam[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      name: String(p.name ?? ""),
      type: VALID_CONFIG_TYPES.includes(String(p.type)) ? (String(p.type) as SkillConfigParam["type"]) : "string",
      description: String(p.description ?? ""),
      default: p.default,
    }));
}

function parseDependencies(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((d) => typeof d === "string" && d.length > 0) as string[];
}

export function parseCapabilityMd(
  content: string,
  filePath: string,
  source: "bundled" | "user" | "registry"
): Skill | Tool | null {
  try {
    const { data: fm, content: body } = matter(content);

    if (!fm.name || !fm.description) {
      console.warn(`[capability-parser] skipping ${filePath}: missing name or description`);
      return null;
    }

    const id = basename(filePath, ".md");
    const category = VALID_CATEGORIES.includes(fm.category) ? fm.category : undefined;
    const requires = typeof fm.requires === "object" && fm.requires !== null
      ? {
          env: Array.isArray(fm.requires.env) ? fm.requires.env.map(String) : undefined,
          credentials: Array.isArray(fm.requires.credentials) ? fm.requires.credentials.map(String) : undefined,
        }
      : undefined;

    const mcpServer = parseMcp(fm.mcp);

    const metadata: CapabilityMetadata = {
      name: String(fm.name),
      description: String(fm.description),
      version: String(fm.version ?? "1.0.0"),
      author: fm.author ? String(fm.author) : undefined,
      category,
      icon: fm.icon ? String(fm.icon) : undefined,
      tags: parseTags(fm.tags),
      license: typeof fm.license === "string" ? fm.license : undefined,
      requires,
      inputs: parseParams(fm.inputs),
      outputs: parseParams(fm.outputs),
      config: parseConfigParams(fm.config),
      dependencies: parseDependencies(fm.dependencies),
    };

    const instructions = body.trim();

    // If MCP server config is present or type is explicitly "tool", return a Tool
    if (mcpServer || fm.type === "tool") {
      return {
        kind: "tool",
        id,
        metadata,
        instructions,
        source,
        path: filePath,
        mcpServer,
        builtIn: source === "bundled",
      };
    }

    // Otherwise return a Skill
    const skillType: SkillType = VALID_SKILL_TYPES.includes(fm.type) ? fm.type : "prompt";

    return {
      kind: "skill",
      id,
      metadata,
      instructions,
      source,
      path: filePath,
      skillType,
    };
  } catch (err) {
    console.warn(`[capability-parser] failed to parse ${filePath}:`, err);
    return null;
  }
}

/**
 * Parse a directory-based skill. Looks for SKILL.md as the entry point,
 * loads sub-agents from agents/, and indexes resources from references/, scripts/, assets/.
 */
export function parseDirectorySkill(
  dirPath: string,
  source: "bundled" | "user" | "registry"
): Skill | null {
  const skillMdPath = join(dirPath, "SKILL.md");
  if (!existsSync(skillMdPath)) return null;

  try {
    const content = readFileSync(skillMdPath, "utf8");
    const { data: fm, content: body } = matter(content);

    if (!fm.name || !fm.description) {
      console.warn(`[capability-parser] skipping dir skill ${dirPath}: missing name or description`);
      return null;
    }

    const id = basename(dirPath);
    const category = VALID_CATEGORIES.includes(fm.category) ? fm.category : undefined;
    const requires = typeof fm.requires === "object" && fm.requires !== null
      ? {
          env: Array.isArray(fm.requires.env) ? fm.requires.env.map(String) : undefined,
          credentials: Array.isArray(fm.requires.credentials) ? fm.requires.credentials.map(String) : undefined,
        }
      : undefined;

    // Parse agent metadata from frontmatter
    const fmAgents: { id: string; name: string; description?: string }[] | undefined =
      Array.isArray(fm.agents)
        ? fm.agents
            .filter((a: unknown): a is Record<string, unknown> => typeof a === "object" && a !== null)
            .map((a: Record<string, unknown>) => ({
              id: String(a.id ?? ""),
              name: String(a.name ?? a.id ?? ""),
              description: a.description ? String(a.description) : undefined,
            }))
        : undefined;

    // Parse resource directory declarations from frontmatter
    const fmResources: string[] | undefined =
      Array.isArray(fm.resources)
        ? fm.resources.filter((r: unknown) => typeof r === "string") as string[]
        : undefined;

    const metadata: CapabilityMetadata = {
      name: String(fm.name),
      description: String(fm.description),
      version: String(fm.version ?? "1.0.0"),
      author: fm.author ? String(fm.author) : undefined,
      category,
      icon: fm.icon ? String(fm.icon) : undefined,
      tags: parseTags(fm.tags),
      license: typeof fm.license === "string" ? fm.license : undefined,
      requires,
      inputs: parseParams(fm.inputs),
      outputs: parseParams(fm.outputs),
      config: parseConfigParams(fm.config),
      dependencies: parseDependencies(fm.dependencies),
      agents: fmAgents,
      resources: fmResources,
    };

    // Load sub-agent definitions from agents/ directory
    const agents: SkillAgentDef[] = [];
    const agentsDir = join(dirPath, "agents");
    if (existsSync(agentsDir)) {
      const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
      for (const file of agentFiles) {
        const agentPath = join(agentsDir, file);
        const agentContent = readFileSync(agentPath, "utf8");
        const agentId = basename(file, ".md");
        const agentMeta = fmAgents?.find((a) => a.id === agentId);
        agents.push({
          id: agentId,
          name: agentMeta?.name ?? agentId,
          description: agentMeta?.description,
          systemPrompt: agentContent,
          path: agentPath,
        });
      }
    }

    // Build resource manifest by indexing declared resource directories
    const resourceManifest: SkillResourceManifest = {};
    const resourceDirs = fmResources ?? ["references", "scripts", "assets"];
    for (const resDir of resourceDirs) {
      const fullResDir = join(dirPath, resDir);
      if (existsSync(fullResDir)) {
        const files = readdirSync(fullResDir).filter((f) => !f.startsWith("."));
        if (resDir === "references") resourceManifest.references = files;
        else if (resDir === "scripts") resourceManifest.scripts = files;
        else if (resDir === "assets") resourceManifest.assets = files;
      }
    }

    const skillType: SkillType = VALID_SKILL_TYPES.includes(fm.type) ? fm.type : "prompt";
    const instructions = body.trim();

    return {
      kind: "skill",
      id,
      metadata,
      instructions,
      source,
      path: skillMdPath,
      skillType,
      basedir: dirPath,
      agents: agents.length > 0 ? agents : undefined,
      resources:
        resourceManifest.references || resourceManifest.scripts || resourceManifest.assets
          ? resourceManifest
          : undefined,
    };
  } catch (err) {
    console.warn(`[capability-parser] failed to parse dir skill ${dirPath}:`, err);
    return null;
  }
}

/** Backward-compatible alias */
export const parseSkillMd = parseCapabilityMd;
