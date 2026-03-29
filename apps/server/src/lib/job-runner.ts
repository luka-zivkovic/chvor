/**
 * Persistent periodic job runner.
 *
 * Replaces raw setInterval with DB-backed scheduling that survives crashes.
 * On startup, detects overdue jobs and runs them immediately.
 */

import { getJob, updateJobRun, resetStuckJobs } from "../db/job-store.ts";

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export interface PeriodicJobConfig {
  id: string;
  intervalMs: number;
  run: () => void | Promise<void>;
}

/**
 * Initialize the job runner. Call once on startup before starting any jobs.
 * Resets jobs stuck in 'running' state from a previous crash.
 */
export function initJobRunner(): void {
  const stuck = resetStuckJobs();
  if (stuck > 0) {
    console.log(`[job-runner] reset ${stuck} stuck job(s) from previous crash`);
  }
}

/**
 * Start a persistent periodic job. If the job is overdue (missed while server
 * was down), it runs immediately. Otherwise, it schedules for the next run time.
 */
export function startPeriodicJob(config: PeriodicJobConfig): void {
  if (timers.has(config.id)) return; // already running

  const job = getJob(config.id);
  if (!job) {
    console.warn(`[job-runner] unknown job: ${config.id}`);
    return;
  }

  // Update interval if it changed (e.g., backup config)
  if (job.intervalMs !== config.intervalMs) {
    updateJobRun(config.id, { nextRunAt: computeNextRun(config.intervalMs) });
  }

  const nextRunAt = new Date(job.nextRunAt).getTime();
  const now = Date.now();
  const isOverdue = nextRunAt <= now;

  if (isOverdue) {
    console.log(`[job-runner] ${config.id} is overdue — running now`);
    executeAndReschedule(config);
  } else {
    const delay = nextRunAt - now;
    console.log(`[job-runner] ${config.id} scheduled in ${Math.round(delay / 60000)}m`);
    armTimer(config, delay);
  }
}

/**
 * Stop a periodic job.
 */
export function stopPeriodicJob(id: string): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

/**
 * Stop all periodic jobs.
 */
export function stopAllPeriodicJobs(): void {
  for (const [id, timer] of timers) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

// ── Internal ──────────────────────────────────────────────

function armTimer(config: PeriodicJobConfig, delayMs: number): void {
  const timer = setTimeout(() => executeAndReschedule(config), delayMs);
  timer.unref();
  timers.set(config.id, timer);
}

async function executeAndReschedule(config: PeriodicJobConfig): Promise<void> {
  // Mark as running in DB first so crash detection works if process dies here
  updateJobRun(config.id, { status: "running" });
  timers.delete(config.id);

  try {
    await config.run();
    const nextRunAt = computeNextRun(config.intervalMs);
    updateJobRun(config.id, {
      status: "idle",
      lastRunAt: new Date().toISOString(),
      nextRunAt,
      lastError: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const nextRunAt = computeNextRun(config.intervalMs);
    updateJobRun(config.id, {
      status: "failed",
      lastRunAt: new Date().toISOString(),
      nextRunAt,
      lastError: msg,
    });
    console.error(`[job-runner] ${config.id} failed:`, msg);
  }

  // Schedule next run
  armTimer(config, config.intervalMs);
}

function computeNextRun(intervalMs: number): string {
  return new Date(Date.now() + intervalMs).toISOString();
}
