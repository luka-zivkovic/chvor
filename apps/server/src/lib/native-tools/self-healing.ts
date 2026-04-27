import { tool } from "ai";
import { z } from "zod";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { formatUptime } from "../error-logger.ts";
import type { ErrorCategory } from "../error-logger.ts";
import { getSelfHealingEnabled, setConfig } from "../../db/config-store.ts";
import { insertActivity } from "../../db/activity-store.ts";
import type { NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

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

const handleDiagnose: NativeToolHandler = async (args: Record<string, unknown>): Promise<NativeToolResult> => {
  const scope = String(args.scope ?? "full");
  const errorLimit = Math.min(Number(args.errorLimit ?? 20), 100);
  const errorCategory = args.errorCategory ? String(args.errorCategory) as ErrorCategory : undefined;

  const { getRecentErrors, getErrorStats, getServerUptime } = await import("../error-logger.ts");
  const sections: string[] = ["=== Chvor System Diagnosis ===", ""];

  if (scope === "health" || scope === "full") {
    const { loadSkills, loadTools } = await import("../capability-loader.ts");
    const { mcpManager } = await import("../mcp-manager.ts");
    const { getActiveBrowserCount } = await import("../browser-manager.ts");
    const { listCredentials } = await import("../../db/credential-store.ts");
    const { listMemories } = await import("../../db/memory-store.ts");
    const { listSchedules } = await import("../../db/schedule-store.ts");

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
};

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

const handleRepair: NativeToolHandler = async (args: Record<string, unknown>): Promise<NativeToolResult> => {
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

      const { mcpManager } = await import("../mcp-manager.ts");
      const closed = await mcpManager.closeConnection(toolId);
      recent.push(now);

      resultText = closed
        ? `Closed MCP connection for "${toolId}". It will re-spawn automatically on next use.`
        : `No active MCP connection found for "${toolId}" — it may not have been spawned yet.`;
      break;
    }

    case "reload_capabilities": {
      const { reloadAll } = await import("../capability-loader.ts");
      const { invalidateToolCache } = await import("../tool-builder.ts");
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
        const { parseCapabilityMd } = await import("../capability-parser.ts");
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
      const { reloadAll } = await import("../capability-loader.ts");
      const { invalidateToolCache } = await import("../tool-builder.ts");
      invalidateToolCache();
      reloadAll();

      resultText = `Updated skill "${skillId}" at ${filePath}. Capabilities reloaded.`;
      break;
    }

    case "clear_browsers": {
      const { shutdownAllBrowsers } = await import("../browser-manager.ts");
      await shutdownAllBrowsers();
      resultText = "All browser sessions closed.";
      break;
    }

    case "clear_error_log": {
      const errorIds = Array.isArray(args.errorIds) ? args.errorIds.map(String) : [];
      if (errorIds.length === 0) {
        return { content: [{ type: "text", text: "Error: errorIds array is required for clear_error_log" }] };
      }
      const { markResolved } = await import("../error-logger.ts");
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
    const { getWSInstance } = await import("../../gateway/ws-instance.ts");
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
};

export const selfHealingModule: NativeToolModule = {
  group: "core",
  criticality: "always-available",
  defs: {
    [DIAGNOSE_TOOL_NAME]: diagnoseToolDef,
    [REPAIR_TOOL_NAME]: repairToolDef,
  },
  handlers: {
    [DIAGNOSE_TOOL_NAME]: handleDiagnose,
    [REPAIR_TOOL_NAME]: handleRepair,
  },
  enabled: () => getSelfHealingEnabled(),
};
