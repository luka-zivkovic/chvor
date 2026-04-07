import { tool } from "ai";
import { z } from "zod";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { ExecutionEvent, GatewayServerEvent, A2UIComponentEntry } from "@chvor/shared";
import { upsertSurface, updateBindings as updateSurfaceBindings, deleteSurface as deleteSurfaceFromDb, deleteAllSurfaces, surfaceExists } from "../db/a2ui-store.ts";
import { logError, formatUptime } from "./error-logger.ts";
import type { ErrorCategory } from "./error-logger.ts";
import { getSelfHealingEnabled, getPcControlEnabled, setConfig, getShellConfig as getShellApprovalConfig, isCapabilityEnabled, isTrustedCommand, addTrustedCommand } from "../db/config-store.ts";
import { fetchRegistryIndex, readCachedIndex } from "./registry-client.ts";
import { installEntry, uninstallEntry, readLock } from "./registry-manager.ts";
import type { RegistryEntryKind } from "@chvor/shared";
import { insertActivity } from "../db/activity-store.ts";
import { LLM_CRED_TYPES, IMAGE_GEN_PROVIDERS } from "./provider-registry.ts";

export type NativeToolContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface NativeToolResult {
  content: NativeToolContentItem[];
}

export interface NativeToolContext {
  sessionId?: string;
  emitEvent?: (event: ExecutionEvent) => void;
  originClientId?: string;
  channelType?: string;
  channelId?: string;
  workspaceId?: string;
}

type NativeToolHandler = (
  args: Record<string, unknown>,
  context?: NativeToolContext
) => Promise<NativeToolResult>;

const handlers = new Map<string, NativeToolHandler>();

// Native tool → capability target mapping (for canvas animation)
const nativeToolMapping = new Map<string, { kind: "skill" | "tool"; id: string }>();

/** Get the capability target a native tool maps to (for canvas node animation). */
export function getNativeToolTarget(qualifiedName: string): { kind: "skill" | "tool"; id: string } | null {
  return nativeToolMapping.get(qualifiedName) ?? null;
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
];

export async function validateFetchUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }
  const { address } = await lookup(parsed.hostname);
  const { getAllowLocalhost } = await import("../db/config-store.ts");
  if (!getAllowLocalhost() && PRIVATE_IP_RANGES.some((r) => r.test(address))) {
    throw new Error(`Blocked private/internal address: ${parsed.hostname}. Enable "Allow localhost" in Settings → Permissions to access local services.`);
  }
  return parsed;
}

function sanitizeYamlValue(val: string): string {
  return `"${val.replace(/[\n\r]/g, " ").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Workflow parameter resolution (shared between run-workflow + scheduler)
// ---------------------------------------------------------------------------

interface WorkflowParamDef {
  name: string;
  description?: string;
  required: boolean;
  default?: unknown;
}

export interface ResolvedWorkflowParams {
  resolved: Record<string, string>;
  missing: string[];
}

/**
 * Resolves workflow parameters and substitutes {{placeholders}} in instructions.
 * Uses single-pass regex replacement to prevent double-substitution attacks
 * (e.g. a param value containing "{{other_param}}" is NOT re-expanded).
 */
export function resolveWorkflowParams(
  definedParams: WorkflowParamDef[],
  inputParams: Record<string, string>,
  instructions: string
): { resolved: Record<string, string>; missing: string[]; instructions: string } {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const param of definedParams) {
    if (inputParams[param.name] !== undefined) {
      resolved[param.name] = inputParams[param.name];
    } else if (param.default !== undefined) {
      resolved[param.name] = String(param.default);
    } else if (param.required) {
      missing.push(param.name);
    }
  }

  // Single-pass substitution to prevent double-expansion
  const substituted = instructions.replace(
    /\{\{([^}]+)\}\}/g,
    (match, key: string) => {
      const trimmed = key.trim();
      return trimmed in resolved ? resolved[trimmed] : match;
    }
  );

  return { resolved, missing, instructions: substituted };
}

// ---------------------------------------------------------------------------
// HTTP Fetch tool
// ---------------------------------------------------------------------------
const FETCH_TOOL_NAME = "native__web_request";
const MAX_RESPONSE_LENGTH = 50_000;

const fetchToolDef = tool({
  description:
    "[Web Browse] Make HTTP requests to URLs and APIs. Supports GET, POST, PUT, PATCH, DELETE with custom headers and request body.",
  parameters: z.object({
    url: z.string().describe("The URL to fetch"),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .optional()
      .describe("HTTP method (default: GET)"),
    headers: z
      .record(z.string())
      .optional()
      .describe("HTTP headers as key-value pairs"),
    body: z
      .string()
      .optional()
      .describe("Request body (for POST/PUT/PATCH)"),
  }),
});

async function handleFetch(
  args: Record<string, unknown>
): Promise<NativeToolResult> {
  const url = String(args.url);
  const method = String(args.method ?? "GET").toUpperCase();
  const headers = (args.headers ?? {}) as Record<string, string>;
  const body = args.body != null ? String(args.body) : undefined;

  try {
    await validateFetchUrl(url);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Fetch blocked: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }

  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: hasBody ? body : undefined,
      signal: controller.signal,
      redirect: "manual",
    });

    // Handle redirects safely — validate each redirect target against the same blocklist
    const MAX_REDIRECTS = 5;
    let currentResponse = response;
    let redirectCount = 0;
    while (currentResponse.status >= 300 && currentResponse.status < 400 && redirectCount < MAX_REDIRECTS) {
      const location = currentResponse.headers.get("location");
      if (!location) {
        return { content: [{ type: "text", text: `Redirect with no Location header (HTTP ${currentResponse.status})` }] };
      }
      try {
        const redirectUrl = new URL(location, url);
        await validateFetchUrl(redirectUrl.href);
        currentResponse = await fetch(redirectUrl.href, {
          method: "GET",
          headers,
          signal: controller.signal,
          redirect: "manual",
        });
        redirectCount++;
      } catch (err) {
        return { content: [{ type: "text", text: `Redirect blocked: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
    if (redirectCount >= MAX_REDIRECTS) {
      return { content: [{ type: "text", text: `Too many redirects (followed ${MAX_REDIRECTS})` }] };
    }
    if (redirectCount > 0) {
      clearTimeout(timeout);
      const redirectText = await currentResponse.text();
      return {
        content: [{ type: "text", text: `HTTP ${currentResponse.status} (after ${redirectCount} redirect${redirectCount > 1 ? "s" : ""})\n\n${redirectText.slice(0, 50_000)}` }],
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    let text: string;

    if (contentType.includes("application/json")) {
      try {
        const json = await response.json();
        text = JSON.stringify(json, null, 2);
      } catch {
        text = await response.text();
      }
    } else {
      text = await response.text();
    }

    if (text.length > MAX_RESPONSE_LENGTH) {
      text = text.slice(0, MAX_RESPONSE_LENGTH) + "\n\n[...truncated]";
    }

    return {
      content: [
        {
          type: "text",
          text: `HTTP ${response.status} ${response.statusText}\n\n${text}`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` }],
    };
  } finally {
    clearTimeout(timeout);
  }
}

handlers.set(FETCH_TOOL_NAME, handleFetch);
nativeToolMapping.set(FETCH_TOOL_NAME, { kind: "tool", id: "web-browse" });

// ---------------------------------------------------------------------------
// Web Search tool (zero-config, scrapes DuckDuckGo HTML — no MCP or API key)
// ---------------------------------------------------------------------------
const WEB_SEARCH_TOOL_NAME = "native__web_search";

const webSearchToolDef = tool({
  description:
    "[Web Browse] Search the web for current information. Zero-config default — no API key required. For higher quality results, configure Brave Search or SearXNG in your credentials.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 8)"),
  }),
});

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRealUrl(ddgHref: string): string {
  try {
    const full = ddgHref.startsWith("//") ? "https:" + ddgHref : ddgHref;
    const parsed = new URL(full);
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : full;
  } catch {
    return ddgHref;
  }
}

function parseDuckDuckGoHTML(
  html: string,
  maxResults: number
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // Match result links: <a rel="nofollow" class="result__a" href="...">TITLE</a>
  const linkRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Match snippets: <a class="result__snippet" ...>SNIPPET</a>
  const snippetRegex =
    /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: Array<{ rawHref: string; title: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    links.push({ rawHref: match[1], title: stripHtmlTags(match[2]) });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtmlTags(match[1]));
  }

  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    const url = extractRealUrl(links[i].rawHref);
    // Skip DuckDuckGo internal links
    if (url.includes("duckduckgo.com/y.js")) continue;
    results.push({
      title: links[i].title,
      url,
      snippet: snippets[i] ?? "",
    });
  }
  return results;
}

async function handleWebSearch(
  args: Record<string, unknown>
): Promise<NativeToolResult> {
  const query = String(args.query ?? "");
  const rawMax = Number(args.maxResults ?? 8);
  const maxResults = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(rawMax, 20) : 8;

  if (!query.trim()) {
    return {
      content: [{ type: "text", text: "Error: search query is required." }],
    };
  }

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Web search failed: HTTP ${response.status} ${response.statusText}`,
          },
        ],
      };
    }

    const html = await response.text();
    const results = parseDuckDuckGoHTML(html, maxResults);

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No results found for "${query}".`,
          },
        ],
      };
    }

    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Search results for "${query}":\n\n${formatted}`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  } finally {
    clearTimeout(timeout);
  }
}

handlers.set(WEB_SEARCH_TOOL_NAME, handleWebSearch);
nativeToolMapping.set(WEB_SEARCH_TOOL_NAME, { kind: "tool", id: "web-browse" });

// ---------------------------------------------------------------------------
// Create Skill tool
// ---------------------------------------------------------------------------
const CREATE_SKILL_TOOL_NAME = "native__create_skill";
const USER_SKILLS_DIR = join(homedir(), ".chvor", "skills");

const createSkillToolDef = tool({
  description:
    "[Create Skill] Register a new integration/skill that appears on the Brain Canvas. Use this when you successfully connect to a new service or API and want it visible as a skill node. Do NOT use this for services that already have a saved credential — those already appear as integration nodes on the canvas automatically.",
  parameters: z.object({
    id: z
      .string()
      .describe("Unique slug (lowercase, hyphens ok). Used as filename."),
    name: z.string().describe("Display name (e.g. 'Coolify', 'Notion')"),
    description: z
      .string()
      .describe("Short description of what this skill does"),
    category: z
      .enum([
        "ai",
        "communication",
        "data",
        "developer",
        "file",
        "productivity",
        "web",
      ])
      .optional()
      .describe("Skill category"),
    icon: z
      .string()
      .optional()
      .describe("Icon name (e.g. 'server', 'cloud', 'database')"),
    instructions: z
      .string()
      .describe(
        "Instructions for the LLM on how to use this integration in future conversations"
      ),
    skillType: z
      .enum(["prompt", "workflow"])
      .optional()
      .describe("Skill type: 'prompt' for behavioral instructions, 'workflow' for multi-step procedures. Defaults to 'prompt'."),
  }),
});

/** Skill IDs managed by bundled skills — cannot be created by the AI. */
const RESERVED_SKILL_IDS = new Set(["getting-started", "get-started", "chvor-guide"]);

async function handleCreateSkill(
  args: Record<string, unknown>
): Promise<NativeToolResult> {
  const id = String(args.id)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  const name = String(args.name);

  // Guard: reserved skill IDs handled by bundled skills
  if (RESERVED_SKILL_IDS.has(id)) {
    return {
      content: [{ type: "text", text: `Skipped: "${id}" is reserved. First-run guidance is handled by the built-in Chvor Guide skill.` }],
    };
  }

  // Guard: prevent overwriting bundled skills
  const { getSkill: lookupSkill } = await import("./capability-loader.ts");
  const existingSkill = lookupSkill(id);
  if (existingSkill?.source === "bundled") {
    return {
      content: [{ type: "text", text: `Cannot create skill "${id}" — a bundled skill with this ID exists. Choose a different ID.` }],
    };
  }

  // Guard: skip if a non-LLM credential already covers this service
  const { listCredentials } = await import("../db/credential-store.ts");
  const integrationCreds = listCredentials().filter((c) => !LLM_CRED_TYPES.has(c.type));
  const idLower = id.toLowerCase();
  const nameLower = name.toLowerCase();
  const matchedCred = integrationCreds.find((c) => {
    const credSlug = c.name.toLowerCase().replace(/\s+/g, "-");
    return credSlug === idLower || credSlug === nameLower || c.name.toLowerCase() === nameLower;
  });
  if (matchedCred) {
    return {
      content: [
        {
          type: "text",
          text: `Skipped: a credential for '${matchedCred.name}' already exists and appears on the canvas as an integration node. No skill creation needed.`,
        },
      ],
    };
  }

  const description = String(args.description);
  const category = args.category ? String(args.category) : undefined;
  const icon = args.icon ? String(args.icon) : undefined;
  const instructions = String(args.instructions);

  const skillType = args.skillType ? String(args.skillType) : undefined;

  // Guard: redirect workflow creation to dedicated native__create_workflow tool
  if (skillType === "workflow") {
    return {
      content: [
        {
          type: "text",
          text: `Use native__create_workflow instead of native__create_skill for workflow-type skills. It supports structured steps and parameters.`,
        },
      ],
    };
  }

  const frontmatter: string[] = [
    `name: ${sanitizeYamlValue(name)}`,
    `description: ${sanitizeYamlValue(description)}`,
    `version: 1.0.0`,
  ];
  if (skillType) frontmatter.push(`type: ${sanitizeYamlValue(skillType)}`);
  if (category) frontmatter.push(`category: ${sanitizeYamlValue(category)}`);
  if (icon) frontmatter.push(`icon: ${sanitizeYamlValue(icon)}`);

  const content = `---\n${frontmatter.join("\n")}\n---\n${instructions}\n`;

  mkdirSync(USER_SKILLS_DIR, { recursive: true });
  const filePath = join(USER_SKILLS_DIR, `${id}.md`);
  writeFileSync(filePath, content, "utf8");

  return {
    content: [
      {
        type: "text",
        text: `Skill "${name}" (id: ${id}) created at ${filePath}. It will appear on the Brain Canvas.`,
      },
    ],
  };
}

handlers.set(CREATE_SKILL_TOOL_NAME, handleCreateSkill);

// ---------------------------------------------------------------------------
// Schedule tools
// ---------------------------------------------------------------------------
// Schedule + session imports are lazy to avoid circular dependency:
// orchestrator → native-tools → scheduler → orchestrator
// Instead, we import at call time inside handlers.

const CREATE_SCHEDULE_NAME = "native__create_schedule";

const createScheduleToolDef = tool({
  description:
    "[Create Schedule] Create a recurring or one-shot scheduled task. Use this when the user asks you to remind them, check something periodically, or set up any automated task. For one-time reminders (e.g. 'remind me in 5 minutes', 'remind me at 3pm'), set oneShot=true so it auto-disables after firing once. For recurring tasks (e.g. 'every day at 9am'), leave oneShot false.",
  parameters: z.object({
    name: z.string().describe("Short name for the schedule (e.g. 'Morning briefing')"),
    cronExpression: z
      .string()
      .describe(
        "Cron expression for when to run (5 fields: minute hour day-of-month month day-of-week). Examples: '0 9 * * *' = daily 9 AM, '*/30 * * * *' = every 30 min, '0 9 * * 1' = every Monday 9 AM, '30 14 * * *' = 2:30 PM daily"
      ),
    prompt: z
      .string()
      .describe(
        "The instruction/prompt that will be executed when the schedule fires. Write it as a direct action — do NOT include scheduling language like 'remind me' or 'every day'. Example: 'Send a friendly greeting to my friend' not 'Remind me every day to send a greeting'."
      ),
    oneShot: z
      .boolean()
      .optional()
      .describe(
        "If true, the schedule auto-disables after firing once. Use for one-time reminders like 'remind me in 5 minutes' or 'remind me at 3pm today'. Default: false (recurring)."
      ),
    deliverToChannel: z
      .enum(["telegram", "discord", "slack"])
      .optional()
      .describe(
        "If set, deliver the result to this channel. Auto-resolves the chat ID from the most recent conversation on that channel."
      ),
    workflowId: z
      .string()
      .optional()
      .describe(
        "If set, this schedule runs the specified workflow instead of the raw prompt. The prompt field still serves as a human-readable description."
      ),
    workflowParams: z
      .record(z.string())
      .optional()
      .describe(
        "Parameter values for the workflow. Required parameters must be provided here since no user is present during scheduled execution."
      ),
  }),
});

async function handleCreateSchedule(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const { createSchedule } = await import("../db/schedule-store.ts");
  const { syncSchedule } = await import("./scheduler.ts");
  const { listChannelTargets } = await import("../db/session-store.ts");

  const name = String(args.name);
  const cronExpression = String(args.cronExpression);
  const prompt = String(args.prompt);
  const oneShot = Boolean(args.oneShot);
  const deliverToChannel = args.deliverToChannel
    ? String(args.deliverToChannel)
    : undefined;
  const workflowId = args.workflowId ? String(args.workflowId) : undefined;
  const workflowParams = args.workflowParams as Record<string, string> | undefined;

  // Validate cron expression
  try {
    const cronParser = await import("cron-parser");
    const parse = cronParser.parseExpression ?? cronParser.default?.parseExpression;
    if (parse) parse(cronExpression);
  } catch {
    return {
      content: [{ type: "text", text: `Invalid cron expression: "${cronExpression}". Use 5 fields: minute hour day-of-month month day-of-week.` }],
    };
  }

  // Validate workflow if specified
  if (workflowId) {
    const { getSkill } = await import("./capability-loader.ts");
    const skill = getSkill(workflowId);
    if (!skill || skill.skillType !== "workflow") {
      return {
        content: [{ type: "text", text: `Workflow "${workflowId}" not found or is not a workflow-type skill.` }],
      };
    }
    // Validate all required params are provided (no user to prompt during cron)
    const definedParams = skill.metadata.inputs ?? [];
    const provided = workflowParams ?? {};
    const missing = definedParams.filter(
      (p) => p.required && provided[p.name] === undefined && p.default === undefined
    );
    if (missing.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: `Cannot schedule workflow: missing required parameter(s): ${missing.map((p) => p.name).join(", ")}. All required parameters must be provided at schedule creation since no user is present during cron execution.`,
          },
        ],
      };
    }
  }

  // Resolve delivery target from session history
  let deliverTo = undefined;
  if (deliverToChannel) {
    const targets = listChannelTargets();
    const match = targets.find((t) => t.channelType === deliverToChannel);
    if (match) {
      deliverTo = [
        {
          channelType: match.channelType as "telegram" | "discord" | "slack",
          channelId: match.channelId,
        },
      ];
    }
  }

  const schedule = createSchedule({
    name,
    cronExpression,
    prompt,
    workspaceId: context?.workspaceId ?? "default-constellation",
    oneShot,
    deliverTo,
    workflowId,
    workflowParams,
  });

  syncSchedule(schedule.id);

  const { getWSInstance } = await import("../gateway/ws-instance.ts");
  getWSInstance()?.broadcast({ type: "schedule.created" as const, data: schedule });

  const workflowLabel = workflowId ? ` Linked to workflow: ${workflowId}.` : "";
  return {
    content: [
      {
        type: "text",
        text: `Schedule "${name}" created (id: ${schedule.id}). Cron: ${cronExpression}.${oneShot ? " One-shot (will auto-disable after first run)." : ""}${deliverTo ? ` Will deliver to ${deliverToChannel}.` : ""}${workflowLabel} The schedule is now active and armed.`,
      },
    ],
  };
}

