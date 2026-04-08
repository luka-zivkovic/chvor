// ─── Sandbox (Docker) Types ────────────────────────────────

export type SandboxLanguage = "python" | "node" | "bash";

export interface SandboxConfig {
  enabled: boolean;
  memoryLimitMb: number;
  cpuQuota: number;
  timeoutMs: number;
  networkDisabled: boolean;
}

export interface UpdateSandboxConfigRequest {
  enabled?: boolean;
  memoryLimitMb?: number;
  cpuQuota?: number;
  timeoutMs?: number;
  networkDisabled?: boolean;
}

export interface SandboxStatus {
  dockerAvailable: boolean;
  dockerVersion?: string;
  imagesAvailable: SandboxLanguage[];
  imagesMissing: SandboxLanguage[];
}

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  oomKilled: boolean;
}
