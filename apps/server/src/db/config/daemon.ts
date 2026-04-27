import type { DaemonConfig, UpdateDaemonConfigRequest } from "@chvor/shared";
import { getConfig, setConfig } from "./base.ts";

// ── Daemon (Always-On) config ──────────────────────────────────

const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  enabled: false,
  autoRemediate: false,
  idleActions: false,
  taskQueue: false,
  wakeOnWebhook: false,
};

export function getDaemonConfig(): DaemonConfig {
  const raw = getConfig("daemon.config");
  if (!raw) return { ...DEFAULT_DAEMON_CONFIG };
  try {
    return { ...DEFAULT_DAEMON_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_DAEMON_CONFIG };
  }
}

export function updateDaemonConfig(updates: UpdateDaemonConfigRequest): DaemonConfig {
  const current = getDaemonConfig();
  if (updates.enabled !== undefined) current.enabled = updates.enabled;
  if (updates.autoRemediate !== undefined) current.autoRemediate = updates.autoRemediate;
  if (updates.idleActions !== undefined) current.idleActions = updates.idleActions;
  if (updates.taskQueue !== undefined) current.taskQueue = updates.taskQueue;
  if (updates.wakeOnWebhook !== undefined) current.wakeOnWebhook = updates.wakeOnWebhook;
  setConfig("daemon.config", JSON.stringify(current));
  return current;
}