handlers.set(CREATE_SCHEDULE_NAME, handleCreateSchedule);
nativeToolMapping.set(CREATE_SCHEDULE_NAME, { kind: "tool", id: "scheduler" });

const LIST_SCHEDULES_NAME = "native__list_schedules";

const listSchedulesToolDef = tool({
  description:
    "[List Schedules] List all scheduled tasks with their status, cron timing, and last run info.",
  parameters: z.object({}),
});

async function handleListSchedules(): Promise<NativeToolResult> {
  const { listSchedules } = await import("../db/schedule-store.ts");
  const schedules = listSchedules();
  if (schedules.length === 0) {
    return {
      content: [{ type: "text", text: "No schedules found." }],
    };
  }

  const lines = schedules.map((s) => {
    const status = s.enabled ? "enabled" : "paused";
    const lastRun = s.lastRunAt ?? "never";
    const delivery =
      s.deliverTo && s.deliverTo.length > 0
        ? ` → ${s.deliverTo.map((d) => d.channelType).join(", ")}`
        : "";
    return `- [${status}] "${s.name}" (${s.cronExpression}) | last run: ${lastRun}${delivery} | id: ${s.id}`;
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

handlers.set(LIST_SCHEDULES_NAME, handleListSchedules);
nativeToolMapping.set(LIST_SCHEDULES_NAME, { kind: "tool", id: "scheduler" });

const DELETE_SCHEDULE_NAME = "native__delete_schedule";

const deleteScheduleToolDef = tool({
  description:
    "[Delete Schedule] Delete a scheduled task by its ID. Use native__list_schedules first to find the ID.",
  parameters: z.object({
    id: z.string().describe("The schedule ID to delete"),
  }),
});

async function handleDeleteSchedule(
  args: Record<string, unknown>
): Promise<NativeToolResult> {
  const { deleteSchedule } = await import("../db/schedule-store.ts");
  const { syncSchedule } = await import("./scheduler.ts");

  const id = String(args.id);
  const deleted = deleteSchedule(id);
  syncSchedule(id);

  if (deleted) {
    const { getWSInstance } = await import("../gateway/ws-instance.ts");
    getWSInstance()?.broadcast({ type: "schedule.deleted" as const, data: { id } });
  }

  return {
    content: [
      {
        type: "text",
        text: deleted
          ? `Schedule ${id} deleted.`
          : `Schedule ${id} not found.`,
      },
    ],
  };
}

handlers.set(DELETE_SCHEDULE_NAME, handleDeleteSchedule);
nativeToolMapping.set(DELETE_SCHEDULE_NAME, { kind: "tool", id: "scheduler" });

// ---------------------------------------------------------------------------
// Webhook tools
// ---------------------------------------------------------------------------

const CREATE_WEBHOOK_NAME = "native__create_webhook";

const createWebhookToolDef = tool({
  description:
    "[Create Webhook] Subscribe to incoming webhooks from external services (GitHub, Notion, Gmail, or any generic webhook). Creates a webhook URL that you give to the external service. When events arrive, the AI processes them using the prompt template and optionally delivers results to a channel.",
  parameters: z.object({
    name: z.string().describe("Human-readable name for this webhook subscription"),
    source: z
      .enum(["github", "notion", "gmail", "generic"])
      .describe("The source service sending webhooks"),
    promptTemplate: z
      .string()
      .describe(
        "Template for the AI prompt when a webhook fires. Use {{event.type}}, {{event.summary}}, {{event.details.*}}, or {{payload}} placeholders."
      ),
    deliverToChannel: z
      .enum(["telegram", "discord", "slack"])
      .optional()
      .describe("Optional channel to deliver the AI response to"),
    filterEventTypes: z
      .array(z.string())
      .optional()
      .describe("Optional event types to filter (e.g. ['pull_request.opened', 'issues.closed'])"),
  }),
});

async function handleCreateWebhook(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const { createWebhookSubscription } = await import("../db/webhook-store.ts");
  const { getWSInstance } = await import("../gateway/ws-instance.ts");

  const name = String(args.name);
  const source = String(args.source) as "github" | "notion" | "gmail" | "generic";
  const promptTemplate = String(args.promptTemplate);

  let deliverTo = null;
  if (args.deliverToChannel && context?.channelId) {
    deliverTo = [
      {
        channelType: String(args.deliverToChannel) as "telegram" | "discord" | "slack",
        channelId: context.channelId,
      },
    ];
  }

  const filters = args.filterEventTypes
    ? { eventTypes: args.filterEventTypes as string[] }
    : null;

  const sub = createWebhookSubscription({
    name,
    source,
    promptTemplate,
    deliverTo,
    filters,
  });

  getWSInstance()?.broadcast({ type: "webhook.created", data: sub });

  return {
    content: [
      {
        type: "text",
        text: `Webhook subscription created!\n\n**Name:** ${sub.name}\n**Source:** ${sub.source}\n**ID:** ${sub.id}\n\n**Webhook URL:** \`/api/webhooks/${sub.id}/receive\`\n**Secret:** \`${sub.secret}\`\n\nConfigure the external service to send webhooks to the URL above. ${source === "github" ? "In GitHub, paste the secret into the webhook settings for HMAC-SHA256 signature verification." : source === "generic" ? "Sign the request body with HMAC-SHA256 using the secret and send it in the X-Webhook-Signature-256 header as `sha256=<hex>`." : ""}`,
      },
    ],
  };
}

handlers.set(CREATE_WEBHOOK_NAME, handleCreateWebhook);
nativeToolMapping.set(CREATE_WEBHOOK_NAME, { kind: "tool", id: "webhooks" });

const LIST_WEBHOOKS_NAME = "native__list_webhooks";

const listWebhooksToolDef = tool({
  description:
    "[List Webhooks] List all webhook subscriptions with their status and last received info.",
  parameters: z.object({}),
});

async function handleListWebhooks(): Promise<NativeToolResult> {
  const { listWebhookSubscriptions } = await import("../db/webhook-store.ts");
  const subs = listWebhookSubscriptions();
  if (subs.length === 0) {
    return {
      content: [{ type: "text", text: "No webhook subscriptions found." }],
    };
  }

  const lines = subs.map((s) => {
    const status = s.enabled ? "enabled" : "paused";
    const lastReceived = s.lastReceivedAt ?? "never";
    const delivery =
      s.deliverTo && s.deliverTo.length > 0
        ? ` → ${s.deliverTo.map((d) => d.channelType).join(", ")}`
        : "";
    return `- [${status}] "${s.name}" (${s.source}) | last received: ${lastReceived}${delivery} | id: ${s.id}`;
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

handlers.set(LIST_WEBHOOKS_NAME, handleListWebhooks);
nativeToolMapping.set(LIST_WEBHOOKS_NAME, { kind: "tool", id: "webhooks" });

const DELETE_WEBHOOK_NAME = "native__delete_webhook";

const deleteWebhookToolDef = tool({
  description:
    "[Delete Webhook] Delete a webhook subscription by its ID. Use native__list_webhooks first to find the ID.",
  parameters: z.object({
    id: z.string().describe("The webhook subscription ID to delete"),
  }),
});

async function handleDeleteWebhook(
  args: Record<string, unknown>
): Promise<NativeToolResult> {
  const { deleteWebhookSubscription } = await import("../db/webhook-store.ts");
  const { getWSInstance } = await import("../gateway/ws-instance.ts");

  const id = String(args.id);
  const deleted = deleteWebhookSubscription(id);

  if (deleted) {
    getWSInstance()?.broadcast({ type: "webhook.deleted", data: { id } });
  }

  return {
    content: [
      {
        type: "text",
        text: deleted
          ? `Webhook subscription ${id} deleted.`
          : `Webhook subscription ${id} not found.`,
      },
    ],
  };
}

handlers.set(DELETE_WEBHOOK_NAME, handleDeleteWebhook);
nativeToolMapping.set(DELETE_WEBHOOK_NAME, { kind: "tool", id: "webhooks" });

// ---------------------------------------------------------------------------
// Workflow tools
// ---------------------------------------------------------------------------

const CREATE_WORKFLOW_NAME = "native__create_workflow";
const RUN_WORKFLOW_NAME = "native__run_workflow";
const LIST_WORKFLOWS_NAME = "native__list_workflows";
const DELETE_WORKFLOW_NAME = "native__delete_workflow";

export const WORKFLOW_EXCLUDED_TOOLS = [
  RUN_WORKFLOW_NAME,
  CREATE_WORKFLOW_NAME,
  DELETE_WORKFLOW_NAME,
  LIST_WORKFLOWS_NAME,
  CREATE_SCHEDULE_NAME,
  DELETE_SCHEDULE_NAME,
  LIST_SCHEDULES_NAME,
  CREATE_WEBHOOK_NAME,
  DELETE_WEBHOOK_NAME,
  LIST_WEBHOOKS_NAME,
];

const createWorkflowToolDef = tool({
  description:
    "[Create Workflow] Save a multi-step procedure as a reusable workflow template. Use when the user asks to save, template, or automate a series of steps. The workflow appears on the Brain Canvas and can be run later with native__run_workflow or linked to a schedule.",
  parameters: z.object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "Must be a lowercase slug (letters, digits, hyphens; cannot start with a hyphen)")
      .describe(
        "Unique slug (lowercase, hyphens ok). Used as filename. e.g. 'daily-crm-review'"
      ),
    name: z.string().describe("Display name (e.g. 'Daily CRM Review')"),
    description: z
      .string()
      .describe("Short description of what this workflow accomplishes"),
    category: z
      .enum([
        "ai",
        "communication",
        "data",
        "developer",
        "file",
        "productivity",
        "web",
      ])
      .optional()
      .describe("Workflow category"),
    icon: z
      .string()
      .optional()
      .describe("Icon name (e.g. 'workflow', 'rocket', 'repeat')"),
    steps: z
      .array(z.string())
      .min(1)
      .describe(
        "Ordered list of step instructions. Each step is a clear directive. Use {{param_name}} for parameter placeholders. Example: ['Fetch issues from {{repo_url}}', 'Summarize top {{count}} by priority']"
      ),
    parameters: z
      .array(
        z.object({
          name: z
            .string()
            .describe(
              "Parameter name (snake_case, used in {{name}} placeholders)"
            ),
          type: z
            .enum(["string", "number", "boolean"])
            .describe("Parameter value type"),
          description: z
            .string()
            .describe("Human-readable description of this parameter"),
          required: z
            .boolean()
            .describe("Whether this parameter must be provided at runtime"),
          default: z
            .string()
            .optional()
            .describe("Default value if not provided (as string)"),
        })
      )
      .optional()
      .describe(
        "Parameters that can be customized each time the workflow runs"
      ),
  }),
});

async function handleCreateWorkflow(
  args: Record<string, unknown>
): Promise<NativeToolResult> {
  const id = String(args.id)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  const name = String(args.name);
  const description = String(args.description);
  const category = args.category ? String(args.category) : undefined;
  const icon = args.icon ? String(args.icon) : undefined;
  const steps = args.steps as string[];
  const parameters = (args.parameters ?? []) as Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
    default?: string;
  }>;

  // Guard: prevent overwriting bundled skills
  const { getSkill: lookupWorkflowSkill } = await import("./capability-loader.ts");
  const existingWf = lookupWorkflowSkill(id);
  if (existingWf?.source === "bundled") {
    return {
      content: [{ type: "text", text: `Cannot create workflow "${id}" — a bundled skill with this ID exists. Choose a different ID.` }],
    };
  }

  // Build YAML frontmatter
  const frontmatter: string[] = [
    `name: ${sanitizeYamlValue(name)}`,
    `description: ${sanitizeYamlValue(description)}`,
    `version: 1.0.0`,
    `type: workflow`,
  ];
  if (category) frontmatter.push(`category: ${sanitizeYamlValue(category)}`);
  if (icon) frontmatter.push(`icon: ${sanitizeYamlValue(icon)}`);

  // Serialize parameters as YAML inputs
  if (parameters.length > 0) {
    frontmatter.push("inputs:");
    for (const p of parameters) {
      frontmatter.push(`  - name: ${sanitizeYamlValue(p.name)}`);
      frontmatter.push(`    type: ${p.type}`);
      frontmatter.push(
        `    description: ${sanitizeYamlValue(p.description)}`
      );
      frontmatter.push(`    required: ${p.required}`);
      if (p.default !== undefined) {
        frontmatter.push(`    default: ${sanitizeYamlValue(p.default)}`);
      }
    }
  }

  // Build body as numbered steps
  const body = steps.map((step, i) => `${i + 1}. ${step}`).join("\n");

  const content = `---\n${frontmatter.join("\n")}\n---\n${body}\n`;

  mkdirSync(USER_SKILLS_DIR, { recursive: true });
  const filePath = join(USER_SKILLS_DIR, `${id}.md`);
  writeFileSync(filePath, content, "utf8");

  // reloadAll() is called by the orchestrator after this tool returns
  // (same pattern as native__create_skill)

  return {
    content: [
      {
        type: "text",
        text: `Workflow "${name}" (id: ${id}) created with ${steps.length} steps and ${parameters.length} parameters. Saved to ${filePath}. It will appear on the Brain Canvas and can be run with native__run_workflow or linked to a schedule.`,
      },
    ],
  };
}

handlers.set(CREATE_WORKFLOW_NAME, handleCreateWorkflow);
nativeToolMapping.set(CREATE_WORKFLOW_NAME, {
  kind: "skill",
  id: "workflows",
});

const runWorkflowToolDef = tool({
  description:
    "[Run Workflow] Execute a saved workflow by its ID. Resolves parameters (user-provided or defaults), substitutes them into the steps, and runs the procedure. Use native__list_workflows first if you need to find the workflow ID.",
  parameters: z.object({
    workflowId: z
      .string()
      .describe(
        "The workflow ID (slug) to execute. Same as the filename without .md extension."
      ),
    parameters: z
      .record(z.string())
      .optional()
      .describe(
        "Parameter values as key-value pairs. Keys must match parameter names defined in the workflow. Values are always strings. Missing optional parameters use their defaults."
      ),
  }),
});

async function handleRunWorkflow(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const { getSkill } = await import("./capability-loader.ts");
  const { executeConversation } = await import("./orchestrator.ts");

  const workflowId = String(args.workflowId);
  const userParams = (args.parameters ?? {}) as Record<string, string>;

  // 1. Load the workflow
  const skill = getSkill(workflowId);

  if (!skill) {
    return {
      content: [
        {
          type: "text",
          text: `Workflow "${workflowId}" not found. Use native__list_workflows to see available workflows.`,
        },
      ],
    };
  }

  if (skill.skillType !== "workflow") {
    return {
      content: [
        {
          type: "text",
          text: `"${workflowId}" is a ${skill.skillType} skill, not a workflow. Only workflow-type skills can be executed with this tool.`,
        },
      ],
    };
  }

  // 2. Resolve parameters + substitute placeholders (single-pass)
  const definedParams = skill.metadata.inputs ?? [];
  const { missing, instructions } = resolveWorkflowParams(
    definedParams,
    userParams,
    skill.instructions
  );

  // 3. Fail early if required params are missing
  if (missing.length > 0) {
    const paramDetails = missing.map((name) => {
      const def = definedParams.find((p) => p.name === name);
      return `  - ${name}: ${def?.description ?? "(no description)"}`;
    });
    return {
      content: [
        {
          type: "text",
          text: `Cannot run workflow "${skill.metadata.name}": missing required parameter(s):\n${paramDetails.join("\n")}\n\nProvide these in the 'parameters' field.`,
        },
      ],
    };
  }

  // 4. Construct execution prompt
  const executionPrompt = `[WORKFLOW EXECUTION: "${skill.metadata.name}"]\n\nExecute the following workflow steps in order. Complete each step fully before moving to the next. Use your available tools as needed.\n\n${instructions}`;

  // 5. Run through the orchestrator as a sub-conversation
  const messages: import("@chvor/shared").ChatMessage[] = [
    {
      id: `wf-${workflowId}-${Date.now()}`,
      role: "user" as const,
      content: executionPrompt,
      channelType: (context?.channelType ?? "web") as import("@chvor/shared").ChannelType,
      timestamp: new Date().toISOString(),
    },
  ];

  const emit = context?.emitEvent ?? (() => {});

  try {
    const result = await executeConversation(
      messages,
      emit,
      undefined,
      undefined,
      {
        excludeTools: WORKFLOW_EXCLUDED_TOOLS,
        extraRounds: 5,
        channelType: context?.channelType,
        channelId: context?.channelId,
        sessionId: context?.sessionId,
      }
    );

    // Log to activity feed
    insertActivity({
      source: "workflow",
      title: `Workflow: ${skill.metadata.name}`,
      content: result.text.slice(0, 2000),
    });

    return {
      content: [
        {
          type: "text",
          text: `Workflow "${skill.metadata.name}" completed.\n\n${result.text}`,
        },
      ],
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Workflow "${skill.metadata.name}" failed: ${errorMsg}`,
        },
      ],
    };
  }
}

handlers.set(RUN_WORKFLOW_NAME, handleRunWorkflow);
nativeToolMapping.set(RUN_WORKFLOW_NAME, { kind: "skill", id: "workflows" });

const listWorkflowsToolDef = tool({
  description:
    "[List Workflows] List all saved workflows with their parameters and step counts.",
  parameters: z.object({}),
});

async function handleListWorkflows(): Promise<NativeToolResult> {
  const { loadSkills } = await import("./capability-loader.ts");
  const workflows = loadSkills().filter(
    (s) => s.skillType === "workflow"
  );

  if (workflows.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No workflows found. Create one with native__create_workflow.",
        },
      ],
    };
  }

  const lines = workflows.map((w) => {
    const paramCount = w.metadata.inputs?.length ?? 0;
    const stepCount = w.instructions
      .split("\n")
      .filter((l) => /^\d+\./.test(l.trim())).length;
    const params =
      paramCount > 0
        ? ` | params: ${(w.metadata.inputs ?? []).map((p) => `${p.name}${p.required ? "*" : ""}`).join(", ")}`
        : "";
    return `- "${w.metadata.name}" (id: ${w.id}) | ${stepCount} steps${params}`;
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

handlers.set(LIST_WORKFLOWS_NAME, handleListWorkflows);
nativeToolMapping.set(LIST_WORKFLOWS_NAME, {
  kind: "skill",
  id: "workflows",
});

const deleteWorkflowToolDef = tool({
  description:
    "[Delete Workflow] Delete a saved workflow by its ID. Use native__list_workflows first to find the ID.",
  parameters: z.object({
    workflowId: z
      .string()
      .describe("The workflow ID (slug) to delete"),
  }),
});

async function handleDeleteWorkflow(
  args: Record<string, unknown>
): Promise<NativeToolResult> {
  const { getSkill, reloadAll } = await import("./capability-loader.ts");
  const { listSchedules } = await import("../db/schedule-store.ts");

  const workflowId = String(args.workflowId);
  const skill = getSkill(workflowId);

  if (!skill || skill.skillType !== "workflow") {
    return {
      content: [
        {
          type: "text",
          text: `Workflow "${workflowId}" not found.`,
        },
      ],
    };
  }

  // Check for schedules that reference this workflow
  const linkedSchedules = listSchedules().filter(
    (s) => s.workflowId === workflowId
  );

  try {
    unlinkSync(skill.path);
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to delete workflow file: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  reloadAll();

  let warning = "";
  if (linkedSchedules.length > 0) {
    const names = linkedSchedules.map((s) => `"${s.name}" (${s.id})`).join(", ");
    warning = `\n\n⚠ Warning: ${linkedSchedules.length} schedule(s) still reference this workflow and will fail on next run: ${names}. Consider deleting or updating them.`;
  }

  return {
    content: [
      {
        type: "text",
        text: `Workflow "${skill.metadata.name}" (id: ${workflowId}) deleted.${warning}`,
      },
    ],
  };
}

handlers.set(DELETE_WORKFLOW_NAME, handleDeleteWorkflow);
nativeToolMapping.set(DELETE_WORKFLOW_NAME, {
  kind: "skill",
  id: "workflows",
});

// ---------------------------------------------------------------------------
// Credential management tools
// ---------------------------------------------------------------------------
// Lazy imports to avoid circular deps (same pattern as schedule tools).

const ADD_CREDENTIAL_NAME = "native__add_credential";

const addCredentialToolDef = tool({
  description:
    "[Add Credential] Save an API key, bot token, password, or other secret credential. " +
    "Call this IMMEDIATELY when a user shares anything that looks like a secret — API keys, tokens, passwords, webhook URLs with tokens, connection strings. " +
    "Auto-tests the credential and activates any associated channel. " +
    "For unknown services: set usageContext with auth scheme, base URL, and example request. " +
    "Research the service's API docs with native__web_request if unsure how to use the credential.",
  parameters: z.object({
    name: z
      .string()
      .describe("Human-readable name (e.g. 'GitHub Personal Access Token', 'Acme CRM API Key')"),
    type: z
      .string()
      .describe("Service identifier in lowercase kebab-case (e.g., 'github', 'notion', 'acme-crm'). Use the service name, not the key type."),
    data: z
      .record(z.string())
      .describe(
        "Key-value credential fields. Common patterns: { apiKey } for API keys, { botToken } for bots, { username, password } for basic auth, { apiKey, baseUrl } for custom services. Use field names that match the service's terminology."
      ),
    usageContext: z
      .string()
      .optional()
      .describe("REQUIRED for non-standard services. How to authenticate API calls: auth header format, base URL, required headers. Example: 'Authorization: Bearer <apiKey>. Base URL: https://api.example.com/v1'. Auto-inferred for known provider types if omitted."),
  }),
});

async function handleAddCredential(
  args: Record<string, unknown>
): Promise<NativeToolResult> {
  const { createCredential, listCredentials, deleteCredential } = await import("../db/credential-store.ts");
  const { testProvider } = await import("../routes/provider-tester.ts");
  const { tryRestartChannel } = await import("../routes/credentials.ts");
  const { INTEGRATION_PROVIDERS } = await import("./provider-registry.ts");

  const name = String(args.name);
  const type = String(args.type);
  const data = args.data as Record<string, string>;

  // Resolve usageContext: explicit > provider default
  let usageContext = args.usageContext ? String(args.usageContext) : undefined;
  if (!usageContext) {
    const provider = INTEGRATION_PROVIDERS.find((p) => p.credentialType === type);
    if (provider?.usageContext) usageContext = provider.usageContext;
  }

  // Dedup: if same name+type already exists, replace it (create first to avoid data loss)
  const existing = listCredentials().find(
    (c) => c.name.toLowerCase() === name.toLowerCase() && c.type === type
  );

  const summary = createCredential(name, type, data, usageContext);
  if (existing) deleteCredential(existing.id);

  // Auto-test
  let testMsg = "";
  try {
    const result = await testProvider(type, data);
    testMsg = result.success
      ? " Connection tested successfully."
      : ` Test failed: ${result.error}.`;
  } catch {
    testMsg = " Could not auto-test.";
  }

  // Auto-restart channel if applicable
  tryRestartChannel(type);

  // Nudge AI to research usageContext for unknown providers
  const isKnown = INTEGRATION_PROVIDERS.some((p) => p.credentialType === type);
  const contextWarning = (!usageContext && !isKnown)
    ? `\n\nWARNING: No usageContext set and "${type}" is not a known provider. ` +
      `Research this service's API docs with native__web_request and update with native__update_credential to add usageContext. ` +
      `Without it, you won't know how to authenticate API calls later.`
    : "";

  return {
    content: [
      {
        type: "text",
        text: `Credential "${name}" (${type}) saved (id: ${summary.id}).${testMsg}${contextWarning}`,
      },
    ],
  };
}

handlers.set(ADD_CREDENTIAL_NAME, handleAddCredential);
nativeToolMapping.set(ADD_CREDENTIAL_NAME, { kind: "tool", id: "credentials" });

// ---------------------------------------------------------------------------
// Update credential tool
// ---------------------------------------------------------------------------

const UPDATE_CREDENTIAL_NAME = "native__update_credential";

const updateCredentialToolDef = tool({
  description:
    "[Update Credential] Update an existing credential's name and/or data. Use this when a user wants to change/rotate a key or rename a credential. Call native__list_credentials first to get the credential id.",
  parameters: z.object({
    id: z.string().describe("Credential id (from native__list_credentials)"),
    name: z.string().optional().describe("New display name (omit to keep current)"),
    data: z
      .record(z.string())
      .optional()
      .describe(
        "New credential data fields. Only include fields you want to change. Same format as native__add_credential data."
      ),
  }),
});

async function handleUpdateCredential(
  args: Record<string, unknown>
): Promise<NativeToolResult> {
  const { updateCredential, getCredentialData } = await import("../db/credential-store.ts");
  const { testProvider } = await import("../routes/provider-tester.ts");
  const { tryRestartChannel } = await import("../routes/credentials.ts");
  const { invalidateToolCache } = await import("../lib/tool-builder.ts");
  const { mcpManager } = await import("../lib/mcp-manager.ts");

  const id = String(args.id);
  const newName = args.name ? String(args.name) : undefined;
  const newData = args.data as Record<string, string> | undefined;

  if (!newName && !newData) {
    return { content: [{ type: "text", text: "Nothing to update — provide name or data." }] };
  }

  const summary = updateCredential(id, newName, newData);
  if (!summary) {
    return { content: [{ type: "text", text: `Credential ${id} not found.` }] };
  }

  // Auto-test with updated data
  let testMsg = "";
  if (newData) {
    try {
      const updatedRecord = getCredentialData(id);
      if (updatedRecord) {
        const result = await testProvider(updatedRecord.cred.type, updatedRecord.data);
        testMsg = result.success
          ? " Connection tested successfully."
          : ` Test failed: ${result.error}.`;
      }
    } catch {
      testMsg = " Could not auto-test.";
    }
    tryRestartChannel(summary.type);
    // Refresh MCP connections and tool cache so tools use the new credentials
    try {
      await mcpManager.closeConnectionsForCredential(summary.type);
      invalidateToolCache();
    } catch (err) {
      console.error(`[update_credential] tool refresh failed for ${summary.type}:`, err);
    }
  }

  return {
    content: [
      {
        type: "text",
        text: `Credential "${summary.name}" (${summary.type}) updated.${testMsg}`,
      },
    ],
  };
}

handlers.set(UPDATE_CREDENTIAL_NAME, handleUpdateCredential);
nativeToolMapping.set(UPDATE_CREDENTIAL_NAME, { kind: "tool", id: "credentials" });

const LIST_CREDENTIALS_NAME = "native__list_credentials";

const listCredentialsToolDef = tool({
  description:
    "[List Credentials] List all saved credentials with their type, status, and redacted values.",
  parameters: z.object({}),
});

async function handleListCredentials(): Promise<NativeToolResult> {
  const { listCredentials } = await import("../db/credential-store.ts");
  const { INTEGRATION_PROVIDERS } = await import("./provider-registry.ts");
  const creds = listCredentials();
  if (creds.length === 0) {
    return { content: [{ type: "text", text: "No credentials saved yet." }] };
  }
  const lines = creds.map((c) => {
    const status = c.testStatus ?? "untested";
    const fields = Object.entries(c.redactedFields)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    // Resolve usage context: stored on credential > provider default
    const usage = c.usageContext
      ?? INTEGRATION_PROVIDERS.find((p) => p.credentialType === c.type)?.usageContext;
    const usageSuffix = usage ? ` | Usage: ${usage}` : "";
    return `- [${status}] "${c.name}" (${c.type}) | ${fields} | id: ${c.id}${usageSuffix}`;
  });
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

handlers.set(LIST_CREDENTIALS_NAME, handleListCredentials);
nativeToolMapping.set(LIST_CREDENTIALS_NAME, { kind: "tool", id: "credentials" });

const USE_CREDENTIAL_NAME = "native__use_credential";

const useCredentialToolDef = tool({
  description:
    "[Use Credential] Retrieve full (unredacted) credential data by ID for making authenticated API calls. Use native__list_credentials first to find the ID, then this tool to get the actual secret values needed for request headers.",
  parameters: z.object({
    id: z.string().describe("The credential ID to retrieve"),
  }),
});

async function handleUseCredential(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const { getCredentialData } = await import("../db/credential-store.ts");
  const { INTEGRATION_PROVIDERS } = await import("./provider-registry.ts");
  const { registerSecretValues } = await import("./sensitive-filter.ts");

  const result = getCredentialData(String(args.id));
  if (!result) {
    return { content: [{ type: "text", text: "Credential not found." }] };
  }

  // Audit log
  try {
    const { insertActivity } = await import("../db/activity-store.ts");
    insertActivity({
      source: "credential-access",
      title: `Credential used: "${result.cred.name}" (${result.cred.type})`,
      content: `Credential ${args.id} accessed via native__use_credential${context?.sessionId ? ` in session ${context.sessionId}` : ""}`,
    });
  } catch { /* best-effort logging */ }

  // Register secret values for dynamic redaction
  const secretValues = Object.values(result.data).filter((v) => v.length >= 4);
  if (secretValues.length > 0) registerSecretValues(secretValues);

  const fields = Object.entries(result.data)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  // Resolve usage context
  const usage = result.cred.usageContext
    ?? INTEGRATION_PROVIDERS.find((p) => p.credentialType === result.cred.type)?.usageContext;
  const usageHint = usage ? `\n\nUsage: ${usage}` : "";

  return {
    content: [
      {
        type: "text",
        text: `IMPORTANT: Use these values ONLY in tool call parameters (headers, body). Never display them in your response.\n\nCredential "${result.cred.name}" (${result.cred.type}):\n${fields}${usageHint}`,
      },
    ],
  };
}

handlers.set(USE_CREDENTIAL_NAME, handleUseCredential);
nativeToolMapping.set(USE_CREDENTIAL_NAME, { kind: "tool", id: "credentials" });

const DELETE_CREDENTIAL_NAME = "native__delete_credential";

const deleteCredentialToolDef = tool({
  description:
    "[Delete Credential] Remove a saved credential by its ID. Use native__list_credentials first to find the ID.",
  parameters: z.object({
    id: z.string().describe("The credential ID to delete"),
  }),
});

async function handleDeleteCredential(
  args: Record<string, unknown>
): Promise<NativeToolResult> {
  const { getCredentialData, deleteCredential } = await import(
    "../db/credential-store.ts"
  );
  const { tryRestartChannel } = await import("../routes/credentials.ts");

  const id = String(args.id);
  const record = getCredentialData(id);
  const deleted = deleteCredential(id);

  if (!deleted) {
    return {
      content: [{ type: "text", text: `Credential ${id} not found.` }],
    };
  }

  if (record) tryRestartChannel(record.cred.type);

  return {
    content: [
      {
        type: "text",
        text: `Credential "${record?.cred.name}" (${record?.cred.type}) deleted.`,
      },
    ],
  };
}

handlers.set(DELETE_CREDENTIAL_NAME, handleDeleteCredential);
nativeToolMapping.set(DELETE_CREDENTIAL_NAME, { kind: "tool", id: "credentials" });

const TEST_CREDENTIAL_NAME = "native__test_credential";

const testCredentialToolDef = tool({
  description:
    "[Test Credential] Verify that a saved credential works (e.g. test API key or bot token connectivity). Use native__list_credentials first to find the ID.",
  parameters: z.object({
    id: z.string().describe("The credential ID to test"),
  }),
});

async function handleTestCredential(
  args: Record<string, unknown>
): Promise<NativeToolResult> {
  const { getCredentialData, updateTestStatus } = await import(
    "../db/credential-store.ts"
  );
  const { testProvider } = await import("../routes/provider-tester.ts");
  const { tryRestartChannel } = await import("../routes/credentials.ts");

  const id = String(args.id);
  const record = getCredentialData(id);
  if (!record) {
    return {
      content: [{ type: "text", text: `Credential ${id} not found.` }],
    };
  }

  const result = await testProvider(record.cred.type, record.data);
  updateTestStatus(id, result.success ? "success" : "failed");

  if (result.success) tryRestartChannel(record.cred.type);

  return {
    content: [
      {
        type: "text",
        text: result.success
          ? `Credential "${record.cred.name}" (${record.cred.type}) tested successfully.`
          : `Credential "${record.cred.name}" test failed: ${result.error}`,
      },
    ],
  };
}

handlers.set(TEST_CREDENTIAL_NAME, handleTestCredential);
nativeToolMapping.set(TEST_CREDENTIAL_NAME, { kind: "tool", id: "credentials" });

// ---------------------------------------------------------------------------
// Model switching tool
// ---------------------------------------------------------------------------

const SWITCH_MODEL_NAME = "native__switch_model";

const switchModelToolDef = tool({
  description:
    "[Switch Model] Change which AI model is used for conversations. " +
    "Use `action: \"list\"` to see available providers and models. " +
    "Use `action: \"switch\"` with a provider and model to change. " +
    "Use `action: \"rollback\"` to revert to the previous model if something goes wrong. " +
    "Rollback supports one level only and is not persisted across restarts. " +
    "The switch takes effect starting from the next message.",
  parameters: z.object({
    action: z.enum(["list", "switch", "rollback"]).describe("list = show available models, switch = change model, rollback = revert to previous"),
    providerId: z.string().optional().describe("Provider ID (e.g. 'anthropic', 'openai', 'google')"),
    model: z.string().optional().describe("Model ID (e.g. 'claude-sonnet-4-6', 'gpt-4o')"),
    role: z.enum(["primary", "reasoning", "lightweight", "heartbeat"]).optional()
      .describe("Which role to change. Defaults to 'primary'."),
  }),
});

// Store previous config per role for rollback
const _previousModelConfigs = new Map<string, { providerId: string; model: string }>();

async function handleSwitchModel(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  const action = args.action as string;
  const role = (args.role as string) ?? "primary";

  if (action === "list") {
    const { fetchModelsForProvider } = await import("./model-fetcher.ts");
    const { LLM_PROVIDERS } = await import("./provider-registry.ts");
    const { listCredentials } = await import("../db/credential-store.ts");
    const { getRoleConfig } = await import("../db/config-store.ts");

    const creds = listCredentials();
    const current = getRoleConfig(role as import("@chvor/shared").ModelRole);
    const lines: string[] = [];

    if (current) {
      lines.push(`Current ${role} model: ${current.providerId}/${current.model}`);
    } else {
      lines.push(`No ${role} model configured (using auto-detect).`);
    }
    lines.push("", "Available providers and models:");

    for (const p of LLM_PROVIDERS) {
      const hasCred = creds.some(
        (c) => c.type === p.credentialType && c.testStatus === "success",
      );
      if (!hasCred) continue;
      const { models } = await fetchModelsForProvider(p.id);
      if (models.length === 0) {
        lines.push(`- ${p.id}: (free-text — type any model name)`);
      } else {
        const modelList = models.slice(0, 10).map((m) => m.id).join(", ");
        const more = models.length > 10 ? ` (+${models.length - 10} more)` : "";
        lines.push(`- ${p.id}: ${modelList}${more}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (action === "switch") {
    const providerId = args.providerId as string;
    const model = args.model as string;
    if (!providerId || !model) {
      return {
        content: [{ type: "text", text: "Error: providerId and model are required for switch action." }],
      };
    }

    const { LLM_PROVIDERS } = await import("./provider-registry.ts");
    const { listCredentials } = await import("../db/credential-store.ts");
    const { setRoleConfig, getRoleConfig } = await import("../db/config-store.ts");
    const { fetchModelsForProvider } = await import("./model-fetcher.ts");

    // Validate provider exists
    const provDef = LLM_PROVIDERS.find((p) => p.id === providerId);
    if (!provDef) {
      const available = LLM_PROVIDERS.map((p) => p.id).join(", ");
      return {
        content: [{ type: "text", text: `Unknown provider: "${providerId}". Available: ${available}` }],
      };
    }

    // Validate credential exists
    const creds = listCredentials();
    const hasCred = creds.some(
      (c) => c.type === provDef.credentialType && c.testStatus !== "failed",
    );
    if (!hasCred) {
      return {
        content: [{ type: "text", text: `No valid credential for ${providerId}. Add one first.` }],
      };
    }

    // Pre-flight: check model exists in provider's model list (when available)
    const { models: availableModels } = await fetchModelsForProvider(providerId);
    if (availableModels.length > 0 && !availableModels.some((m) => m.id === model)) {
      const suggestions = availableModels.slice(0, 8).map((m) => m.id).join(", ");
      return {
        content: [
          { type: "text", text: `Model "${model}" not found for ${providerId}. Available: ${suggestions}` },
        ],
      };
    }

    // Save previous config for rollback
    const prev = getRoleConfig(role as import("@chvor/shared").ModelRole);
    if (prev) _previousModelConfigs.set(role, prev);

    setRoleConfig(role as import("@chvor/shared").ModelRole, providerId, model);
    return {
      content: [
        {
          type: "text",
          text: `Switched ${role} model to ${providerId}/${model}. Takes effect on next message.${prev ? ` Previous: ${prev.providerId}/${prev.model} (use "rollback" to revert).` : ""}`,
        },
      ],
    };
  }

  if (action === "rollback") {
    const { setRoleConfig } = await import("../db/config-store.ts");
    const prev = _previousModelConfigs.get(role);
    if (!prev) {
      return {
        content: [{ type: "text", text: `No previous ${role} config to roll back to.` }],
      };
    }
    setRoleConfig(role as import("@chvor/shared").ModelRole, prev.providerId, prev.model);
    _previousModelConfigs.delete(role);
    return {
      content: [
        { type: "text", text: `Rolled back ${role} model to ${prev.providerId}/${prev.model}.` },
      ],
    };
  }

  return {
    content: [{ type: "text", text: "Unknown action. Use 'list', 'switch', or 'rollback'." }],
  };
}

handlers.set(SWITCH_MODEL_NAME, handleSwitchModel);
nativeToolMapping.set(SWITCH_MODEL_NAME, { kind: "tool", id: "models" });

// ---------------------------------------------------------------------------
// Browser Agent tools
// ---------------------------------------------------------------------------
// Lazy import to avoid loading Stagehand (and Playwright) at startup.
// The browser-manager module handles session lifecycle.

const BROWSER_NAVIGATE_NAME = "native__browser_navigate";
const BROWSER_ACT_NAME = "native__browser_act";
const BROWSER_EXTRACT_NAME = "native__browser_extract";
const BROWSER_OBSERVE_NAME = "native__browser_observe";
const BROWSER_OP_TIMEOUT = 60_000; // 60 seconds

function requireSessionId(context?: NativeToolContext): string {
  const id = context?.sessionId;
  if (!id) {
    console.warn("[browser-tools] missing sessionId in context, using 'default'");
  }
  return id ?? "default";
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Check if an error indicates the browser session is dead and evict it. */
async function evictIfBrowserDead(err: unknown, sessionId: string): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  const deadPatterns = [
    "Target closed",
    "Browser has been closed",
    "browser has disconnected",
    "Session closed",
    "Execution context was destroyed",
    "timed out",
  ];
  if (deadPatterns.some((p) => msg.includes(p))) {
    console.warn(`[browser-tools] evicting dead session ${sessionId}: ${msg}`);
    logError("browser_error", err, { sessionId, evicted: true });
    const { closeBrowser } = await import("./browser-manager.ts");
    await closeBrowser(sessionId).catch(() => {});
  }
}

const browserNavigateToolDef = tool({
  description:
    "[Web Agent] Navigate to a URL. Use this as the first step when browsing the web. Returns the page title and final URL.",
  parameters: z.object({
    url: z.string().describe("The URL to navigate to (e.g. 'https://google.com')"),
  }),
});

async function handleBrowserNavigate(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const sessionId = requireSessionId(context);
  const rawUrl = String(args.url);

  // SSRF protection: validate URL before navigating (same rules as http_fetch)
  try {
    await validateFetchUrl(rawUrl);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Browser navigate blocked: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }

  try {
    const { getBrowser } = await import("./browser-manager.ts");
    const stagehand = await getBrowser(sessionId);
    await withTimeout(
      stagehand.page.goto(rawUrl, { waitUntil: "domcontentloaded" }),
      BROWSER_OP_TIMEOUT,
      "Navigation",
    );
    const title = await stagehand.page.title();
    const url = stagehand.page.url();
    return {
      content: [{ type: "text", text: `Navigated to: ${url}\nPage title: ${title}` }],
    };
  } catch (err) {
    await evictIfBrowserDead(err, sessionId);
    return {
      content: [{ type: "text", text: `Browser navigate failed: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}

handlers.set(BROWSER_NAVIGATE_NAME, handleBrowserNavigate);
nativeToolMapping.set(BROWSER_NAVIGATE_NAME, { kind: "tool", id: "web-agent" });

const browserActToolDef = tool({
  description:
    "[Web Agent] Perform an action on the current page using natural language. Examples: 'click the Sign In button', 'type hello@example.com in the email field', 'scroll down', 'select the second item from the dropdown'.",
  parameters: z.object({
    instruction: z
      .string()
      .describe("Natural language instruction for the action to perform"),
  }),
});

async function handleBrowserAct(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const sessionId = requireSessionId(context);
  try {
    const { getBrowser } = await import("./browser-manager.ts");
    const stagehand = await getBrowser(sessionId);
    const result = await withTimeout(
      stagehand.page.act(String(args.instruction)),
      BROWSER_OP_TIMEOUT,
      "Action",
    );
    return {
      content: [{ type: "text", text: result ? `Action completed: ${JSON.stringify(result)}` : "Action completed successfully." }],
    };
  } catch (err) {
    await evictIfBrowserDead(err, sessionId);
    return {
      content: [{ type: "text", text: `Browser action failed: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}

handlers.set(BROWSER_ACT_NAME, handleBrowserAct);
nativeToolMapping.set(BROWSER_ACT_NAME, { kind: "tool", id: "web-agent" });

const browserExtractToolDef = tool({
  description:
    "[Web Agent] Extract structured data from the current page. Describe what data you want and the AI will find and extract it. Example: 'get all product names and prices', 'extract the main article text'.",
  parameters: z.object({
    instruction: z
      .string()
      .describe("What data to extract from the current page"),
  }),
});

async function handleBrowserExtract(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const sessionId = requireSessionId(context);
  try {
    const { getBrowser } = await import("./browser-manager.ts");
    const stagehand = await getBrowser(sessionId);
    const result = await withTimeout(
      stagehand.page.extract({ instruction: String(args.instruction) }),
      BROWSER_OP_TIMEOUT,
      "Extract",
    );
    let text: string;
    try {
      text = typeof result === "string" ? result : JSON.stringify(result);
    } catch {
      text = "[Extract returned non-serializable data]";
    }
    return {
      content: [{ type: "text", text: text.length > 50_000 ? text.slice(0, 50_000) + "\n\n[...truncated]" : text }],
    };
  } catch (err) {
    await evictIfBrowserDead(err, sessionId);
    return {
      content: [{ type: "text", text: `Browser extract failed: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}

handlers.set(BROWSER_EXTRACT_NAME, handleBrowserExtract);
nativeToolMapping.set(BROWSER_EXTRACT_NAME, { kind: "tool", id: "web-agent" });

const browserObserveToolDef = tool({
  description:
    "[Web Agent] Observe the current page to see what actions are available. Optionally focus on specific elements. Returns a list of possible actions. Useful before deciding what to click or interact with.",
  parameters: z.object({
    instruction: z
      .string()
      .optional()
      .describe("Optional: what to look for (e.g. 'find login form elements'). If omitted, returns all visible interactive elements."),
  }),
});

async function handleBrowserObserve(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const sessionId = requireSessionId(context);
  try {
    const { getBrowser } = await import("./browser-manager.ts");
    const stagehand = await getBrowser(sessionId);
    const instruction = args.instruction ? String(args.instruction) : undefined;
    const observations = await withTimeout(
      stagehand.page.observe(instruction ? { instruction } : {}),
      BROWSER_OP_TIMEOUT,
      "Observe",
    );
    let text: string;
    try {
      text = JSON.stringify(observations);
    } catch {
      text = "[Observe returned non-serializable data]";
    }
    return {
      content: [{ type: "text", text: text.length > 50_000 ? text.slice(0, 50_000) + "\n\n[...truncated]" : text }],
    };
  } catch (err) {
    await evictIfBrowserDead(err, sessionId);
    return {
      content: [{ type: "text", text: `Browser observe failed: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}

handlers.set(BROWSER_OBSERVE_NAME, handleBrowserObserve);
nativeToolMapping.set(BROWSER_OBSERVE_NAME, { kind: "tool", id: "web-agent" });

// ---------------------------------------------------------------------------
// Shell Execute tool
// ---------------------------------------------------------------------------
import { classifyCommand } from "./command-classifier.ts";
import type { ClassificationResult } from "./command-classifier.ts";
import { logShellExecution } from "./shell-audit.ts";

const SHELL_EXECUTE_NAME = "native__shell_execute";
const MAX_OUTPUT = 50_000;
const APPROVAL_TIMEOUT_MS = 120_000; // 2 minutes

const shellExecuteToolDef = tool({
  description:
    "[System Control] Execute a shell command on the host machine. " +
    "Commands are auto-classified by risk: SAFE (ls, cat, pwd, grep, find, ps, df) auto-execute; " +
    "MODERATE (mkdir, cp, mv, npm, git, curl, docker) and DANGEROUS (rm, kill, sudo, shutdown) require user approval; " +
    "BLOCKED patterns (fork bombs, raw disk writes) are rejected outright. " +
    "Prefer SAFE commands — they execute instantly without interrupting the user. " +
    "Chain multiple safe commands rather than risky all-in-one patterns. " +
    "Always specify workingDir when the command is path-sensitive. " +
    "On Windows use PowerShell syntax (Get-ChildItem, Remove-Item); on macOS/Linux use bash/zsh. " +
    "When a command needs approval, briefly explain WHY it's necessary before the user sees the prompt. " +
    "If a command is denied, suggest a safer alternative.",
  parameters: z.object({
    command: z.string().describe("The shell command to execute"),
    workingDir: z
      .string()
      .optional()
      .describe("Working directory (defaults to user home)"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Timeout in ms (default: 30000, max: 300000)"),
  }),
});

// --- Approval system ---

const MAX_PENDING_APPROVALS = 50;

const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout>; command: string }
>();

async function requestApproval(
  command: string,
  workingDir: string,
  classification: ClassificationResult,
  context?: NativeToolContext
): Promise<{ approved: boolean; requestId: string }> {
  // Check trusted commands — auto-approve if matched
  const isPc = /^PC (Task|shell):/i.test(command);
  if (isTrustedCommand(command, isPc)) {
    return { approved: true, requestId: "trusted-auto" };
  }

  // Prevent unbounded growth of pending approvals
  if (pendingApprovals.size >= MAX_PENDING_APPROVALS) {
    return { approved: false, requestId: "limit-exceeded" };
  }

  const requestId = randomUUID();

  // Send confirmation request via WS
  const { getWSInstance } = await import("../gateway/ws-instance.ts");
  const ws = getWSInstance();

  const confirmEvent: GatewayServerEvent = {
    type: "command.confirm",
    data: {
      requestId,
      command,
      workingDir,
      tier: classification.tier,
      classifiedCommands: classification.subCommands,
      timestamp: new Date().toISOString(),
    },
  };

  // Route to originating client if web, or broadcast
  if (context?.originClientId) {
    ws?.sendTo(context.originClientId, confirmEvent);
  } else {
    ws?.broadcast(confirmEvent);
  }

  // For non-web channels, send approval prompt (with inline buttons if supported)
  if (context?.channelType && context.channelType !== "web" && context.channelId) {
    const { getGatewayInstance } = await import("../gateway/gateway-instance.ts");
    const gw = getGatewayInstance();
    if (gw) {
      const channel = gw.getChannel(context.channelType);
      if (channel?.sendApproval) {
        await channel.sendApproval(context.channelId, requestId, command, classification.tier);
      } else {
        // Fallback for channels without inline approval buttons
        const tierEmoji = classification.tier === "dangerous" ? "\u{1f534}" : "\u{1f7e1}";
        await gw.sendToChannel(
          context.channelType,
          context.channelId,
          `${tierEmoji} **Command requires approval:**\n\`\`\`\n${command}\n\`\`\`\nRisk: ${classification.tier.toUpperCase()}\n\nApprove or deny this command in the web dashboard.`
        );
      }
    }
  }

  const approved = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(requestId, { resolve, timer, command });
  });

  return { approved, requestId };
}

/** Called when user responds to a command.confirm event. */
export function resolveApproval(requestId: string, approved: boolean, alwaysAllow?: boolean): boolean {
  const pending = pendingApprovals.get(requestId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingApprovals.delete(requestId);

  // If approved with alwaysAllow, store the trusted pattern
  if (approved && alwaysAllow && pending.command) {
    const isPc = /^PC (Task|shell):/i.test(pending.command);
    if (isPc) {
      const cleaned = pending.command.replace(/^PC (Task|shell):\s*/i, "");
      const firstWord = cleaned.split(/\s+/)[0]?.toLowerCase() ?? "";
      if (firstWord) addTrustedCommand("pc", firstWord);
    } else {
      // Store 3 tokens (binary + subcommand + first arg) for more precise matching
      // e.g. "npm install express" not just "npm install" which would approve any package
      const parts = pending.command.trim().split(/\s+/);
      const pattern = parts.slice(0, Math.min(parts.length, 3)).join(" ").toLowerCase();
      if (pattern) addTrustedCommand("shell", pattern);
    }
  }

  pending.resolve(approved);
  return true;
}

// --- Shell execution (cross-platform) ---

function getShellConfig(): { shell: string; shellFlag: string } {
  if (process.platform === "win32") {
    return { shell: "powershell.exe", shellFlag: "-Command" };
  }
  const shellEnv = process.env.SHELL || "/bin/bash";
  return { shell: shellEnv, shellFlag: "-c" };
}

// Whitelist safe env vars — never leak API keys, tokens, or secrets to child processes
const SAFE_ENV_KEYS = [
  "PATH", "HOME", "USERPROFILE", "USER", "USERNAME", "LOGNAME",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "COMSPEC",
  "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES",
  "NODE_ENV", "EDITOR", "VISUAL", "PAGER",
];

function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

function executeCommand(
  command: string,
  workingDir: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const { shell, shellFlag } = getShellConfig();
  const start = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(shell, [shellFlag, command], {
      cwd: workingDir,
      env: buildSafeEnv(),
      timeout: timeoutMs,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT) + "\n[...truncated]";
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT) + "\n[...truncated]";
      }
    });

    // Force-kill if process ignores SIGTERM after timeout
    proc.on("close", (code, signal) => {
      resolve({
        stdout: stdout.trimEnd(),
        stderr: signal === "SIGKILL"
          ? (stderr.trimEnd() + "\n[process killed after timeout]").trimStart()
          : stderr.trimEnd(),
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      // Node fires 'error' with code ETIMEDOUT when spawn timeout triggers —
      // escalate to SIGKILL in case the process ignored SIGTERM
      if (!proc.killed) {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }
      resolve({
        stdout: stdout.trimEnd(),
        stderr: err.message,
        exitCode: 1,
        durationMs: Date.now() - start,
      });
    });
  });
}

function formatShellOutput(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
  if (parts.length === 0) parts.push("(no output)");
  parts.push(`\n[exit code: ${result.exitCode}, ${result.durationMs}ms]`);
  return parts.join("\n");
}

async function handleShellExecute(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const command = String(args.command);
  const workingDir = args.workingDir ? String(args.workingDir) : homedir();
  const timeoutMs = Math.min(Number(args.timeoutMs) || 30_000, 300_000);

  // Validate working directory
  try {
    const s = statSync(workingDir);
    if (!s.isDirectory()) {
      return {
        content: [{ type: "text", text: `Working directory is not a directory: ${workingDir}` }],
      };
    }
  } catch {
    return {
      content: [{ type: "text", text: `Working directory does not exist: ${workingDir}` }],
    };
  }

  // 1. Classify (includes blocked pattern detection)
  const classification = classifyCommand(command);

  // 2. Blocked — reject immediately
  if (classification.tier === "blocked") {
    logShellExecution({
      command,
      workingDir,
      tier: "blocked",
      approved: false,
      deniedReason: "blocked pattern",
      durationMs: 0,
      sessionId: context?.sessionId,
    });
    return {
      content: [{ type: "text", text: "Command blocked: this command pattern is never allowed for safety reasons." }],
    };
  }

  // 3. Approval gate (respects configured approval mode)
  const approvalMode = getShellApprovalConfig().approvalMode;

  if (approvalMode === "block_all" && classification.tier !== "safe") {
    logShellExecution({
      command,
      workingDir,
      tier: classification.tier,
      approved: false,
      deniedReason: "block_all mode",
      durationMs: 0,
      sessionId: context?.sessionId,
    });
    return {
      content: [{ type: "text", text: `Command blocked: shell approval mode is set to "block all non-safe commands".` }],
    };
  }

  const needsApproval =
    classification.tier !== "safe" &&
    approvalMode !== "always_approve" &&
    (approvalMode === "moderate_plus" ||
     (approvalMode === "dangerous_only" && classification.tier === "dangerous"));

  if (needsApproval) {
    const { approved } = await requestApproval(command, workingDir, classification, context);

    if (!approved) {
      logShellExecution({
        command,
        workingDir,
        tier: classification.tier,
        approved: false,
        deniedReason: "user denied or timeout",
        durationMs: 0,
        sessionId: context?.sessionId,
      });
      return {
        content: [{ type: "text", text: `Command denied by user: \`${command}\`` }],
      };
    }
  }

  // 4. Execute
  const result = await executeCommand(command, workingDir, timeoutMs);

  // 5. Audit
  logShellExecution({
    command,
    workingDir,
    tier: classification.tier,
    approved: true,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 10_000), // store truncated in audit
    stderr: result.stderr.slice(0, 10_000),
    durationMs: result.durationMs,
    sessionId: context?.sessionId,
  });

  // 6. Return
  return {
    content: [{ type: "text", text: formatShellOutput(result) }],
  };
}

handlers.set(SHELL_EXECUTE_NAME, handleShellExecute);

// ---------------------------------------------------------------------------
// Claude Code tool
// ---------------------------------------------------------------------------
const CLAUDE_CODE_NAME = "native__claude_code";
const CLAUDE_CODE_DEFAULT_TIMEOUT = 300_000; // 5 minutes
const CLAUDE_CODE_MAX_TIMEOUT = 600_000; // 10 minutes
const CLAUDE_CODE_URL_CAPTURE_TIMEOUT = 30_000; // 30s to capture auth URL

const claudeCodeToolDef = tool({
  description:
    "[Claude Code] Delegate complex coding tasks to the Claude Code CLI agent. " +
    "Use for multi-file edits, debugging, refactoring, test writing, and codebase exploration. " +
    "Set action to 'login' to initiate authentication when needed.",
  parameters: z.object({
    action: z
      .enum(["execute", "login"])
      .optional()
      .describe("Action to perform: 'execute' (default) runs a coding task, 'login' initiates Claude Code authentication and returns an auth URL"),
    prompt: z
      .string()
      .optional()
      .describe("The coding task to delegate to Claude Code (required for action='execute')"),
    workingDir: z
      .string()
      .optional()
      .describe("Project root directory for Claude Code to work in (defaults to user home)"),
    maxTurns: z
      .number()
      .optional()
      .describe("Max agentic turns (default: 10, max: 50)"),
  }),
});

// Background login process — kept alive so OAuth callback can reach it
let claudeLoginProcess: ReturnType<typeof spawn> | null = null;
let claudeLoginKillTimer: ReturnType<typeof setTimeout> | null = null;

function findClaudeBinary(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, ["claude"], { timeout: 5000, encoding: "utf-8" });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim().split(/\r?\n/)[0] || null;
    }
    return null;
  } catch {
    return null;
  }
}

function cleanupLoginProcess(): void {
  if (claudeLoginKillTimer) {
    clearTimeout(claudeLoginKillTimer);
    claudeLoginKillTimer = null;
  }
  if (claudeLoginProcess && !claudeLoginProcess.killed) {
    try { claudeLoginProcess.kill(); } catch { /* already dead */ }
  }
  claudeLoginProcess = null;
}

async function handleClaudeCodeLogin(): Promise<NativeToolResult> {
  // Clean up any previous login process
  cleanupLoginProcess();

  const binary = findClaudeBinary();
  if (!binary) {
    return {
      content: [{ type: "text", text: "Claude Code CLI not found. Ensure `claude` is installed and on PATH (npm install -g @anthropic-ai/claude-code)." }],
    };
  }

  return new Promise((resolve) => {
    let output = "";
    let resolved = false;

    const proc = spawn(binary, ["login"], {
      env: buildSafeEnv(),
      windowsHide: true,
    });

    claudeLoginProcess = proc;

    // Auto-kill after 5 minutes if OAuth never completes
    claudeLoginKillTimer = setTimeout(() => {
      cleanupLoginProcess();
    }, CLAUDE_CODE_DEFAULT_TIMEOUT);

    const onData = (data: Buffer) => {
      output += data.toString();
      // Look for a URL in the output
      const urlMatch = output.match(/https?:\/\/[^\s"'<>]+/);
      if (urlMatch && !resolved) {
        resolved = true;
        resolve({
          content: [{
            type: "text",
            text: `Claude Code login initiated. Open this URL to authenticate:\n\n${urlMatch[0]}\n\nUse the web agent to navigate to this URL and log in with the Anthropic account credentials. After login completes, retry your original task.`,
          }],
        });
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    // Timeout: if no URL found within 30s
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanupLoginProcess();
        resolve({
          content: [{
            type: "text",
            text: `Claude Code login started but no auth URL was captured within ${CLAUDE_CODE_URL_CAPTURE_TIMEOUT / 1000}s.\nOutput so far:\n${output.slice(0, 2000) || "(no output)"}`,
          }],
        });
      }
    }, CLAUDE_CODE_URL_CAPTURE_TIMEOUT);

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        cleanupLoginProcess();
        resolve({
          content: [{ type: "text", text: `Failed to start Claude Code login: ${err.message}` }],
        });
      }
    });

    // If process exits before URL captured (e.g., already logged in)
    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        cleanupLoginProcess();
        resolve({
          content: [{
            type: "text",
            text: code === 0
              ? `Claude Code login completed (already authenticated).\n${output.slice(0, 2000)}`
              : `Claude Code login exited with code ${code}.\n${output.slice(0, 2000) || "(no output)"}`,
          }],
        });
      }
    });
  });
}

