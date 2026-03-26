export interface DeliveryTarget {
  channelType: "telegram" | "discord" | "slack";
  channelId: string;
  label?: string;
}

export interface Schedule {
  id: string;
  name: string;
  cronExpression: string;
  prompt: string;
  workspaceId: string;
  enabled: boolean;
  oneShot: boolean;
  deliverTo: DeliveryTarget[] | null;
  workflowId: string | null;
  workflowParams: Record<string, string> | null;
  lastRunAt: string | null;
  lastResult: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduleRequest {
  name: string;
  cronExpression: string;
  prompt: string;
  workspaceId: string;
  oneShot?: boolean;
  /** Defaults to true. Set to false to create in disabled state (e.g. template-provisioned schedules). */
  enabled?: boolean;
  deliverTo?: DeliveryTarget[] | null;
  workflowId?: string;
  workflowParams?: Record<string, string>;
}

export interface UpdateScheduleRequest {
  name?: string;
  cronExpression?: string;
  prompt?: string;
  workspaceId?: string;
  enabled?: boolean;
  deliverTo?: DeliveryTarget[] | null;
  workflowId?: string | null;
  workflowParams?: Record<string, string> | null;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  startedAt: string;
  completedAt: string | null;
  status: "completed" | "failed";
  result: string | null;
  error: string | null;
}
