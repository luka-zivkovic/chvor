import matter from "gray-matter";
import { basename } from "node:path";
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
  if (!m.command) return undefined;
  return {
    command: String(m.command),
    args: Array.isArray(m.args) ? m.args.map(String) : [],
    env: typeof m.env === "object" && m.env !== null
      ? Object.fromEntries(Object.entries(m.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined,
    transport: m.transport === "http" ? "http" : "stdio",
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

/** Backward-compatible alias */
export const parseSkillMd = parseCapabilityMd;