async function handleClaudeCodeExecute(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  const prompt = args.prompt ? String(args.prompt) : "";
  if (!prompt) {
    return { content: [{ type: "text", text: "Error: 'prompt' is required when action is 'execute'." }] };
  }

  const workingDir = args.workingDir ? String(args.workingDir) : homedir();
  const maxTurns = Math.min(Math.max(Number(args.maxTurns) || 10, 1), 50);

  // Validate working directory
  try {
    const s = statSync(workingDir);
    if (!s.isDirectory()) {
      return { content: [{ type: "text", text: `Working directory is not a directory: ${workingDir}` }] };
    }
  } catch {
    return { content: [{ type: "text", text: `Working directory does not exist: ${workingDir}` }] };
  }

  const binary = findClaudeBinary();
  if (!binary) {
    return {
      content: [{ type: "text", text: "Claude Code CLI not found. Ensure `claude` is installed and on PATH (npm install -g @anthropic-ai/claude-code)." }],
    };
  }

  const cliArgs = [
    "-p",
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    prompt,
  ];

  const start = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(binary, cliArgs, {
      cwd: workingDir,
      env: buildSafeEnv(),
      windowsHide: true,
    });

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      if (!proc.killed) {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }, CLAUDE_CODE_MAX_TIMEOUT);

    let stdoutDone = false;
    let stderrDone = false;

    proc.stdout?.on("data", (data: Buffer) => {
      if (stdoutDone) return;
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT * 2) {
        stdout = stdout.slice(0, MAX_OUTPUT * 2) + "\n[...truncated]";
        stdoutDone = true;
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      if (stderrDone) return;
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT) + "\n[...truncated]";
        stderrDone = true;
      }
    });

    proc.on("error", (err) => {
      clearTimeout(killTimer);
      if (!proc.killed) {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }
      resolve({
        content: [{ type: "text", text: `Claude Code execution error: ${err.message}` }],
      });
    });

    proc.on("close", (code) => {
      clearTimeout(killTimer);
      const durationMs = Date.now() - start;

      if (timedOut) {
        const parts: string[] = [`Claude Code timed out after ${CLAUDE_CODE_MAX_TIMEOUT / 1000}s.`];
        if (stdout) parts.push(stdout.slice(0, MAX_OUTPUT));
        if (stderr) parts.push(`[stderr]\n${stderr.slice(0, 5000)}`);
        resolve({ content: [{ type: "text", text: parts.join("\n") }] });
        return;
      }

      // Detect auth errors
      const combined = (stdout + stderr).toLowerCase();
      if (code !== 0 && (combined.includes("not authenticated") || combined.includes("unauthorized") || combined.includes("login required") || combined.includes("please login"))) {
        resolve({
          content: [{
            type: "text",
            text: `Claude Code authentication required. Use native__claude_code with action: "login" to authenticate, then retry.\n\n[stderr] ${stderr.slice(0, 1000)}`,
          }],
        });
        return;
      }

      // Try to parse JSON output
      try {
        const parsed = JSON.parse(stdout);
        const result = parsed.result || parsed.message || stdout;
        const meta: string[] = [];
        if (parsed.cost_usd !== undefined) meta.push(`cost: $${parsed.cost_usd.toFixed(4)}`);
        if (parsed.num_turns !== undefined) meta.push(`turns: ${parsed.num_turns}`);
        meta.push(`duration: ${(durationMs / 1000).toFixed(1)}s`);
        if (code !== 0) meta.push(`exit code: ${code}`);

        resolve({
          content: [{
            type: "text",
            text: `${result}\n\n[${meta.join(", ")}]`,
          }],
        });
      } catch {
        // Fallback to raw output
        const parts: string[] = [];
        if (stdout) parts.push(stdout.slice(0, MAX_OUTPUT));
        if (stderr) parts.push(`[stderr]\n${stderr.slice(0, 5000)}`);
        if (parts.length === 0) parts.push("(no output)");
        parts.push(`\n[exit code: ${code ?? 1}, ${(durationMs / 1000).toFixed(1)}s]`);

        resolve({
          content: [{ type: "text", text: parts.join("\n") }],
        });
      }
    });
  });
}

