import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSelfHealingEnabled } from "../db/config-store.ts";
import { getServerUptime, getErrorStats, getRecentErrors, formatUptime } from "./error-logger.ts";
import { loadSkills, loadTools } from "./capability-loader.ts";
import { mcpManager } from "./mcp-manager.ts";
import { getActiveBrowserCount } from "./browser-manager.ts";
import { listCredentials } from "../db/credential-store.ts";
import { listSchedules } from "../db/schedule-store.ts";
import { getMemoryCount } from "../db/memory-store.ts";

const MANIFEST_PATH = join(homedir(), ".chvor", "MANIFEST.md");
const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY_ROWS = 48; // 24h at 30min intervals

let timer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// History parsing
// ---------------------------------------------------------------------------

interface HistoryRow {
  timestamp: string;
  errors24h: number;
  mcpUp: string;
  skills: number;
  notes: string;
}

function parseHistory(content: string): HistoryRow[] {
  const match = content.match(/## History\n\|[^\n]+\n\|[^\n]+\n([\s\S]*?)(?=\n##|$)/);
  if (!match) return [];
  return match[1]
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cols.length < 5) return null;
      return {
        timestamp: cols[0],
        errors24h: parseInt(cols[1]) || 0,
        mcpUp: cols[2],
        skills: parseInt(cols[3]) || 0,
        notes: cols[4],
      };
    })
    .filter((r): r is HistoryRow => r !== null);
}

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------

export async function writeManifest(): Promise<void> {
  try {
    const now = new Date().toISOString();
    const skills = loadSkills();
    const tools = loadTools();
    const mcpStatus = await mcpManager.getConnectionStatus();
    const browserCount = getActiveBrowserCount();
    const creds = listCredentials();
    const schedules = listSchedules();
    const memoryCount = getMemoryCount();
    const activeSchedules = schedules.filter((s) => s.enabled);
    const stats = getErrorStats();

    // Channel status
    const channelTypes = ["telegram", "discord", "slack", "whatsapp", "matrix"] as const;
    const channelParts: string[] = ["Web Chat: active"];
    for (const ct of channelTypes) {
      const match = creds.find((c) => c.type === ct);
      if (match?.testStatus === "success") channelParts.push(`${ct}: active`);
      else if (match) channelParts.push(`${ct}: configured`);
    }
    const activeChannels = channelParts.filter((p) => p.includes("active")).length;
    const totalChannels = channelParts.length;

    // MCP status string
    const totalTools = tools.filter((t) => t.mcpServer).length;
    const mcpRunning = mcpStatus.filter((s) => s.connected).length;
    const mcpStr = `${mcpRunning}/${totalTools}`;

    // Notes for this snapshot
    const notes: string[] = [];
    const errors = getRecentErrors({ limit: 5 });
    if (errors.length > 0) {
      const categories = [...new Set(errors.map((e) => e.category))];
      notes.push(categories.join(", "));
    }
    if (notes.length === 0) notes.push("—");

    // Read previous history
    let history: HistoryRow[] = [];
    if (existsSync(MANIFEST_PATH)) {
      try {
        const existing = readFileSync(MANIFEST_PATH, "utf8");
        history = parseHistory(existing);
      } catch { /* start fresh */ }
    }

    // Add current row and trim
    history.push({
      timestamp: now.replace(/\.\d{3}Z$/, "Z"),
      errors24h: stats.last24h,
      mcpUp: mcpStr,
      skills: skills.length,
      notes: notes.join("; "),
    });
    if (history.length > MAX_HISTORY_ROWS) {
      history = history.slice(-MAX_HISTORY_ROWS);
    }

    // Trend calculation
    const prev24h = history.length >= 2 ? history[history.length - 2].errors24h : 0;
    const current24h = stats.last24h;
    let trend = "→ (stable)";
    if (current24h > prev24h) trend = `↑ from ${prev24h}`;
    else if (current24h < prev24h) trend = `↓ from ${prev24h}`;

    // Error category breakdown
    const catBreakdown = Object.entries(stats.byCategory)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");

    // Build markdown
    const lines: string[] = [
      "# Chvor Health Manifest",
      `> Auto-generated every 30 minutes. Last updated: ${now}`,
      "",
      "## System",
      `- Uptime: ${formatUptime(getServerUptime())}`,
      `- Node: ${process.version}`,
      "",
      "## Components",
      "| Component | Status | Detail |",
      "|-----------|--------|--------|",
      `| Skills | ${skills.length} loaded | ${skills.filter((s) => s.source === "bundled").length} bundled, ${skills.filter((s) => s.source === "user").length} user |`,
      `| Tools | ${tools.length} loaded | ${tools.filter((t) => t.builtIn).length} bundled, ${tools.filter((t) => !t.builtIn).length} user |`,
      `| MCP servers | ${mcpStr} running | ${mcpStatus.filter((s) => s.connected).map((s) => s.toolId).join(", ") || "none active"} |`,
      `| Browser | ${browserCount} session(s) | ${browserCount > 0 ? "active" : "idle"} |`,
      `| Scheduler | ${activeSchedules.length} active | ${schedules.length} total |`,
      `| Channels | ${activeChannels}/${totalChannels} active | ${channelParts.join(", ")} |`,
      `| Memories | ${memoryCount} | — |`,
      "",
      "## Error Summary (24h)",
      `- Total: ${stats.last24h} errors`,
      catBreakdown ? `- ${catBreakdown}` : "- No errors by category",
      `- Trend: ${trend}`,
      "",
      "## History",
      "| Timestamp | Errors (24h) | MCP up | Skills | Notes |",
      "|-----------|-------------|--------|--------|-------|",
    ];

    for (const row of history) {
      lines.push(`| ${row.timestamp} | ${row.errors24h} | ${row.mcpUp} | ${row.skills} | ${row.notes} |`);
    }

    writeFileSync(MANIFEST_PATH, lines.join("\n") + "\n", "utf8");
  } catch (err) {
    console.error("[health-manifest] failed to write manifest:", err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function initManifest(): void {
  if (!getSelfHealingEnabled()) {
    console.log("[health-manifest] disabled via config");
    return;
  }
  // Clear any existing timer to prevent duplicates from rapid toggle
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  writeManifest().catch((err) => console.error("[health-manifest] initial write failed:", err));
  timer = setInterval(() => writeManifest().catch((err) => console.error("[health-manifest] periodic write failed:", err)), INTERVAL_MS);
  console.log("[health-manifest] initialized (interval: 30m)");
}

export function shutdownManifest(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log("[health-manifest] shutdown");
}
