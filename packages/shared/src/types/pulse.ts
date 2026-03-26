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
