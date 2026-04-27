import type {
  SandboxConfig,
  UpdateSandboxConfigRequest,
  FilesystemConfig,
  UpdateFilesystemConfigRequest,
  TrustedCommandsConfig,
} from "@chvor/shared";
import os from "node:os";
import { getConfig, setConfig } from "./base.ts";

// ── Security: Localhost access ──────────────────────────────────────

/** Whether the AI is allowed to fetch localhost / private network URLs. Default: false (blocked). */
export function getAllowLocalhost(): boolean {
  return (getConfig("security.allowLocalhost") ?? "false") === "true";
}

export function setAllowLocalhost(allow: boolean): boolean {
  setConfig("security.allowLocalhost", String(allow));
  return allow;
}

// ── Filesystem access config ──────────────────────────────────────

export function getFilesystemConfig(): FilesystemConfig {
  const parseEnabled = getConfig("filesystem.enabled");
  const parseReadOnly = getConfig("filesystem.readOnly");
  const rawPaths = getConfig("filesystem.allowedPaths");

  let allowedPaths: string[];
  if (!rawPaths) {
    allowedPaths = [os.homedir()];
  } else {
    try {
      const arr = JSON.parse(rawPaths);
      allowedPaths = Array.isArray(arr) ? arr : [os.homedir()];
    } catch {
      allowedPaths = [os.homedir()];
    }
  }

  return {
    enabled: (parseEnabled ?? "true") === "true",
    readOnly: (parseReadOnly ?? "false") === "true",
    allowedPaths,
  };
}

export function updateFilesystemConfig(updates: UpdateFilesystemConfigRequest): FilesystemConfig {
  if (updates.enabled !== undefined) setConfig("filesystem.enabled", String(updates.enabled));
  if (updates.readOnly !== undefined) setConfig("filesystem.readOnly", String(updates.readOnly));
  if (updates.allowedPaths !== undefined) setConfig("filesystem.allowedPaths", JSON.stringify(updates.allowedPaths));
  return getFilesystemConfig();
}

// ── Trusted commands (Always Allow) ──────────────────────────────

function parseTrustedArray(key: string): string[] {
  const raw = getConfig(key);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function getTrustedCommands(): TrustedCommandsConfig {
  return {
    shell: parseTrustedArray("trusted.shell"),
    pc: parseTrustedArray("trusted.pc"),
  };
}

const MAX_TRUSTED_PATTERNS = 100;

export function addTrustedCommand(kind: "shell" | "pc", pattern: string): TrustedCommandsConfig {
  const current = getTrustedCommands();
  const arr = kind === "shell" ? current.shell : current.pc;
  if (arr.includes(pattern)) return current;
  if (arr.length >= MAX_TRUSTED_PATTERNS) {
    throw new Error(`Too many trusted ${kind} patterns (max ${MAX_TRUSTED_PATTERNS})`);
  }
  arr.push(pattern);
  setConfig(`trusted.${kind}`, JSON.stringify(arr));
  return getTrustedCommands();
}

export function removeTrustedCommand(kind: "shell" | "pc", pattern: string): TrustedCommandsConfig {
  const current = getTrustedCommands();
  const arr = kind === "shell" ? current.shell : current.pc;
  const filtered = arr.filter((p) => p !== pattern);
  setConfig(`trusted.${kind}`, JSON.stringify(filtered));
  return getTrustedCommands();
}

/** Check if a command matches a trusted pattern. */
export function isTrustedCommand(command: string, isPc: boolean): boolean {
  const trusted = getTrustedCommands();
  if (isPc) {
    const cleaned = command.replace(/^PC (Task|shell):\s*/i, "");
    const parts = cleaned.trim().split(/\s+/);
    for (let len = Math.min(parts.length, 3); len >= 1; len--) {
      const candidate = parts.slice(0, len).join(" ").toLowerCase();
      if (trusted.pc.some((p) => p.toLowerCase() === candidate)) return true;
    }
    return false;
  }
  // Shell: match "binary subcommand arg" pattern (up to 3 tokens, case-insensitive)
  // Falls back to shorter matches for backward compat with existing 1-2 token patterns
  const parts = command.trim().split(/\s+/);
  for (let len = Math.min(parts.length, 3); len >= 1; len--) {
    const candidate = parts.slice(0, len).join(" ").toLowerCase();
    if (trusted.shell.includes(candidate)) return true;
  }
  return false;
}

// ── Sandbox (Docker) config ────────────────────────────────────

const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  memoryLimitMb: 256,
  cpuQuota: 50000,
  timeoutMs: 30000,
  networkDisabled: true,
};

export function getSandboxConfig(): SandboxConfig {
  const raw = getConfig("sandbox.config");
  if (!raw) return { ...DEFAULT_SANDBOX_CONFIG };
  try {
    return { ...DEFAULT_SANDBOX_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SANDBOX_CONFIG };
  }
}

export function updateSandboxConfig(updates: UpdateSandboxConfigRequest): SandboxConfig {
  const current = getSandboxConfig();
  if (updates.enabled !== undefined) current.enabled = updates.enabled;
  if (updates.memoryLimitMb !== undefined) current.memoryLimitMb = Math.max(64, Math.min(4096, updates.memoryLimitMb));
  if (updates.cpuQuota !== undefined) current.cpuQuota = Math.max(10000, Math.min(200000, updates.cpuQuota));
  if (updates.timeoutMs !== undefined) current.timeoutMs = Math.max(5000, Math.min(120000, updates.timeoutMs));
  if (updates.networkDisabled !== undefined) current.networkDisabled = updates.networkDisabled;
  setConfig("sandbox.config", JSON.stringify(current));
  return current;
}

export function isSandboxEnabled(): boolean {
  return getSandboxConfig().enabled;
}
