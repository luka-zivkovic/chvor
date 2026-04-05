export interface TelemetryConfig {
  enabled: boolean; // default: false (opt-in model)
  distinctId: string; // random UUID, generated once per instance
}

export interface UpdateTelemetryRequest {
  enabled?: boolean;
}