async function handleClaudeCode(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  const action = String(args.action || "execute");

  if (action === "login") {
    return handleClaudeCodeLogin();
  }

  return handleClaudeCodeExecute(args);
}

handlers.set(CLAUDE_CODE_NAME, handleClaudeCode);
nativeToolMapping.set(CLAUDE_CODE_NAME, { kind: "tool", id: "claude-code" });

// ---------------------------------------------------------------------------
// Self-Healing: Diagnose tool
// ---------------------------------------------------------------------------
const DIAGNOSE_TOOL_NAME = "native__diagnose";

const ERROR_CATEGORIES: [string, ...string[]] = [
  "tool_failure", "mcp_crash", "llm_error", "network_error",
  "capability_error", "browser_error", "scheduler_error", "system_error",
];

const diagnoseToolDef = tool({
  description:
    "[Self-Diagnosis] Read your own error logs, check system health, and inspect running components. " +
    "Use this when something seems broken, when the user reports issues, or to proactively check health.",
  parameters: z.object({
    scope: z.enum(["errors", "health", "full"])
      .optional()
      .describe("What to diagnose: 'errors' = recent error log, 'health' = component status, 'full' = both. Default: full."),
    errorLimit: z.number()
      .optional()
      .describe("Number of recent errors to return (default: 20, max: 100)"),
    errorCategory: z.enum(ERROR_CATEGORIES as unknown as [string, ...string[]])
      .optional()
      .describe("Filter errors by category"),
  }),
});

