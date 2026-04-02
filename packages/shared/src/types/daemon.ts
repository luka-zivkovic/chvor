// ─── Daemon (Always-On) Types ──────────────────────────────

export type DaemonTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type DaemonTaskSource = "user" | "pulse" | "webhook" | "idle" | "system";

export interface DaemonTask {
  id: string;
  title: string;
  prompt: string;
  source: DaemonTaskSource;
  priority: number; // 0=low, 1=normal, 2=high, 3=critical
  status: DaemonTaskStatus;
  progress: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DaemonConfig {
  enabled: boolean;
  autoRemediate: boolean;
  idleActions: boolean;
  taskQueue: boolean;
  wakeOnWebhook: boolean;
  maxConcurrentTasks: number;
}

export interface DaemonPresence {
  state: "idle" | "working" | "remediating" | "consolidating" | "sleeping";
  currentTask: { id: string; title: string } | null;
  queueDepth: number;
  lastActivity: string | null;
}

export interface CreateDaemonTaskRequest {
  title: string;
  prompt: string;
  priority?: number;
}

export interface UpdateDaemonConfigRequest {
  enabled?: boolean;
  autoRemediate?: boolean;
  idleActions?: boolean;
  taskQueue?: boolean;
  wakeOnWebhook?: boolean;
  maxConcurrentTasks?: number;
}
