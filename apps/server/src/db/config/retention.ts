import type { RetentionConfig, UpdateRetentionRequest } from "@chvor/shared";
import { getConfig, setConfig } from "./base.ts";

// --- Retention config ---

export function getRetentionConfig(): RetentionConfig {
  return {
    sessionMaxAgeDays: parseInt(getConfig("retention.sessionMaxAgeDays") ?? "30", 10),
    archiveBeforeDelete: (getConfig("retention.archiveBeforeDelete") ?? "true") === "true",
  };
}

export function updateRetentionConfig(updates: UpdateRetentionRequest): RetentionConfig {
  if (updates.sessionMaxAgeDays !== undefined) {
    const days = Math.max(0, Math.floor(updates.sessionMaxAgeDays));
    setConfig("retention.sessionMaxAgeDays", String(days));
  }
  if (updates.archiveBeforeDelete !== undefined) {
    setConfig("retention.archiveBeforeDelete", String(updates.archiveBeforeDelete));
  }
  return getRetentionConfig();
}