async function handleDiagnose(args: Record<string, unknown>): Promise<NativeToolResult> {
  const scope = String(args.scope ?? "full");
  const errorLimit = Math.min(Number(args.errorLimit ?? 20), 100);
  const errorCategory = args.errorCategory ? String(args.errorCategory) as ErrorCategory : undefined;

  const { getRecentErrors, getErrorStats, getServerUptime } = await import("./error-logger.ts");
  const sections: string[] = ["=== Chvor System Diagnosis ===", ""];

  if (scope === "health" || scope === "full") {
    const { loadSkills, loadTools } = await import("./capability-loader.ts");
    const { mcpManager } = await import("./mcp-manager.ts");
    const { getActiveBrowserCount } = await import("./browser-manager.ts");
    const { listCredentials } = await import("../db/credential-store.ts");
    const { listMemories } = await import("../db/memory-store.ts");
    const { listSchedules } = await import("../db/schedule-store.ts");

    const skills = loadSkills();
    const tools = loadTools();
    const mcpStatus = await mcpManager.getConnectionStatus();
    const browserCount = getActiveBrowserCount();
    const creds = listCredentials();
    const memories = listMemories();
    const schedules = listSchedules();
    const activeSchedules = schedules.filter((s) => s.enabled);

    sections.push("## Health Status");
    sections.push(`- Uptime: ${formatUptime(getServerUptime())}`);
    sections.push(`- Skills loaded: ${skills.length} (${skills.filter((s) => s.source === "bundled").length} bundled, ${skills.filter((s) => s.source === "user").length} user)`);
    sections.push(`- Tools loaded: ${tools.length} (${tools.filter((t) => t.builtIn).length} bundled, ${tools.filter((t) => !t.builtIn).length} user)`);
    sections.push(`- MCP servers running: ${mcpStatus.length}${mcpStatus.length > 0 ? ` (${mcpStatus.map((s) => s.toolId).join(", ")})` : ""}`);
    sections.push(`- Browser sessions: ${browserCount} active`);
    sections.push(`- Credentials: ${creds.length} saved`);
    sections.push(`- Memories: ${memories.length}`);
    sections.push(`- Active schedules: ${activeSchedules.length}/${schedules.length}`);
    sections.push("");

    // Read MANIFEST.md for trends if it exists
    const manifestPath = join(homedir(), ".chvor", "MANIFEST.md");
    if (existsSync(manifestPath)) {
      try {
        const manifest = readFileSync(manifestPath, "utf8");
        const trendMatch = manifest.match(/## Error Summary[\s\S]*?(?=##|$)/);
        if (trendMatch) {
          sections.push("## Trend (from MANIFEST.md)");
          sections.push(trendMatch[0].trim());
          sections.push("");
        }
      } catch { /* skip */ }
    }
  }

  if (scope === "errors" || scope === "full") {
    const errors = getRecentErrors({ limit: errorLimit, category: errorCategory });
    const stats = getErrorStats();

    sections.push("## Recent Errors");
    if (errors.length === 0) {
      sections.push("No errors logged.");
    } else {
      for (const e of errors) {
        const resolved = e.resolved ? " [RESOLVED]" : "";
        const ctx = e.context ? ` (${Object.entries(e.context).map(([k, v]) => `${k}=${v}`).join(", ")})` : "";
        sections.push(`[${e.timestamp}] ${e.category}: ${e.message}${ctx}${resolved}`);
      }
    }
    sections.push("");
    sections.push(`## Error Stats (last 24h)`);
    sections.push(`Total: ${stats.last24h}${Object.keys(stats.byCategory).length > 0 ? ` | ${Object.entries(stats.byCategory).map(([k, v]) => `${k}: ${v}`).join(", ")}` : ""}`);
  }

  return { content: [{ type: "text", text: sections.join("\n") }] };
}

handlers.set(DIAGNOSE_TOOL_NAME, handleDiagnose);

// ---------------------------------------------------------------------------
// Self-Healing: Repair tool
// ---------------------------------------------------------------------------
const REPAIR_TOOL_NAME = "native__repair";

// Rate limiter for MCP restarts
const mcpRestartTimes = new Map<string, number[]>();
const MCP_RESTART_LIMIT = 3;
const MCP_RESTART_WINDOW = 5 * 60 * 1000; // 5 minutes

const repairToolDef = tool({
  description:
    "[Self-Repair] Take corrective action to fix issues. Can: restart failed MCP servers, " +
    "reload skills/tools from disk, update skill file content, clear stale browser sessions. " +
    "Use after native__diagnose identifies a problem.",
  parameters: z.object({
    action: z.enum([
      "restart_mcp",
      "reload_capabilities",
      "update_skill",
      "clear_browsers",
      "clear_error_log",
    ]).describe("The repair action to perform"),
    toolId: z.string().optional()
      .describe("MCP tool ID to restart (required for restart_mcp)"),
    skillId: z.string().optional()
      .describe("Skill ID to update (required for update_skill)"),
    skillContent: z.string().optional()
      .describe("New SKILL.md content (required for update_skill)"),
    errorIds: z.array(z.string()).optional()
      .describe("Error IDs to mark as resolved (for clear_error_log)"),
  }),
});

async function handleRepair(args: Record<string, unknown>): Promise<NativeToolResult> {
  const action = String(args.action);
  let resultText = "";

  switch (action) {
    case "restart_mcp": {
      const toolId = args.toolId ? String(args.toolId) : null;
      if (!toolId) return { content: [{ type: "text", text: "Error: toolId is required for restart_mcp" }] };

      // Rate limit (prune stale timestamps on every check)
      const now = Date.now();
      const times = mcpRestartTimes.get(toolId) ?? [];
      const recent = times.filter((t) => now - t < MCP_RESTART_WINDOW);
      mcpRestartTimes.set(toolId, recent);
      if (recent.length >= MCP_RESTART_LIMIT) {
        return { content: [{ type: "text", text: `Rate limited: ${toolId} has been restarted ${MCP_RESTART_LIMIT} times in the last 5 minutes. Manual intervention may be needed.` }] };
      }

      const { mcpManager } = await import("./mcp-manager.ts");
      const closed = await mcpManager.closeConnection(toolId);
      recent.push(now);

      resultText = closed
        ? `Closed MCP connection for "${toolId}". It will re-spawn automatically on next use.`
        : `No active MCP connection found for "${toolId}" — it may not have been spawned yet.`;
      break;
    }

    case "reload_capabilities": {
      const { reloadAll } = await import("./capability-loader.ts");
      const { invalidateToolCache } = await import("./tool-builder.ts");
      invalidateToolCache();
      const { skills, tools } = reloadAll();
      resultText = `Reloaded capabilities: ${skills.length} skills, ${tools.length} tools. Tool cache invalidated.`;
      break;
    }

    case "update_skill": {
      const skillId = args.skillId ? String(args.skillId).toLowerCase().replace(/[^a-z0-9-]/g, "-") : null;
      const skillContent = args.skillContent ? String(args.skillContent) : null;
      if (!skillId || !skillContent) {
        return { content: [{ type: "text", text: "Error: skillId and skillContent are required for update_skill" }] };
      }

      // Security: user skills directory only
      const userSkillsDir = join(homedir(), ".chvor", "skills");
      const filePath = join(userSkillsDir, `${skillId}.md`);

      // Ensure the resolved path is inside the user skills dir (not bundled)
      const resolvedDir = resolve(userSkillsDir) + sep;
      const resolvedFile = resolve(filePath);
      if (!resolvedFile.startsWith(resolvedDir)) {
        return { content: [{ type: "text", text: "Error: path traversal detected. Only user skills can be updated." }] };
      }

      // Validate content has YAML frontmatter
      if (!skillContent.trimStart().startsWith("---")) {
        return { content: [{ type: "text", text: "Error: skill content must start with YAML frontmatter (---)" }] };
      }

      // Read existing content for rollback
      let backup: string | null = null;
      if (existsSync(filePath)) {
        backup = readFileSync(filePath, "utf8");
      }

      // Write new content
      mkdirSync(userSkillsDir, { recursive: true });
      writeFileSync(filePath, skillContent, "utf8");

      // Validate by parsing
      try {
        const { parseCapabilityMd } = await import("./capability-parser.ts");
        const parsed = parseCapabilityMd(skillContent, filePath, "user");
        if (!parsed) throw new Error("Parse returned null");
      } catch (parseErr) {
        // Rollback: restore previous content or remove newly created file
        if (backup !== null) {
          writeFileSync(filePath, backup, "utf8");
        } else {
          try { unlinkSync(filePath); } catch { /* ignore */ }
        }
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        return { content: [{ type: "text", text: `Error: skill content is invalid (${msg}). Rolled back to previous version.` }] };
      }

      // Reload capabilities
      const { reloadAll } = await import("./capability-loader.ts");
      const { invalidateToolCache } = await import("./tool-builder.ts");
      invalidateToolCache();
      reloadAll();

      resultText = `Updated skill "${skillId}" at ${filePath}. Capabilities reloaded.`;
      break;
    }

    case "clear_browsers": {
      const { shutdownAllBrowsers } = await import("./browser-manager.ts");
      await shutdownAllBrowsers();
      resultText = "All browser sessions closed.";
      break;
    }

    case "clear_error_log": {
      const errorIds = Array.isArray(args.errorIds) ? args.errorIds.map(String) : [];
      if (errorIds.length === 0) {
        return { content: [{ type: "text", text: "Error: errorIds array is required for clear_error_log" }] };
      }
      const { markResolved } = await import("./error-logger.ts");
      let resolved = 0;
      for (const id of errorIds) {
        if (markResolved(id)) resolved++;
      }
      resultText = `Marked ${resolved}/${errorIds.length} error(s) as resolved.`;
      break;
    }

    default:
      return { content: [{ type: "text", text: `Unknown repair action: ${action}` }] };
  }

  setConfig("selfHealing.lastRepairAt", new Date().toISOString());

  try {
    const { getWSInstance } = await import("../gateway/ws-instance.ts");
    const ws = getWSInstance();
    const activityEntry = insertActivity({
      source: "self-healing",
      title: `Repair: ${action}`,
      content: resultText,
    });
    if (ws) {
      ws.broadcast({ type: "activity.new", data: activityEntry });
    }
  } catch { /* non-critical */ }

  return { content: [{ type: "text", text: resultText }] };
}

handlers.set(REPAIR_TOOL_NAME, handleRepair);

// ---------------------------------------------------------------------------
// Image Generation tool
// ---------------------------------------------------------------------------
const GENERATE_IMAGE_NAME = "native__generate_image";

const generateImageToolDef = tool({
  description:
    "[Image Generation] Generate images from text prompts using AI models (OpenAI GPT Image / DALL-E, Flux via Replicate/Fal). Returns the generated image(s).",
  parameters: z.object({
    prompt: z.string().describe("Detailed description of the image to generate"),
    model: z
      .string()
      .optional()
      .describe(
        "Model override: gpt-image-1, dall-e-3, dall-e-2, or a Flux model ID. Uses configured default if omitted",
      ),
    size: z
      .string()
      .optional()
      .describe("Image dimensions as WxH (e.g. 1024x1024, 1024x1792, 1792x1024). Default: 1024x1024"),
    quality: z
      .enum(["auto", "low", "medium", "high"])
      .optional()
      .describe("Image quality (default: auto)"),
    style: z
      .enum(["vivid", "natural"])
      .optional()
      .describe("Image style (DALL-E 3 only). vivid = hyper-real/dramatic, natural = organic/less hyper-real"),
    n: z
      .number()
      .min(1)
      .max(4)
      .optional()
      .describe("Number of images to generate (default: 1, DALL-E 3 limited to 1)"),
    output_format: z
      .enum(["png", "webp"])
      .optional()
      .describe("Output format (OpenAI gpt-image-1 only). Default: png"),
    background: z
      .enum(["auto", "transparent"])
      .optional()
      .describe("Background handling (OpenAI gpt-image-1 only). transparent requires png or webp output"),
  }),
});

/** Look up a model ID across all image-gen providers. */
function resolveImageModel(
  modelOverride: string,
): { providerId: string; modelId: string } | null {
  for (const provider of IMAGE_GEN_PROVIDERS) {
    const match = provider.models.find((m) => m.id === modelOverride);
    if (match) return { providerId: provider.id, modelId: match.id };
  }
  return null;
}

async function handleGenerateImage(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  const prompt = String(args.prompt);
  const size = args.size ? String(args.size) : "1024x1024";
  const quality = args.quality ? String(args.quality) : undefined;
  const n = typeof args.n === "number" ? args.n : 1;
  const style = args.style ? String(args.style) : undefined;
  const outputFormat = args.output_format ? String(args.output_format) : undefined;
  const background = args.background ? String(args.background) : undefined;

  // Resolve the image-generation model config
  let providerId: string;
  let modelId: string;
  let apiKey: string;

  try {
    const { resolveMediaConfig, resolveCredential } = await import("./llm-router.ts");

    // Per-call model override: look up the model in the registry
    if (args.model) {
      const override = resolveImageModel(String(args.model));
      if (!override) {
        const allModels = IMAGE_GEN_PROVIDERS.flatMap((p) =>
          p.models.map((m) => m.id),
        );
        return {
          content: [
            {
              type: "text",
              text: `Unknown image model: "${args.model}". Available models: ${allModels.join(", ")}`,
            },
          ],
        };
      }
      providerId = override.providerId;
      modelId = override.modelId;
      const cred = resolveCredential(override.providerId);
      apiKey = cred.apiKey;
    } else {
      const config = resolveMediaConfig("image-generation");
      providerId = config.providerId;
      modelId = config.model;
      apiKey = config.apiKey;
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Image generation not available: ${err instanceof Error ? err.message : String(err)}. Configure an image generation model in Settings > Media.`,
        },
      ],
    };
  }

  try {
    const ai = await import("ai");
    const genImage = ai.experimental_generateImage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let imageModel: any;

    switch (providerId) {
      case "openai": {
        const { createOpenAI } = await import("@ai-sdk/openai");
        const provider = createOpenAI({ apiKey });
        imageModel = provider.image(modelId);
        break;
      }
      case "replicate": {
        // Dynamic import — optional dependency
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mod = await (Function('return import("@ai-sdk/replicate")')() as Promise<any>);
          const provider = mod.createReplicate({ apiToken: apiKey });
          imageModel = provider.image(modelId);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "Replicate provider not installed. Run: pnpm add @ai-sdk/replicate",
              },
            ],
          };
        }
        break;
      }
      case "fal": {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mod = await (Function('return import("@ai-sdk/fal")')() as Promise<any>);
          const provider = mod.createFal({ apiKey });
          imageModel = provider.image(modelId);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "Fal.ai provider not installed. Run: pnpm add @ai-sdk/fal",
              },
            ],
          };
        }
        break;
      }
      default:
        return {
          content: [
            {
              type: "text",
              text: `Unsupported image generation provider: ${providerId}. Supported: openai, replicate, fal`,
            },
          ],
        };
    }

    // Build provider-specific options (quality, style, output_format, background)
    const providerOptions: Record<string, Record<string, string>> = {};
    if (providerId === "openai") {
      const openaiOpts: Record<string, string> = {};
      if (quality) openaiOpts.quality = quality;
      if (style) openaiOpts.style = style;
      if (outputFormat) openaiOpts.output_format = outputFormat;
      if (background) openaiOpts.background = background;
      if (Object.keys(openaiOpts).length > 0) {
        providerOptions.openai = openaiOpts;
      }
    }

    const result = await genImage({
      model: imageModel,
      prompt,
      n,
      size: size as `${number}x${number}`,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    });

    // Convert generated images to NativeToolResult with image content items
    const content: NativeToolContentItem[] = [];
    const images = result.images ?? (result.image ? [result.image] : []);

    for (const img of images) {
      if (img?.base64) {
        content.push({
          type: "image",
          data: img.base64,
          mimeType: img.mimeType ?? "image/png",
        });
      }
    }

    if (content.length === 0) {
      content.push({
        type: "text",
        text: "Image generation completed but no images were returned.",
      });
    } else {
      content.push({
        type: "text",
        text: `Generated ${content.length} image(s) for: "${prompt}"`,
      });
    }

    return { content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Image generation failed: ${msg}` }],
    };
  }
}

