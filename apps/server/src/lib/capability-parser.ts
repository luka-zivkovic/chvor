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
  CredentialFieldSchema,
  SynthesizedToolConfig,
  SynthesizedEndpoint,
  SynthesizedEndpointParam,
  ToolGroupId,
  ToolCriticality,
} from "@chvor/shared";
import { isToolGroupId } from "@chvor/shared";

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
  // Synthesized transport needs no command/url — the caller drives HTTP directly.
  if (m.transport === "synthesized") {
    return { transport: "synthesized" };
  }
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

const VALID_ENDPOINT_METHODS: SynthesizedEndpoint["method"][] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const ENDPOINT_NAME_RE = /^[a-z][a-z0-9_]{0,48}$/;

function parseEndpointParams(raw: unknown): SynthesizedEndpointParam[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SynthesizedEndpointParam[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name : "";
    if (!name) continue;
    const rawType = typeof p.type === "string" ? p.type : "string";
    const type: SynthesizedEndpointParam["type"] =
      rawType === "integer" || rawType === "number" || rawType === "boolean" ? rawType : "string";
    out.push({
      name,
      type,
      required: p.required === true,
      description: typeof p.description === "string" ? p.description : undefined,
    });
  }
  return out;
}

function parseSynthesizedConfig(raw: unknown): SynthesizedToolConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const source = s.source === "ai-draft" ? "ai-draft" : s.source === "openapi" ? "openapi" : null;
  if (!source) return undefined;
  if (typeof s.credentialType !== "string") return undefined;
  let timeoutMs: number | undefined;
  if (typeof s.timeoutMs === "number" && Number.isFinite(s.timeoutMs)) {
    timeoutMs = Math.min(Math.max(Math.floor(s.timeoutMs), 1_000), 600_000);
  }
  return {
    source,
    verified: s.verified === true,
    specUrl: typeof s.specUrl === "string" ? s.specUrl : undefined,
    generatedAt: typeof s.generatedAt === "string" ? s.generatedAt : new Date().toISOString(),
    credentialType: s.credentialType,
    credentialId: typeof s.credentialId === "string" ? s.credentialId : undefined,
    timeoutMs,
  };
}

function parseEndpoints(raw: unknown): SynthesizedEndpoint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SynthesizedEndpoint[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : "";
    if (!ENDPOINT_NAME_RE.test(name) || seen.has(name)) continue;
    const method = typeof e.method === "string" ? e.method.toUpperCase() : "";
    if (!VALID_ENDPOINT_METHODS.includes(method as SynthesizedEndpoint["method"])) continue;
    const path = typeof e.path === "string" && e.path.startsWith("/") ? e.path : null;
    if (!path) continue;
    seen.add(name);
    out.push({
      name,
      description: typeof e.description === "string" ? e.description : `${method} ${path}`,
      method: method as SynthesizedEndpoint["method"],
      path,
      pathParams: parseEndpointParams(e.pathParams),
      queryParams: parseEndpointParams(e.queryParams),
      bodySchema: e.bodySchema && typeof e.bodySchema === "object" ? (e.bodySchema as Record<string, unknown>) : null,
    });
    if (out.length >= 50) break;
  }
  return out.length > 0 ? out : undefined;
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

function parseCredentialSchema(raw: unknown): CredentialFieldSchema | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.type !== "string" || typeof c.name !== "string" || !Array.isArray(c.fields)) return undefined;
  const fields = c.fields
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
    .map((f) => ({
      key: String(f.key ?? ""),
      label: String(f.label ?? ""),
      required: typeof f.required === "boolean" ? f.required : undefined,
      secret: typeof f.secret === "boolean" ? f.secret : undefined,
      helpText: typeof f.helpText === "string" ? f.helpText : undefined,
    }));
  if (fields.length === 0) return undefined;
  return { type: String(c.type), name: String(c.name), fields };
}

function parseRequiredGroups(raw: unknown, filePath: string): ToolGroupId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ToolGroupId[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    if (isToolGroupId(item)) {
      if (!out.includes(item)) out.push(item);
    } else {
      console.warn(`[capability-parser] ${filePath}: unknown tool group "${item}" — ignoring`);
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((s) => typeof s === "string" && s.length > 0) as string[];
  return out.length > 0 ? out : undefined;
}

function parseGroup(raw: unknown, filePath: string): ToolGroupId | undefined {
  if (typeof raw !== "string") return undefined;
  if (isToolGroupId(raw)) return raw;
  console.warn(`[capability-parser] ${filePath}: unknown tool group "${raw}" — ignoring`);
  return undefined;
}

function parseCriticality(raw: unknown): ToolCriticality | undefined {
  if (raw === "always-available" || raw === "normal") return raw;
  return undefined;
}

function parseProvides(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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
      provides: parseProvides(fm.provides),
      needs: parseDependencies(fm.needs),
      defaultEnabled: typeof fm.defaultEnabled === "boolean" ? fm.defaultEnabled : undefined,
      credentialSchema: parseCredentialSchema(fm.credentials),
      // Phase C — tool-bag scoping
      requiredGroups: parseRequiredGroups(fm.requiredGroups ?? fm.required_groups, filePath),
      requiredTools: parseStringList(fm.requiredTools ?? fm.required_tools),
      deniedTools: parseStringList(fm.deniedTools ?? fm.denied_tools),
      allowedCredentialTypes: parseStringList(fm.allowedCredentialTypes ?? fm.allowed_credential_types),
      preferredUsageContext: parseStringList(fm.preferredUsageContext ?? fm.preferred_usage_context),
      group: parseGroup(fm.group, filePath),
      criticality: parseCriticality(fm.criticality),
    };

    const instructions = body.trim();

    // If MCP server config is present or type is explicitly "tool", return a Tool
    if (mcpServer || fm.type === "tool") {
      if (metadata.needs?.length) {
        console.warn(`[capability-parser] ${filePath}: "needs" has no effect on tools (only skills)`);
      }
      const synthesized = parseSynthesizedConfig(fm.synthesized);
      const endpoints = parseEndpoints(fm.endpoints);
      return {
        kind: "tool",
        id,
        metadata,
        instructions,
        source,
        path: filePath,
        mcpServer,
        builtIn: source === "bundled",
        synthesized,
        endpoints,
      };
    }

    // Otherwise return a Skill
    if (metadata.provides && Object.keys(metadata.provides).length > 0) {
      console.warn(`[capability-parser] ${filePath}: "provides" has no effect on skills (only tools)`);
    }

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
