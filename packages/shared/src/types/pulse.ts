export interface PulseConfig {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastResult: string | null;
  lastError: string | null;
}

export interface UpdatePulseRequest {
  enabled?: boolean;
  intervalMinutes?: number;
}

// ─── Pulse Escalation ──────────────────────────────────────

export type PulseEscalationAction = "restart_mcp" | "retry_webhook" | "notify_only";

export interface PulseEscalation {
  severity: "WARNING" | "CRITICAL";
  action: PulseEscalationAction;
  target: string;
  timestamp: string;
}
