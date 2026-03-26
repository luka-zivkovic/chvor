import { createBackup, getBackupConfig } from "./backup.ts";
import { setConfig } from "../db/config-store.ts";

let backupTimer: ReturnType<typeof setInterval> | null = null;

export function startBackupScheduler(): void {
  if (backupTimer) return;

  const config = getBackupConfig();
  if (!config.enabled) return;

  const intervalMs = config.intervalHours * 60 * 60 * 1000;

  backupTimer = setInterval(async () => {
    try {
      console.log("[backup] scheduled backup starting...");
      const info = await createBackup("scheduled");
      setConfig("backup.lastRunAt", new Date().toISOString());
      setConfig("backup.lastError", "");
      console.log(`[backup] scheduled backup complete: ${info.filename} (${info.sizeBytes} bytes)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConfig("backup.lastError", msg);
      console.error("[backup] scheduled backup failed:", msg);
    }
  }, intervalMs);
  backupTimer.unref();

  console.log(`[backup] scheduler started (every ${config.intervalHours}h)`);
}

export function stopBackupScheduler(): void {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
}

export function restartBackupScheduler(): void {
  stopBackupScheduler();
  startBackupScheduler();
}
