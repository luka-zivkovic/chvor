export type CommandTier = "safe" | "moderate" | "dangerous" | "blocked";

export interface CommandApprovalRequest {
  requestId: string;
  command: string;
  workingDir: string;
  tier: CommandTier;
  classifiedCommands: Array<{ command: string; tier: CommandTier }>;
  timestamp: string;
}

export interface CommandApprovalResponse {
  requestId: string;
  approved: boolean;
}

export type ShellApprovalMode = "always_approve" | "moderate_plus" | "dangerous_only" | "block_all";

export interface ShellConfig {
  approvalMode: ShellApprovalMode;
}

export interface UpdateShellConfigRequest {
  approvalMode?: ShellApprovalMode;
}
