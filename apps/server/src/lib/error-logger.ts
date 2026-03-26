import { appendFileSync, writeFileSync, readFileSync, readdirSync, unlinkSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { containsSensitiveData } from "./sensitive-filter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | "tool_failure"
  | "mcp_crash"
  | "llm_error"
  | "llm_fallback"
  | "network_error"
  | "capability_error"
  | "browser_error"
  | "scheduler_error"
  | "webhook_error"
  | "system_error";

export interface ErrorLogEntry {
  id: string;
  timestamp: string;
  category: ErrorCategory;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  resolved?: boolean;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LOGS_DIR = join(homedir(), ".chvor", "logs");
const RETENTION_DAYS = 7;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const serverStartTime = Date.now();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayFileName(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `errors-${yyyy}-${mm}-${dd}.jsonl`;
}

function ensureLogsDir(): void {
  mkdirSync(LOGS_DIR, { recursive: true });
}

/** Redact sensitive values in a context object. */
function redactContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    result[key] = containsSensitiveData(str) ? "[REDACTED]" : value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Log a structured error entry. Returns the entry on success, null if skipped. */
export function logError(
  category: ErrorCategory,
  error: unknown,
  context?: Record<string, unknown>,
): ErrorLogEntry | null {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  const message = containsSensitiveData(rawMessage)
    ? "[REDACTED — contains sensitive data]"
    : rawMessage;

  const entry: ErrorLogEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    category,
    message,
    ...(stack && !containsSensitiveData(stack) ? { stack } : {}),
    ...(context ? { context: redactContext(context) } : {}),
  };

  try {
    ensureLogsDir();
    const filePath = join(LOGS_DIR, todayFileName());

    // Safety cap — don't grow a single day's file beyond limit
    if (existsSync(filePath)) {
      const stat = statSync(filePath);
      if (stat.size >= MAX_FILE_SIZE) {
        console.error(`[error-logger] daily log exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB, skipping write`);
        return entry;
      }
    }

    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
  } catch (writeErr) {
    console.error("[error-logger] failed to write log:", writeErr);
  }

  return entry;
}

/** Read recent error entries, optionally filtered. */
export function getRecentErrors(opts?: {
  limit?: number;
  category?: ErrorCategory;
  since?: string;
}): ErrorLogEntry[] {
  const limit = Math.min(opts?.limit ?? 20, 100);
  const since = opts?.since ? new Date(opts.since).getTime() : 0;

  ensureLogsDir();

  // Read today + previous days (newest first) until we have enough entries
  const files = readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith("errors-") && f.endsWith(".jsonl"))
    .sort()
    .reverse();

  const entries: ErrorLogEntry[] = [];

  for (const file of files) {
    if (entries.length >= limit) break;
    try {
      const content = readFileSync(join(LOGS_DIR, file), "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (entries.length >= limit) break;
        try {
          const entry: ErrorLogEntry = JSON.parse(lines[i]);
          if (opts?.category && entry.category !== opts.category) continue;
          if (since && new Date(entry.timestamp).getTime() < since) continue;
          entries.push(entry);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return entries;
}

/** Get aggregate error stats. */
export function getErrorStats(): {
  total: number;
  byCategory: Record<string, number>;
  last24h: number;
} {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const all = getRecentErrors({ limit: 100 });
  const last24h = all.filter((e) => e.timestamp >= since24h);

  const byCategory: Record<string, number> = {};
  for (const e of last24h) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
  }

  return { total: all.length, byCategory, last24h: last24h.length };
}

/** Mark an error entry as resolved (rewrites the line in the file). */
export function markResolved(errorId: string): boolean {
  ensureLogsDir();
  const files = readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith("errors-") && f.endsWith(".jsonl"));

  for (const file of files) {
    const filePath = join(LOGS_DIR, file);
    try {
      const content = readFileSync(filePath, "utf8");
      const lines = content.trim().split("\n");
      let found = false;
      const updated = lines.map((line) => {
        try {
          const entry: ErrorLogEntry = JSON.parse(line);
          if (entry.id === errorId) {
            found = true;
            return JSON.stringify({ ...entry, resolved: true });
          }
        } catch { /* skip */ }
        return line;
      });
      if (found) {
        writeFileSync(filePath, updated.join("\n") + "\n", "utf8");
        return true;
      }
    } catch { /* skip */ }
  }
  return false;
}

/** Format milliseconds as a human-readable uptime string. */
export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}

/** Server uptime in milliseconds. */
export function getServerUptime(): number {
  return Date.now() - serverStartTime;
}

/** Delete log files older than retention period. Returns count of deleted files. */
export function rotateOldLogs(): number {
  ensureLogsDir();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;

  const files = readdirSync(LOGS_DIR).filter(
    (f) => f.startsWith("errors-") && f.endsWith(".jsonl"),
  );

  for (const file of files) {
    // Parse date from filename: errors-YYYY-MM-DD.jsonl
    const match = file.match(/^errors-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match) continue;
    const fileDate = new Date(match[1]).getTime();
    if (fileDate < cutoff) {
      try {
        unlinkSync(join(LOGS_DIR, file));
        deleted++;
      } catch { /* skip */ }
    }
  }

  if (deleted > 0) {
    console.log(`[error-logger] rotated ${deleted} old log file(s)`);
  }
  return deleted;
}
