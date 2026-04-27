import type { PulseConfig, UpdatePulseRequest } from "@chvor/shared";
import { getConfig, setConfig } from "./base.ts";

// --- Pulse config ---

export function getPulseConfig(): PulseConfig {
  return {
    enabled: (getConfig("pulse.enabled") ?? "false") === "true",
    intervalMinutes: parseInt(getConfig("pulse.intervalMinutes") ?? "30", 10),
    lastRunAt: getConfig("pulse.lastRunAt") || null,
    lastResult: getConfig("pulse.lastResult") || null,
    lastError: getConfig("pulse.lastError") || null,
  };
}

export function updatePulseConfig(updates: UpdatePulseRequest): PulseConfig {
  if (updates.enabled !== undefined) {
    setConfig("pulse.enabled", String(updates.enabled));
  }
  if (updates.intervalMinutes !== undefined) {
    setConfig("pulse.intervalMinutes", String(updates.intervalMinutes));
  }
  return getPulseConfig();
}

export function recordPulseRun(
  result: string | null,
  error: string | null
): void {
  setConfig("pulse.lastRunAt", new Date().toISOString());
  setConfig("pulse.lastResult", result ? result.slice(0, 2000) : "");
  setConfig("pulse.lastError", error ?? "");
}
