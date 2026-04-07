import { createBackup, getBackupConfig } from "./backup.ts";
import { setConfig } from "../db/config-store.ts";
import { startPeriodicJob, stopPeriodicJob } from "./job-runner.ts";

export function startBackupScheduler(): void {
  const config = getBackupConfig();
  if (!config.enabled) return;

  const intervalMs = config.intervalHours * 60 * 60 * 1000;

  startPeriodicJob({
    id: "backup",
    intervalMs,
    run: async () => {
      console.log("[backup] scheduled backup starting...");
      try {
        const info = await createBackup("scheduled");
        console.log(`[backup] scheduled backup complete: ${info.filename} (${info.sizeBytes} bytes)`);
        setConfig("backup.lastRunAt", new Date().toISOString());
        setConfig("backup.lastError", "");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[backup] scheduled backup failed:", msg);
        try { setConfig("backup.lastError", msg); } catch { /* best-effort */ }
        throw err; // re-throw so job-runner marks the job as failed
      }
    },
  });
}

export function stopBackupScheduler(): void {
  stopPeriodicJob("backup");
}

export function restartBackupScheduler(): void {
  stopBackupScheduler();
  startBackupScheduler();
}
