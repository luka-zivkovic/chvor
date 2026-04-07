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
      const info = await createBackup("scheduled");
      console.log(`[backup] scheduled backup complete: ${info.filename} (${info.sizeBytes} bytes)`);
      try {
        setConfig("backup.lastRunAt", new Date().toISOString());
        setConfig("backup.lastError", "");
      } catch (err) {
        console.error("[backup] failed to update backup config:", err);
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
