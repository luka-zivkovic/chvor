import type { RetentionConfig, UpdateRetentionRequest } from "@chvor/shared";
import { getConfig, setConfig } from "./base.ts";

// --- Retention config ---

function readMaxAgeDays(key: string): number {
  const stored = getConfig(key);
  if (stored === null || stored.trim() === "") return 30;
  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 30;
}

function normalizeMaxAgeDays(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite non-negative number`);
  }
  return Math.floor(value);
}

export function getRetentionConfig(): RetentionConfig {
  return {
    sessionMaxAgeDays: readMaxAgeDays("retention.sessionMaxAgeDays"),
    trajectoryMaxAgeDays: readMaxAgeDays("retention.trajectoryMaxAgeDays"),
    archiveBeforeDelete: (getConfig("retention.archiveBeforeDelete") ?? "true") === "true",
  };
}

export function updateRetentionConfig(updates: UpdateRetentionRequest): RetentionConfig {
  if (updates.sessionMaxAgeDays !== undefined) {
    const days = normalizeMaxAgeDays(updates.sessionMaxAgeDays, "sessionMaxAgeDays");
    setConfig("retention.sessionMaxAgeDays", String(days));
  }
  if (updates.trajectoryMaxAgeDays !== undefined) {
    const days = normalizeMaxAgeDays(updates.trajectoryMaxAgeDays, "trajectoryMaxAgeDays");
    setConfig("retention.trajectoryMaxAgeDays", String(days));
  }
  if (updates.archiveBeforeDelete !== undefined) {
    if (typeof updates.archiveBeforeDelete !== "boolean") {
      throw new TypeError("archiveBeforeDelete must be a boolean");
    }
    setConfig("retention.archiveBeforeDelete", String(updates.archiveBeforeDelete));
  }
  return getRetentionConfig();
}
