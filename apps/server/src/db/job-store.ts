import { getDb } from "./database.ts";

export interface SystemJob {
  jobId: string;
  intervalMs: number;
  lastRunAt: string | null;
  nextRunAt: string;
  status: "idle" | "running" | "failed";
  lastError: string | null;
}

export function getJob(jobId: string): SystemJob | null {
  const row = getDb()
    .prepare("SELECT * FROM system_jobs WHERE job_id = ?")
    .get(jobId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

export function getAllJobs(): SystemJob[] {
  const rows = getDb()
    .prepare("SELECT * FROM system_jobs")
    .all() as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function updateJobRun(
  jobId: string,
  updates: {
    lastRunAt?: string;
    nextRunAt?: string;
    status?: SystemJob["status"];
    lastError?: string | null;
  },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.lastRunAt !== undefined) {
    sets.push("last_run_at = ?");
    values.push(updates.lastRunAt);
  }
  if (updates.nextRunAt !== undefined) {
    sets.push("next_run_at = ?");
    values.push(updates.nextRunAt);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }
  if (updates.lastError !== undefined) {
    sets.push("last_error = ?");
    values.push(updates.lastError);
  }

  if (sets.length === 0) return;
  values.push(jobId);
  getDb()
    .prepare(`UPDATE system_jobs SET ${sets.join(", ")} WHERE job_id = ?`)
    .run(...values);
}

export function resetStuckJobs(): number {
  const result = getDb()
    .prepare("UPDATE system_jobs SET status = 'idle' WHERE status = 'running'")
    .run();
  return result.changes;
}

function mapRow(row: Record<string, unknown>): SystemJob {
  return {
    jobId: row.job_id as string,
    intervalMs: row.interval_ms as number,
    lastRunAt: (row.last_run_at as string) || null,
    nextRunAt: row.next_run_at as string,
    status: (row.status as SystemJob["status"]) || "idle",
    lastError: (row.last_error as string) || null,
  };
}
