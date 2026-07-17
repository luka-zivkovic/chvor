import { expireIntegrationSetupFlows } from "../db/integration-setup-store.ts";

const CLEANUP_INTERVAL_MS = 60_000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function runIntegrationSetupCleanup(): void {
  try {
    expireIntegrationSetupFlows();
  } catch (error) {
    console.warn(
      "[integration-setup] expiry cleanup failed:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function startIntegrationSetupCleanup(): void {
  if (cleanupTimer) return;
  runIntegrationSetupCleanup();
  cleanupTimer = setInterval(runIntegrationSetupCleanup, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

export function stopIntegrationSetupCleanup(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
