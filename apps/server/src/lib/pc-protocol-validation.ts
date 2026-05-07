import type { PcActionResult } from "@chvor/shared";

export const MAX_REMOTE_SHELL_OUTPUT_CHARS = 200_000;
const MAX_REMOTE_ACTION_ERROR_CHARS = 1_000;

export interface RemoteShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function invalidShellResult(): RemoteShellResult {
  return {
    stdout: "",
    stderr: "Invalid shell response from agent",
    exitCode: 1,
  };
}

/** Validate and sanitize a remote pc-agent action result. Fails closed on malformed data. */
export function parseRemoteActionResult(value: unknown): PcActionResult {
  if (typeof value !== "object" || value === null) {
    return { success: false, error: "Invalid action response from agent" };
  }

  const item = value as Record<string, unknown>;
  if (typeof item.success !== "boolean") {
    return { success: false, error: "Invalid action response from agent" };
  }

  return {
    success: item.success,
    ...(typeof item.error === "string"
      ? { error: item.error.slice(0, MAX_REMOTE_ACTION_ERROR_CHARS) }
      : {}),
  };
}

/**
 * Validate a remote pc-agent shell result. Fails closed on malformed or oversized output
 * rather than passing untrusted remote data through to logs/LLM/user surfaces.
 */
export function parseRemoteShellResult(value: unknown): RemoteShellResult {
  if (typeof value !== "object" || value === null) return invalidShellResult();

  const item = value as Record<string, unknown>;
  const stdout = item.stdout;
  const stderr = item.stderr;
  const exitCode = item.exitCode;
  if (
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    typeof exitCode !== "number" ||
    !Number.isSafeInteger(exitCode)
  ) {
    return invalidShellResult();
  }

  if (
    stdout.length > MAX_REMOTE_SHELL_OUTPUT_CHARS ||
    stderr.length > MAX_REMOTE_SHELL_OUTPUT_CHARS
  ) {
    return invalidShellResult();
  }

  return {
    stdout,
    stderr,
    exitCode,
  };
}
