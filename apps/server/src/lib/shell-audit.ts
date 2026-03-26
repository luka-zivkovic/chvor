import { randomUUID } from "node:crypto";
import { getDb } from "../db/database.ts";
import type { CommandTier } from "./command-classifier.ts";

export interface ShellAuditEntry {
  id: string;
  command: string;
  workingDir: string;
  tier: CommandTier;
  approved: boolean;
  deniedReason?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  sessionId?: string;
  createdAt: string;
}

export function logShellExecution(entry: Omit<ShellAuditEntry, "id" | "createdAt">): void {
  const db = getDb();
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO shell_audit (id, command, working_dir, tier, approved, denied_reason, exit_code, stdout, stderr, duration_ms, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    entry.command,
    entry.workingDir,
    entry.tier,
    entry.approved ? 1 : 0,
    entry.deniedReason ?? null,
    entry.exitCode ?? null,
    entry.stdout ?? null,
    entry.stderr ?? null,
    entry.durationMs,
    entry.sessionId ?? null,
    createdAt
  );
}

export function getShellAuditLog(limit = 50): ShellAuditEntry[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM shell_audit ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    command: String(r.command),
    workingDir: String(r.working_dir),
    tier: String(r.tier) as CommandTier,
    approved: r.approved === 1,
    deniedReason: r.denied_reason ? String(r.denied_reason) : undefined,
    exitCode: r.exit_code != null ? Number(r.exit_code) : undefined,
    stdout: r.stdout ? String(r.stdout) : undefined,
    stderr: r.stderr ? String(r.stderr) : undefined,
    durationMs: Number(r.duration_ms),
    sessionId: r.session_id ? String(r.session_id) : undefined,
    createdAt: String(r.created_at),
  }));
}