handlers.set(GENERATE_IMAGE_NAME, handleGenerateImage);

// ---------------------------------------------------------------------------
// Memory: recall_detail
// ---------------------------------------------------------------------------

const RECALL_DETAIL_NAME = "native__recall_detail";

const recallDetailToolDef = tool({
  description:
    "[Recall Memory Detail] Retrieve the full detail (L1 overview + L2 narrative) of a memory. " +
    "Pass either the [mid:...] tag from your context or the abstract text.",
  parameters: z.object({
    memoryId: z
      .string()
      .optional()
      .describe("The memory ID prefix from a [mid:...] tag (e.g. 'abc12345'). Preferred over abstract search."),
    memoryAbstract: z
      .string()
      .optional()
      .describe("The abstract text of the memory. Used as fallback when memoryId is not available."),
  }),
});

async function handleRecallDetail(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  const { getRelevantMemoriesWithScores, findMemoryByIdPrefix } = await import("../db/memory-store.ts");
  const memoryIdPrefix = String(args.memoryId ?? "").trim();
  const abstract = String(args.memoryAbstract ?? "").trim();

  if (!memoryIdPrefix && !abstract) {
    return { content: [{ type: "text", text: "Please provide a memoryId (from [mid:...] tag) or memoryAbstract." }] };
  }

  let best: import("@chvor/shared").Memory | undefined;

  // Prefer ID-based lookup (indexed LIKE query, not full table scan)
  if (memoryIdPrefix) {
    best = findMemoryByIdPrefix(memoryIdPrefix) ?? undefined;
  }

  // Fallback to vector search if ID lookup fails
  if (!best && abstract) {
    const results = await getRelevantMemoriesWithScores(abstract, 3);
    if (results.length > 0) {
      best = results[0].memory;
    }
  }

  if (!best) {
    return { content: [{ type: "text", text: "No matching memory found." }] };
  }
  const parts: string[] = [`**${best.abstract}**`];
  parts.push(`Category: ${best.category} | Confidence: ${Math.round(best.confidence * 100)}% | Strength: ${Math.round(best.strength * 100)}%`);

  if (best.overview) {
    parts.push(`\n**Overview:**\n${best.overview}`);
  }
  if (best.detail) {
    parts.push(`\n**Detail:**\n${best.detail}`);
  }
  if (!best.overview && !best.detail) {
    parts.push("\n(No additional detail available for this memory.)");
  }

  return {
    content: [{ type: "text", text: parts.join("\n") }],
  };
}

handlers.set(RECALL_DETAIL_NAME, handleRecallDetail);

// ---------------------------------------------------------------------------
// Knowledge: ingest_url + ingest_document
// ---------------------------------------------------------------------------

const INGEST_URL_NAME = "native__ingest_url";
const INGEST_DOCUMENT_NAME = "native__ingest_document";

const ingestUrlToolDef = tool({
  description:
    "[Knowledge] Ingest a web page URL — fetches the page, extracts text, and stores facts into memory. " +
    "Use when a user shares a URL they want you to remember or learn from.",
  parameters: z.object({
    url: z.string().describe("The URL to ingest"),
    title: z.string().optional().describe("Optional title for the resource"),
  }),
});

const ingestDocumentToolDef = tool({
  description:
    "[Knowledge] Ingest an uploaded document (PDF, DOCX, TXT, image) from its media ID — extracts text and stores facts into memory.",
  parameters: z.object({
    mediaId: z.string().describe("The media artifact ID (from a previous upload)"),
    title: z.string().optional().describe("Optional title for the resource"),
  }),
});

async function handleIngestUrl(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  const { createResource } = await import("../db/knowledge-store.ts");
  const { ingestResource } = await import("./knowledge-ingestor.ts");

  const url = String(args.url ?? "").trim();
  if (!url) {
    return { content: [{ type: "text", text: "Please provide a URL to ingest." }] };
  }

  try {
    new URL(url);
  } catch {
    return { content: [{ type: "text", text: `Invalid URL: ${url}` }] };
  }

  try {
    await validateFetchUrl(url);
  } catch (err) {
    return { content: [{ type: "text", text: `Blocked: ${(err as Error).message}` }] };
  }

  const title = String(args.title || new URL(url).hostname);
  const resource = createResource({ type: "url", title, sourceUrl: url });

  // Await ingestion so we can report results
  try {
    await ingestResource(resource.id);
    const { getResource } = await import("../db/knowledge-store.ts");
    const updated = getResource(resource.id);
    const count = updated?.memoryCount ?? 0;
    return {
      content: [{ type: "text", text: `Ingested "${title}" — extracted ${count} fact${count !== 1 ? "s" : ""} into memory.` }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Ingestion failed: ${(err as Error).message}` }],
    };
  }
}

async function handleIngestDocument(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  const { createResource } = await import("../db/knowledge-store.ts");
  const { ingestResource } = await import("./knowledge-ingestor.ts");
  const { getMediaDir } = await import("./media-store.ts");

  const mediaId = String(args.mediaId ?? "").trim();
  if (!mediaId) {
    return { content: [{ type: "text", text: "Please provide a mediaId." }] };
  }

  // Validate mediaId is a UUID to prevent path traversal
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mediaId)) {
    return { content: [{ type: "text", text: "Invalid mediaId format." }] };
  }

  // Detect file type by checking known extensions directly (avoid readdirSync scan)
  const { existsSync } = await import("node:fs");
  const mediaDir = getMediaDir();

  const extCandidates = ["pdf", "docx", "txt", "md", "png", "jpg", "jpeg", "webp"];
  let ext = "";
  for (const candidate of extCandidates) {
    if (existsSync(join(mediaDir, `${mediaId}.${candidate}`))) {
      ext = candidate;
      break;
    }
  }
  if (!ext) {
    return { content: [{ type: "text", text: `No media file found with ID: ${mediaId}` }] };
  }

  const filename = `${mediaId}.${ext}`;
  const typeMap: Record<string, { type: string; mime: string }> = {
    pdf: { type: "pdf", mime: "application/pdf" },
    docx: { type: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    txt: { type: "txt", mime: "text/plain" },
    md: { type: "markdown", mime: "text/markdown" },
    png: { type: "image", mime: "image/png" },
    jpg: { type: "image", mime: "image/jpeg" },
    jpeg: { type: "image", mime: "image/jpeg" },
    webp: { type: "image", mime: "image/webp" },
  };

  const info = typeMap[ext];
  if (!info) {
    return { content: [{ type: "text", text: `Unsupported file type: .${ext}` }] };
  }

  const title = String(args.title || filename);
  const resource = createResource({
    type: info.type as import("@chvor/shared").KnowledgeResourceType,
    title,
    mediaId,
    mimeType: info.mime,
  });

  try {
    await ingestResource(resource.id);
    const { getResource } = await import("../db/knowledge-store.ts");
    const updated = getResource(resource.id);
    const count = updated?.memoryCount ?? 0;
    return {
      content: [{ type: "text", text: `Ingested "${title}" — extracted ${count} fact${count !== 1 ? "s" : ""} into memory.` }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Ingestion failed: ${(err as Error).message}` }],
    };
  }
}

handlers.set(INGEST_URL_NAME, handleIngestUrl);
handlers.set(INGEST_DOCUMENT_NAME, handleIngestDocument);

// ---------------------------------------------------------------------------
// Registry: Search, Install, Uninstall
// ---------------------------------------------------------------------------

const REGISTRY_SEARCH_NAME = "native__registry_search";
const registrySearchToolDef = tool({
  description:
    "[Registry] Search the skill & tool registry. Use when the user asks to find, browse, or list available skills, tools, or templates from the registry.",
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe("Search query to match against name, description, id, or tags"),
    kind: z
      .enum(["skill", "tool", "template"])
      .optional()
      .describe("Filter by entry kind"),
    category: z.string().optional().describe("Filter by category"),
  }),
});

