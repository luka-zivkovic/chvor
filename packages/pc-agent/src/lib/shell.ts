import { exec } from "node:child_process";
import { platform } from "node:os";

const MAX_OUTPUT = 32_000; // chars

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function executeShellCommand(
  command: string,
  cwd?: string
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const shell = platform() === "win32" ? "powershell.exe" : "/bin/bash";
    const child = exec(command, {
      cwd: cwd ?? undefined,
      shell,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}
