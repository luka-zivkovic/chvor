import type {
  ShellConfig,
  ShellApprovalMode,
  UpdateShellConfigRequest,
} from "@chvor/shared";
import { getConfig, setConfig } from "./base.ts";

// --- Shell config ---

const VALID_APPROVAL_MODES: ShellApprovalMode[] = ["always_approve", "moderate_plus", "dangerous_only", "block_all"];

export function getShellConfig(): ShellConfig {
  const mode = getConfig("shell.approvalMode") as ShellApprovalMode | null;
  return {
    approvalMode: mode && VALID_APPROVAL_MODES.includes(mode) ? mode : "moderate_plus",
  };
}

export function updateShellConfig(updates: UpdateShellConfigRequest): ShellConfig {
  if (updates.approvalMode !== undefined && VALID_APPROVAL_MODES.includes(updates.approvalMode)) {
    setConfig("shell.approvalMode", updates.approvalMode);
  }
  return getShellConfig();
}