async function handleRegistrySearch(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  try {
    const query = (args.query as string | undefined)?.toLowerCase() ?? "";
    const kind = args.kind as RegistryEntryKind | undefined;
    const category = args.category as string | undefined;

    let index: Awaited<ReturnType<typeof fetchRegistryIndex>>;
    try {
      index = await fetchRegistryIndex();
    } catch {
      const cached = readCachedIndex();
      if (!cached) throw new Error("Registry unavailable and no cached index exists");
      index = cached;
    }

    let results = index.entries;

    if (kind) {
      results = results.filter((e) => e.kind === kind);
    }

    if (query) {
      results = results.filter(
        (e) =>
          e.name.toLowerCase().includes(query) ||
          e.description.toLowerCase().includes(query) ||
          e.id.toLowerCase().includes(query) ||
          e.tags?.some((t) => t.toLowerCase().includes(query)),
      );
    }

    if (category) {
      results = results.filter((e) => e.category === category);
    }

    const lock = readLock();
    const lines = results.map((e, i) => {
      const installed = lock.installed[e.id];
      const status = installed ? " [installed]" : "";
      return `${i + 1}. **${e.name}** (${e.kind}) v${e.version} — ${e.description}${status}\n   id: \`${e.id}\``;
    });

    const summary =
      results.length === 0
        ? `No registry entries found${query ? ` matching "${query}"` : ""}.`
        : `Found ${results.length} registry ${results.length === 1 ? "entry" : "entries"}${query ? ` matching "${query}"` : ""}:\n\n${lines.join("\n")}`;

    return { content: [{ type: "text", text: summary }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Registry search failed: ${msg}` }],
    };
  }
}

handlers.set(REGISTRY_SEARCH_NAME, handleRegistrySearch);
nativeToolMapping.set(REGISTRY_SEARCH_NAME, { kind: "tool", id: "registry" });

const REGISTRY_INSTALL_NAME = "native__registry_install";
const registryInstallToolDef = tool({
  description:
    "[Registry] Install a skill or tool from the registry by its ID. Use when the user asks to install, add, or enable a registry entry. Search first if you only have a name, not an ID.",
  parameters: z.object({
    id: z.string().describe("The registry entry ID to install (e.g. 'web-scraper')"),
    kind: z
      .enum(["skill", "tool", "template"])
      .optional()
      .describe("Entry kind — auto-detected if omitted"),
  }),
});

async function handleRegistryInstall(
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> {
  try {
    if (!args.id || typeof args.id !== "string") {
      return { content: [{ type: "text", text: "Registry install failed: 'id' is required." }] };
    }
    const id = args.id;
    const kind = args.kind as RegistryEntryKind | undefined;

    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.invoked",
        data: { nodeId: `tool-registry`, toolId: "registry" },
      });
    }

    const result = await installEntry(id, kind);
    const depInfo =
      result.dependencies.length > 0
        ? `\nDependencies installed: ${result.dependencies.join(", ")}`
        : "";
    const failedInfo =
      result.failedDependencies.length > 0
        ? `\nFailed dependencies: ${result.failedDependencies.join(", ")}`
        : "";

    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.completed",
        data: { nodeId: `tool-registry`, output: `Installed ${id}` },
      });
    }

    const { getWSInstance } = await import("../gateway/ws-instance.ts");
    getWSInstance()?.broadcast({ type: "skills.reloaded", data: {} });

    return {
      content: [
        {
          type: "text",
          text: `Successfully installed **${result.installed.metadata.name}** (${result.installed.kind}) v${result.installed.metadata.version}.${depInfo}${failedInfo}`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.failed",
        data: { nodeId: `tool-registry`, error: msg },
      });
    }
    return {
      content: [{ type: "text", text: `Registry install failed: ${msg}` }],
    };
  }
}

handlers.set(REGISTRY_INSTALL_NAME, handleRegistryInstall);
nativeToolMapping.set(REGISTRY_INSTALL_NAME, { kind: "tool", id: "registry" });

const REGISTRY_UNINSTALL_NAME = "native__registry_uninstall";
const registryUninstallToolDef = tool({
  description:
    "[Registry] Uninstall a skill or tool by its ID. Use when the user asks to remove, uninstall, or disable a registry entry.",
  parameters: z.object({
    id: z.string().describe("The registry entry ID to uninstall"),
  }),
});

async function handleRegistryUninstall(
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> {
  try {
    if (!args.id || typeof args.id !== "string") {
      return { content: [{ type: "text", text: "Registry uninstall failed: 'id' is required." }] };
    }
    const id = args.id;

    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.invoked",
        data: { nodeId: `tool-registry`, toolId: "registry" },
      });
    }

    await uninstallEntry(id);

    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.completed",
        data: { nodeId: `tool-registry`, output: `Uninstalled ${id}` },
      });
    }

    const { getWSInstance } = await import("../gateway/ws-instance.ts");
    getWSInstance()?.broadcast({ type: "skills.reloaded", data: {} });

    return {
      content: [
        { type: "text", text: `Successfully uninstalled **${id}** from the registry.` },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.failed",
        data: { nodeId: `tool-registry`, error: msg },
      });
    }
    return {
      content: [{ type: "text", text: `Registry uninstall failed: ${msg}` }],
    };
  }
}

handlers.set(REGISTRY_UNINSTALL_NAME, handleRegistryUninstall);
nativeToolMapping.set(REGISTRY_UNINSTALL_NAME, { kind: "tool", id: "registry" });

// ---------------------------------------------------------------------------
// A2UI — Agent-to-User Interface protocol
// ---------------------------------------------------------------------------

const A2UI_PUSH_NAME = "native__canvas_a2ui_push";

const a2uiPushToolDef = tool({
  description:
    "[A2UI Push] Build a visual UI on the Brain Canvas. Use this when the user asks to build a dashboard, chart, table, form, or any visual interface. Send surfaceUpdate to define components, beginRendering to display them, and dataModelUpdate to update bound data. Components: Text, Column, Row, Image, Table, Button, Form, Input, Chart. Always send all three message types in a single call.",
  parameters: z.object({
    messages: z
      .array(
        z.union([
          z.object({
            surfaceUpdate: z.object({
              surfaceId: z.string().describe("Unique surface identifier"),
              title: z.string().optional().describe("Human-readable title for the surface"),
              components: z.array(
                z.object({
                  id: z.string().describe("Unique component id"),
                  component: z.record(z.unknown()).describe("Component definition object (e.g. {Text:{text:{literalString:'Hello'},usageHint:'h1'}})"),
                })
              ),
            }),
          }),
          z.object({
            beginRendering: z.object({
              surfaceId: z.string(),
              root: z.string().describe("Component id to use as the root of the render tree"),
            }),
          }),
          z.object({
            dataModelUpdate: z.object({
              surfaceId: z.string(),
              bindings: z.record(z.unknown()).describe("Key-value data bindings to update"),
            }),
          }),
        ])
      )
      .describe("Array of A2UI protocol messages to process"),
  }),
});

async function handleA2UIPush(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const { getWSInstance } = await import("../gateway/ws-instance.ts");
  const ws = getWSInstance();
  const sessionId = context?.sessionId;

  if (!ws) {
    return { content: [{ type: "text", text: "A2UI: no active WebSocket connection. Surface not delivered." }] };
  }

  const messages = args.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { content: [{ type: "text", text: "No A2UI messages provided." }] };
  }

  const send = (event: GatewayServerEvent) => {
    if (sessionId) ws.broadcastToSession(sessionId, event);
    else ws.broadcast(event);
  };

  // ── Phase 1: Collect all data per surface before emitting events ──
  const surfaceData = new Map<string, {
    components: A2UIComponentEntry[];
    componentMap: Record<string, A2UIComponentEntry>;
    root: string | null;
    bindings: Record<string, unknown> | null;
    title: string | null;
  }>();

  const surfaceIds = new Set<string>();

  const getOrCreate = (sid: string) => {
    let entry = surfaceData.get(sid);
    if (!entry) {
      entry = { components: [], componentMap: {}, root: null, bindings: null, title: null };
      surfaceData.set(sid, entry);
    }
    return entry;
  };

  for (const msg of messages) {
    if (typeof msg !== "object" || msg == null) continue;
    const m = msg as Record<string, unknown>;

    if ("surfaceUpdate" in m && typeof m.surfaceUpdate === "object" && m.surfaceUpdate != null) {
      const su = m.surfaceUpdate as { surfaceId: string; title?: string; components: Array<{ id: string; component: Record<string, unknown> }> };
      if (typeof su.surfaceId !== "string") continue;

      surfaceIds.add(su.surfaceId);

      const entry = getOrCreate(su.surfaceId);
      if (typeof su.title === "string" && su.title.trim()) {
        entry.title = su.title.trim();
      }
      if (Array.isArray(su.components)) {
        for (const c of su.components) {
          entry.componentMap[c.id] = c as unknown as A2UIComponentEntry;
          entry.components.push(c as unknown as A2UIComponentEntry);
        }
      }
    } else if ("beginRendering" in m && typeof m.beginRendering === "object" && m.beginRendering != null) {
      const br = m.beginRendering as { surfaceId: string; root: string };
      if (typeof br.surfaceId !== "string" || typeof br.root !== "string") continue;
      surfaceIds.add(br.surfaceId);
      getOrCreate(br.surfaceId).root = br.root;
    } else if ("dataModelUpdate" in m && typeof m.dataModelUpdate === "object" && m.dataModelUpdate != null) {
      const dm = m.dataModelUpdate as { surfaceId: string; bindings: Record<string, unknown> };
      if (typeof dm.surfaceId !== "string") continue;
      surfaceIds.add(dm.surfaceId);
      getOrCreate(dm.surfaceId).bindings = dm.bindings ?? {};
    }
  }

  // ── Phase 1.5: Validate & normalize component structures ──
  const KNOWN_TYPES = new Set(["Text", "Column", "Row", "Image", "Table", "Button", "Form", "Input", "Chart"]);

  for (const [sid, entry] of surfaceData) {
    for (const [cid, ce] of Object.entries(entry.componentMap)) {
      const comp = ce.component as unknown as Record<string, unknown> | undefined;
      if (!comp || typeof comp !== "object") {
        console.warn(`[a2ui] Surface "${sid}": component "${cid}" has no definition, removing`);
        delete entry.componentMap[cid];
        continue;
      }

      // Check if the component has a recognized type key
      const typeKey = Object.keys(comp).find((k) => KNOWN_TYPES.has(k));
      if (!typeKey) {
        console.warn(`[a2ui] Surface "${sid}": component "${cid}" has unrecognized keys [${Object.keys(comp).join(", ")}]. Raw:`, JSON.stringify(comp));
        // Attempt to infer: if it has "children", it's likely a Column/Row missing the wrapper
        const raw = comp as Record<string, unknown>;
        if (raw.children || raw.items) {
          const childList = raw.children ?? raw.items;
          const normalizedChildren = Array.isArray(childList)
            ? { explicitList: childList as string[] }
            : childList;
          // Capture gap before clearing — raw and comp are the same object reference
          const gap = raw.gap ?? 8;
          // Clear all existing keys and replace with a proper Column wrapper
          for (const k of Object.keys(comp)) delete comp[k];
          comp["Column"] = { children: normalizedChildren, gap };
          console.warn(`[a2ui] Surface "${sid}": auto-wrapped component "${cid}" as Column`);
        }
        // Children already normalized during wrapping; skip further normalization
        continue;
      }

      // Normalize children format: if children is a plain array instead of {explicitList: [...]}
      const inner = comp[typeKey] as Record<string, unknown> | undefined;
      if (inner && (typeKey === "Column" || typeKey === "Row" || typeKey === "Form")) {
        if (Array.isArray(inner.children)) {
          inner.children = { explicitList: inner.children as string[] };
          console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" children array → explicitList`);
        } else if (inner.children && typeof inner.children === "object" && !("explicitList" in (inner.children as Record<string, unknown>))) {
          // children object but missing explicitList — check for common alternatives
          const childObj = inner.children as Record<string, unknown>;
          if (Array.isArray(childObj.list)) {
            inner.children = { explicitList: childObj.list as string[] };
            console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" children.list → explicitList`);
          } else if (Array.isArray(childObj.items)) {
            inner.children = { explicitList: childObj.items as string[] };
            console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" children.items → explicitList`);
          }
        }
      }

      // Normalize text values: if text is a plain string instead of {literalString: "..."}
      if (typeKey === "Text" && inner) {
        if (typeof inner.text === "string") {
          inner.text = { literalString: inner.text as string };
          console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" text string → literalString`);
        }
      }

      // Normalize Chart data: if data is a plain array instead of a binding/literal
      if (typeKey === "Chart" && inner) {
        if (Array.isArray(inner.data)) {
          // Inline data array — store as binding and convert to bound value
          const bindingKey = `__chart_${cid}`;
          if (!entry.bindings) entry.bindings = {};
          entry.bindings[bindingKey] = inner.data;
          inner.data = { binding: bindingKey };
          console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" inline chart data → binding "${bindingKey}"`);
        }
      }

      // Normalize Table rows: if rows is an array instead of a binding
      if (typeKey === "Table" && inner) {
        if (Array.isArray(inner.rows)) {
          const bindingKey = `__table_${cid}`;
          if (!entry.bindings) entry.bindings = {};
          entry.bindings[bindingKey] = inner.rows;
          inner.rows = { binding: bindingKey };
          console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" inline table rows → binding "${bindingKey}"`);
        }
      }

      // Normalize Button/Image label/src: plain string → literalString
      if (typeKey === "Button" && inner && typeof inner.label === "string") {
        inner.label = { literalString: inner.label as string };
      }
      if (typeKey === "Image" && inner && typeof inner.src === "string") {
        inner.src = { literalString: inner.src as string };
      }
    }

    // Rebuild components array from the (now normalized) componentMap
    entry.components = Object.values(entry.componentMap);
  }

  // ── Phase 2: Auto-infer root if LLM omitted beginRendering ──
  for (const [sid, entry] of surfaceData) {
    if (!entry.root && Object.keys(entry.componentMap).length > 0) {
      // Try to find a layout component (Column/Row) as root, otherwise use first component
      const layoutRoot = Object.entries(entry.componentMap).find(
        ([, c]) => c.component && ("Column" in c.component || "Row" in c.component)
      );
      entry.root = layoutRoot ? layoutRoot[0] : Object.keys(entry.componentMap)[0];
      console.warn(`[a2ui] Surface "${sid}": beginRendering missing, auto-inferred root="${entry.root}"`);
    }
  }

  // ── Phase 3: Persist to DB and emit consolidated events ──
  const newSurfaceIds = new Set<string>();

  for (const [sid, entry] of surfaceData) {
    const hasComponents = Object.keys(entry.componentMap).length > 0;

    // Always upsert so the row exists before binding updates.
    // upsertSurface returns true if it inserted a new row (atomic newness check).
    const isNew = upsertSurface({
      surfaceId: sid,
      ...(entry.title ? { title: entry.title } : {}),
      ...(hasComponents ? { components: entry.componentMap } : {}),
      ...(entry.root ? { root: entry.root, rendering: true } : {}),
    });

    if (isNew) newSurfaceIds.add(sid);

    // Send one consolidated surface event with both components AND root
    if (hasComponents || entry.root) {
      send({
        type: "a2ui.surface" as const,
        data: {
          surfaceId: sid,
          components: entry.components,
          ...(entry.root ? { root: entry.root } : {}),
        },
      });
    }

    // Send data bindings (row is guaranteed to exist now)
    if (entry.bindings) {
      updateSurfaceBindings(sid, entry.bindings);
      send({
        type: "a2ui.data" as const,
        data: { surfaceId: sid, bindings: entry.bindings },
      });
    }
  }

  // Send toast only for newly created surfaces
  for (const sid of newSurfaceIds) {
    send({ type: "a2ui.toast" as const, data: { surfaceId: sid, title: "Surface ready" } });
  }

  const ids = [...surfaceIds].join(", ");
  return {
    content: [{ type: "text", text: `A2UI surface(s) updated: ${ids}. ${messages.length} message(s) processed.` }],
  };
}

handlers.set(A2UI_PUSH_NAME, handleA2UIPush);
nativeToolMapping.set(A2UI_PUSH_NAME, { kind: "tool", id: "a2ui" });

const A2UI_RESET_NAME = "native__canvas_a2ui_reset";

const a2uiResetToolDef = tool({
  description:
    "[A2UI Reset] Clear the Brain Canvas UI. Use when the user asks to clear, remove, or reset the dashboard/UI. If surfaceId is provided, only that surface is removed. If omitted, all surfaces are cleared.",
  parameters: z.object({
    surfaceId: z
      .string()
      .optional()
      .describe("Surface id to reset. If omitted, all surfaces are cleared."),
  }),
});

async function handleA2UIReset(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const { getWSInstance } = await import("../gateway/ws-instance.ts");
  const ws = getWSInstance();
  const sessionId = context?.sessionId;

  if (!ws) {
    return { content: [{ type: "text", text: "A2UI: no active WebSocket connection. Reset not delivered." }] };
  }

  const surfaceId = args.surfaceId ? String(args.surfaceId) : undefined;

  const send = (event: GatewayServerEvent) => {
    if (sessionId) ws.broadcastToSession(sessionId, event);
    else ws.broadcast(event);
  };

  if (surfaceId) {
    const existed = deleteSurfaceFromDb(surfaceId);
    if (!existed) {
      return { content: [{ type: "text", text: `A2UI surface "${surfaceId}" not found.` }] };
    }
    send({ type: "a2ui.delete" as const, data: { surfaceId } });
    return { content: [{ type: "text", text: `A2UI surface "${surfaceId}" cleared.` }] };
  } else {
    deleteAllSurfaces();
    send({ type: "a2ui.deleteAll" as const, data: {} });
    return { content: [{ type: "text", text: "All A2UI surfaces cleared." }] };
  }
}

handlers.set(A2UI_RESET_NAME, handleA2UIReset);
nativeToolMapping.set(A2UI_RESET_NAME, { kind: "tool", id: "a2ui" });

// ---------------------------------------------------------------------------
// PC Control tools (v2: intent-based with 3-layer pipeline)
// ---------------------------------------------------------------------------

import {
  getPcSafetyLevel,
  hasConnectedAgents,
  localBackendAvailable,
  getBackend,
} from "./pc-control.ts";
import { executePcTask } from "./pc-pipeline.ts";
import type { LlmCallFn } from "./pc-pipeline.ts";

const PC_DO_NAME = "native__pc_do";
const PC_OBSERVE_NAME = "native__pc_observe";
const PC_SHELL_NAME = "native__pc_shell";

const pcDoToolDef = tool({
  description:
    "[PC Control] Execute a task on a PC. Describe WHAT you want to do in natural language — the system automatically chooses the best method (direct action, accessibility tree, or vision). Examples: 'open Firefox', 'click the Submit button', 'type hello@example.com in the email field', 'scroll down', 'alt+tab to switch windows', 'copy the selected text'. Use for all GUI interactions.",
  parameters: z.object({
    task: z.string().describe("Natural language description of what to do on the PC"),
    targetId: z.string().optional().describe("PC target ID. Omit for local PC or if only one PC is connected."),
  }),
});

const pcObserveToolDef = tool({
  description:
    "[PC Control] Observe the current state of a PC. Returns a screenshot and the UI accessibility tree (list of visible elements). Use this to see what's on screen before acting, or to verify the result of a previous action.",
  parameters: z.object({
    targetId: z.string().optional().describe("PC target ID. Omit for local PC or if only one PC is connected."),
  }),
});

const pcShellToolDef = tool({
  description:
    "[PC Control] Execute a shell command on a PC. Returns stdout, stderr, and exit code. Use for file operations, system inspection, or automation that doesn't require the GUI.",
  parameters: z.object({
    targetId: z.string().optional().describe("PC target ID. Omit for local PC or if only one PC is connected."),
    command: z.string().describe("The shell command to execute"),
    cwd: z.string().optional().describe("Working directory for the command"),
  }),
});

// ── PC control loop detection ──────────────────────────────────────
// Track consecutive pc_observe calls per session to detect screenshot loops.
const pcObserveTracker = new Map<string, { count: number; lastResetAt: number }>();
const PC_OBSERVE_LOOP_THRESHOLD = 3;
const PC_OBSERVE_TRACKER_TTL_MS = 5 * 60 * 1000; // 5 min stale window
const PC_OBSERVE_MAX_ENTRIES = 200; // prevent unbounded growth

function getPcObserveTracker(sessionId: string) {
  const now = Date.now();
  // Periodic cleanup: evict stale entries when map grows large
  if (pcObserveTracker.size > PC_OBSERVE_MAX_ENTRIES) {
    for (const [key, val] of pcObserveTracker) {
      if (now - val.lastResetAt > PC_OBSERVE_TRACKER_TTL_MS) pcObserveTracker.delete(key);
    }
  }
  let entry = pcObserveTracker.get(sessionId);
  if (!entry || now - entry.lastResetAt > PC_OBSERVE_TRACKER_TTL_MS) {
    entry = { count: 0, lastResetAt: now };
    pcObserveTracker.set(sessionId, entry);
  }
  return entry;
}

function resetPcObserveCount(sessionId: string) {
  const entry = pcObserveTracker.get(sessionId);
  if (entry) { entry.count = 0; entry.lastResetAt = Date.now(); }
}

async function handlePcDo(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const task = args.task as string;
  const targetId = args.targetId as string | undefined;

  // Successful pc_do resets the observe loop counter
  const sessionKey = context?.sessionId ?? "default";
  resetPcObserveCount(sessionKey);

  let backend;
  try {
    backend = getBackend(targetId);
  } catch (err) {
    return { content: [{ type: "text", text: (err as Error).message }] };
  }

  // Safety approval — use the action router to decide if this is a simple,
  // known-safe action. Only action-router matches (Layer 1) are auto-approved
  // in semi-autonomous mode. Everything else requires approval in supervised/semi-auto.
  const safetyLevel = getPcSafetyLevel();

  if (safetyLevel === "supervised") {
    const { approved } = await requestApproval(
      `PC Task: ${task}`,
      backend.hostname,
      { tier: "moderate" as const, subCommands: [] },
      context
    );
    if (!approved) {
      return { content: [{ type: "text", text: "Task denied by user." }] };
    }
  } else if (safetyLevel === "semi-autonomous") {
    // Only auto-approve tasks that match the action router (known keyboard shortcuts, etc.)
    // Everything else (LLM-resolved tasks) requires approval
    const { tryActionRouter } = await import("./action-patterns.ts");
    const isKnownAction = tryActionRouter(task) !== null;
    if (!isKnownAction) {
      const { approved } = await requestApproval(
        `PC Task: ${task}`,
        backend.hostname,
        { tier: "moderate" as const, subCommands: [] },
        context
      );
      if (!approved) {
        return { content: [{ type: "text", text: "Task denied by user." }] };
      }
    }
  }
  // autonomous mode: no approval needed

  // Build LLM call function using the server's LLM infrastructure
  const llmCall: LlmCallFn = async (prompt: string, image?: { data: string; mimeType: string }) => {
    const { createModelForRole } = await import("./llm-router.ts");
    const { generateText } = await import("ai");

    // Use "lightweight" role for a11y text-only calls, "primary" for vision
    const model = image ? createModelForRole("primary") : createModelForRole("lightweight");

    const messages: Array<{ role: "user"; content: unknown }> = [];

    if (image) {
      messages.push({
        role: "user",
        content: [
          { type: "image", image: image.data, mimeType: image.mimeType },
          { type: "text", text: prompt },
        ],
      });
    } else {
      messages.push({ role: "user", content: prompt });
    }

    const result = await generateText({
      model,
      messages: messages as Parameters<typeof generateText>[0]["messages"],
    });

    return result.text;
  };

  const result = await executePcTask(task, backend, {
    emit: context?.emitEvent ?? (() => {}),
    llmCall,
    safetyLevel,
  });

  // Audit log
  try {
    insertActivity({
      source: "pc-control",
      title: `PC ${result.success ? "✓" : "✗"}: ${task.slice(0, 100)}`,
      content: `Target: ${backend.hostname}, Layer: ${result.layerUsed}, Success: ${result.success}${result.error ? `, Error: ${result.error}` : ""}`,
    });
  } catch { /* non-critical */ }

  const content: NativeToolContentItem[] = [];
  content.push({
    type: "text",
    text: `${result.success ? "✓" : "✗"} ${result.summary} [Layer: ${result.layerUsed}]${result.error ? `\nError: ${result.error}` : ""}`,
  });

  if (result.screenshot) {
    content.push({
      type: "image",
      data: result.screenshot.data,
      mimeType: result.screenshot.mimeType ?? "image/jpeg",
    });
  }

  return { content };
}

async function handlePcObserve(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const targetId = args.targetId as string | undefined;

  // Loop detection: warn if observing too many times without taking action
  const sessionKey = context?.sessionId ?? "default";
  const tracker = getPcObserveTracker(sessionKey);
  tracker.count++;

  let backend;
  try {
    backend = getBackend(targetId);
  } catch (err) {
    return { content: [{ type: "text", text: (err as Error).message }] };
  }

  context?.emitEvent?.({ type: "pc.screenshot", data: { agentId: backend.id } });

  // Capture screenshot and a11y tree in parallel
  const [screenshot, a11yTree] = await Promise.all([
    backend.captureScreen().catch((err) => {
      console.error("[pc-observe] screenshot failed:", err);
      return null;
    }),
    backend.queryA11yTree({ maxDepth: 5 }).catch(() => null),
  ]);

  const content: NativeToolContentItem[] = [];

  if (screenshot) {
    content.push({
      type: "image",
      data: screenshot.data,
      mimeType: screenshot.mimeType ?? "image/jpeg",
    });
  }

  if (a11yTree) {
    try {
      const { serializeA11yTree } = await import("@chvor/pc-agent/a11y");
      const serialized = serializeA11yTree(a11yTree, { maxDepth: 5, maxNodes: 200 });
      content.push({
        type: "text",
        text: `UI Elements (${a11yTree.nodeCount} nodes):\n${serialized}`,
      });
    } catch {
      content.push({
        type: "text",
        text: `Screenshot taken. Accessibility tree available but serializer not loaded.`,
      });
    }
  } else {
    content.push({
      type: "text",
      text: screenshot
        ? `Screenshot taken (${screenshot.width}×${screenshot.height}). Accessibility tree not available on this platform.`
        : "Failed to capture screen.",
    });
  }

  // Loop detection warning
  if (tracker.count >= PC_OBSERVE_LOOP_THRESHOLD) {
    content.push({
      type: "text",
      text: `⚠ WARNING: You have observed the screen ${tracker.count} times without executing an action (pc_do). Either take a concrete action with pc_do, or tell the user what you see and what is blocking progress. Do NOT observe again without acting first.`,
    });
  }

  return { content };
}

async function handlePcShell(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const targetId = args.targetId as string | undefined;
  const command = args.command as string;
  const cwd = args.cwd as string | undefined;

  let backend;
  try {
    backend = getBackend(targetId);
  } catch (err) {
    return { content: [{ type: "text", text: (err as Error).message }] };
  }

  // Shell commands always require approval (regardless of safety level)
  const { approved } = await requestApproval(
    `PC shell: ${command}`,
    cwd ?? backend.hostname,
    { tier: "dangerous" as const, subCommands: [] },
    context
  );
  if (!approved) {
    return { content: [{ type: "text", text: "Shell command denied by user." }] };
  }

  const result = await backend.executeShell(command, cwd);

  // Audit log
  try {
    insertActivity({
      source: "pc-control",
      title: `PC Shell: ${command.slice(0, 80)}`,
      content: `Target: ${backend.hostname}, Exit: ${result.exitCode}${cwd ? `, CWD: ${cwd}` : ""}`,
    });
  } catch { /* non-critical */ }

  let output = "";
  if (result.stdout) output += `stdout:\n${result.stdout}\n`;
  if (result.stderr) output += `stderr:\n${result.stderr}\n`;
  output += `Exit code: ${result.exitCode}`;

  return { content: [{ type: "text", text: output }] };
}

handlers.set(PC_DO_NAME, handlePcDo);
handlers.set(PC_OBSERVE_NAME, handlePcObserve);
handlers.set(PC_SHELL_NAME, handlePcShell);

// Map PC tools to canvas node
nativeToolMapping.set(PC_DO_NAME, { kind: "skill", id: "pc-control" });
nativeToolMapping.set(PC_OBSERVE_NAME, { kind: "skill", id: "pc-control" });
nativeToolMapping.set(PC_SHELL_NAME, { kind: "skill", id: "pc-control" });

// ---------------------------------------------------------------------------
// Social Account Management (Composio)
// ---------------------------------------------------------------------------

const SOCIAL_CONNECT_NAME = "native__social_connect";
const socialConnectToolDef = tool({
  description:
    "[Social] Connect a social media account (Twitter/X, Reddit, LinkedIn, Instagram, etc.) via OAuth. " +
    "Returns a clickable authorization URL the user must visit to grant access. " +
    "Requires a Composio API key credential — if missing, guide the user to get one at https://app.composio.dev/settings",
  parameters: z.object({
    platform: z
      .string()
      .describe(
        "Platform to connect, e.g. 'twitter', 'reddit', 'linkedin', 'instagram', 'youtube', 'tiktok', 'facebook', 'bluesky', 'mastodon', 'pinterest', 'threads', 'discord', 'telegram'",
      ),
  }),
});

async function handleSocialConnect(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  try {
    const { initiateConnection } = await import("./composio-client.ts");
    const platform = String(args.platform).toLowerCase().trim();

    const serverPort = process.env.PORT ?? "9147";
    const callbackUrl = `http://localhost:${serverPort}/api/social/callback`;

    const result = await initiateConnection(platform, callbackUrl);

    return {
      content: [
        {
          type: "text",
          text:
            `To connect your ${platform} account, open this link:\n\n` +
            `${result.redirectUrl}\n\n` +
            `After authorizing, you'll be redirected back and the connection will be active. ` +
            `Use native__social_list to verify the connection afterwards.`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Social connect failed: ${msg}` }] };
  }
}

handlers.set(SOCIAL_CONNECT_NAME, handleSocialConnect);
nativeToolMapping.set(SOCIAL_CONNECT_NAME, { kind: "tool", id: "composio" });

const SOCIAL_LIST_NAME = "native__social_list";
const socialListToolDef = tool({
  description:
    "[Social] List connected social media accounts across all providers (Composio OAuth and custom MCP integrations).",
  parameters: z.object({
    platform: z
      .string()
      .optional()
      .describe("Optional: filter by platform name (e.g. 'twitter')"),
  }),
});

async function handleSocialList(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  try {
    const { listAllSocialConnections } = await import("./social-aggregator.ts");
    const platform = args.platform ? String(args.platform).toLowerCase().trim() : undefined;

    const connections = await listAllSocialConnections(platform);

    if (connections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: platform
              ? `No connected ${platform} accounts found. Use native__social_connect to connect one via Composio, or add a custom MCP tool.`
              : "No social accounts connected yet. Use native__social_connect to connect a platform via Composio, or add a custom MCP tool.",
          },
        ],
      };
    }

    const lines = connections.map((c, i) => {
      const parts = [`${i + 1}. **${c.platform}** — ${c.status} (via ${c.provider})`];
      if (c.connectedAt) parts[0] += `, connected ${c.connectedAt}`;
      if (c.id) parts.push(`   id: \`${c.id}\``);
      if (c.capabilities?.length) parts.push(`   capabilities: ${c.capabilities.join(", ")}`);
      return parts.join("\n");
    });

    return {
      content: [
        {
          type: "text",
          text: `Connected social accounts:\n\n${lines.join("\n")}`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Failed to list social accounts: ${msg}` }] };
  }
}

handlers.set(SOCIAL_LIST_NAME, handleSocialList);
nativeToolMapping.set(SOCIAL_LIST_NAME, { kind: "tool", id: "composio" });

const SOCIAL_DISCONNECT_NAME = "native__social_disconnect";
const socialDisconnectToolDef = tool({
  description:
    "[Social] Disconnect a social media account. Use native__social_list first to get the account ID.",
  parameters: z.object({
    accountId: z.string().describe("The connected account ID to disconnect (from native__social_list)"),
  }),
});

async function handleSocialDisconnect(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  try {
    const { disconnectAccount } = await import("./composio-client.ts");
    const accountId = String(args.accountId);

    await disconnectAccount(accountId);

    return {
      content: [
        {
          type: "text",
          text: `Account \`${accountId}\` has been disconnected successfully.`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Failed to disconnect account: ${msg}` }] };
  }
}

handlers.set(SOCIAL_DISCONNECT_NAME, handleSocialDisconnect);
nativeToolMapping.set(SOCIAL_DISCONNECT_NAME, { kind: "tool", id: "composio" });

// ---------------------------------------------------------------------------
// Sandbox: Docker code execution
// ---------------------------------------------------------------------------

const SANDBOX_EXECUTE_NAME = "native__sandbox_execute";

const sandboxExecuteToolDef = tool({
  description:
    "[Code Sandbox] Execute code safely in an isolated Docker container. " +
    "Supports Python, Node.js, and Bash. Code runs in ephemeral containers with resource limits. " +
    "No network access by default. Use this for running untrusted code, testing scripts, or computation that needs isolation. " +
    "Prefer this over shell_execute for any code execution that doesn't need host access.",
  parameters: z.object({
    language: z.enum(["python", "node", "bash"]).describe("Programming language"),
    code: z.string().describe("The code to execute"),
    timeoutMs: z.number().optional().describe("Override timeout in ms (max 120000)"),
  }),
});

async function handleSandboxExecute(
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const { isSandboxEnabled, getSandboxConfig } = await import("../db/config-store.ts");
  const { isDockerAvailable, executeInSandbox } = await import("./sandbox.ts");

  if (!isSandboxEnabled()) {
    return { content: [{ type: "text", text: "Sandbox is disabled. Enable it in Settings → Permissions → Code Sandbox." }] };
  }
  if (!isDockerAvailable()) {
    return { content: [{ type: "text", text: "Docker is not available. Install Docker Desktop (https://docker.com/get-started) and ensure the daemon is running." }] };
  }

  const language = String(args.language) as import("@chvor/shared").SandboxLanguage;
  const code = String(args.code);
  const config = getSandboxConfig();
  const timeoutMs = Math.min(Number(args.timeoutMs ?? config.timeoutMs), 120000);

  const nodeId = randomUUID();
  context?.emitEvent?.({ type: "sandbox.started", data: { nodeId, language } });

  try {
    const result = await executeInSandbox({
      language,
      code,
      config: { ...config, timeoutMs },
    });

    context?.emitEvent?.({ type: "sandbox.completed", data: { nodeId, exitCode: result.exitCode, durationMs: result.durationMs } });

    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    if (parts.length === 0) parts.push("(no output)");

    const meta: string[] = [`exit: ${result.exitCode}`, `${(result.durationMs / 1000).toFixed(1)}s`];
    if (result.timedOut) meta.push("TIMED OUT");
    if (result.oomKilled) meta.push("OOM KILLED");
    parts.push(`\n[${meta.join(", ")}]`);

    return { content: [{ type: "text", text: parts.join("\n") }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context?.emitEvent?.({ type: "sandbox.failed", data: { nodeId, error: msg } });
    logError("native_tool" as ErrorCategory, err, { tool: SANDBOX_EXECUTE_NAME });
    return { content: [{ type: "text", text: `Sandbox execution failed: ${msg}` }] };
  }
}

handlers.set(SANDBOX_EXECUTE_NAME, handleSandboxExecute);
nativeToolMapping.set(SANDBOX_EXECUTE_NAME, { kind: "tool", id: "sandbox" });

// ---------------------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------------------

/** All native tool definitions (for merging into the tool map). */
export function getNativeToolDefinitions(): Record<
  string,
  ReturnType<typeof tool>
> {
  const selfHealing = getSelfHealingEnabled();

  return {
    [FETCH_TOOL_NAME]: fetchToolDef,
    [WEB_SEARCH_TOOL_NAME]: webSearchToolDef,
    [CREATE_SKILL_TOOL_NAME]: createSkillToolDef,
    [CREATE_SCHEDULE_NAME]: createScheduleToolDef,
    [LIST_SCHEDULES_NAME]: listSchedulesToolDef,
    [DELETE_SCHEDULE_NAME]: deleteScheduleToolDef,
    [CREATE_WEBHOOK_NAME]: createWebhookToolDef,
    [LIST_WEBHOOKS_NAME]: listWebhooksToolDef,
    [DELETE_WEBHOOK_NAME]: deleteWebhookToolDef,
    [CREATE_WORKFLOW_NAME]: createWorkflowToolDef,
    [RUN_WORKFLOW_NAME]: runWorkflowToolDef,
    [LIST_WORKFLOWS_NAME]: listWorkflowsToolDef,
    [DELETE_WORKFLOW_NAME]: deleteWorkflowToolDef,
    [ADD_CREDENTIAL_NAME]: addCredentialToolDef,
    [UPDATE_CREDENTIAL_NAME]: updateCredentialToolDef,
    [LIST_CREDENTIALS_NAME]: listCredentialsToolDef,
    [USE_CREDENTIAL_NAME]: useCredentialToolDef,
    [DELETE_CREDENTIAL_NAME]: deleteCredentialToolDef,
    [TEST_CREDENTIAL_NAME]: testCredentialToolDef,
    [SWITCH_MODEL_NAME]: switchModelToolDef,
    [BROWSER_NAVIGATE_NAME]: browserNavigateToolDef,
    [BROWSER_ACT_NAME]: browserActToolDef,
    [BROWSER_EXTRACT_NAME]: browserExtractToolDef,
    [BROWSER_OBSERVE_NAME]: browserObserveToolDef,
    [SHELL_EXECUTE_NAME]: shellExecuteToolDef,
    [CLAUDE_CODE_NAME]: claudeCodeToolDef,
    [GENERATE_IMAGE_NAME]: generateImageToolDef,
    [RECALL_DETAIL_NAME]: recallDetailToolDef,
    [INGEST_URL_NAME]: ingestUrlToolDef,
    [INGEST_DOCUMENT_NAME]: ingestDocumentToolDef,
    [REGISTRY_SEARCH_NAME]: registrySearchToolDef,
    [REGISTRY_INSTALL_NAME]: registryInstallToolDef,
    [REGISTRY_UNINSTALL_NAME]: registryUninstallToolDef,
    [SOCIAL_CONNECT_NAME]: socialConnectToolDef,
    [SOCIAL_LIST_NAME]: socialListToolDef,
    [SOCIAL_DISCONNECT_NAME]: socialDisconnectToolDef,
    ...(isCapabilityEnabled("tool", "a2ui") ? {
      [A2UI_PUSH_NAME]: a2uiPushToolDef,
      [A2UI_RESET_NAME]: a2uiResetToolDef,
    } : {}),
    ...(selfHealing ? {
      [DIAGNOSE_TOOL_NAME]: diagnoseToolDef,
      [REPAIR_TOOL_NAME]: repairToolDef,
    } : {}),
    // PC Control tools — only when feature is enabled and a backend is available
    ...(getPcControlEnabled() && (localBackendAvailable() || hasConnectedAgents()) ? {
      [PC_DO_NAME]: pcDoToolDef,
      [PC_OBSERVE_NAME]: pcObserveToolDef,
      [PC_SHELL_NAME]: pcShellToolDef,
    } : {}),
    // Sandbox: Docker code execution — always register; handler checks availability at runtime
    [SANDBOX_EXECUTE_NAME]: sandboxExecuteToolDef,
  };
}

/** Check if a qualified tool name is a native tool. */
export function isNativeTool(qualifiedName: string): boolean {
  return handlers.has(qualifiedName);
}

/** Execute a native tool by its qualified name. */
export async function callNativeTool(
  qualifiedName: string,
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const handler = handlers.get(qualifiedName);
  if (!handler) throw new Error(`No native tool handler: ${qualifiedName}`);
  return handler(args, context);
}
