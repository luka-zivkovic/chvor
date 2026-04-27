import { tool } from "ai";
import { z } from "zod";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { buildSafeEnv } from "./shell.ts";
import type { NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Claude Code tool
// ---------------------------------------------------------------------------
const CLAUDE_CODE_NAME = "native__claude_code";
const CLAUDE_CODE_DEFAULT_TIMEOUT = 300_000; // 5 minutes
const CLAUDE_CODE_MAX_TIMEOUT = 600_000; // 10 minutes
const CLAUDE_CODE_URL_CAPTURE_TIMEOUT = 30_000; // 30s to capture auth URL
const MAX_OUTPUT = 50_000;

const claudeCodeToolDef = tool({
  description:
    "[Claude Code] Delegate complex coding tasks to the Claude Code CLI agent. " +
    "Use for multi-file edits, debugging, refactoring, test writing, and codebase exploration. " +
    "Set action to 'login' to initiate authentication when needed.",
  parameters: z.object({
    action: z
      .enum(["execute", "login"])
      .optional()
      .describe("Action to perform: 'execute' (default) runs a coding task, 'login' initiates Claude Code authentication and returns an auth URL"),
    prompt: z
      .string()
      .optional()
      .describe("The coding task to delegate to Claude Code (required for action='execute')"),
    workingDir: z
      .string()
      .optional()
      .describe("Project root directory for Claude Code to work in (defaults to user home)"),
    maxTurns: z
      .number()
      .optional()
      .describe("Max agentic turns (default: 10, max: 50)"),
  }),
});

// Background login process — kept alive so OAuth callback can reach it
let claudeLoginProcess: ReturnType<typeof spawn> | null = null;
let claudeLoginKillTimer: ReturnType<typeof setTimeout> | null = null;

function findClaudeBinary(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, ["claude"], { timeout: 5000, encoding: "utf-8" });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim().split(/\r?\n/)[0] || null;
    }
    return null;
  } catch {
    return null;
  }
}

function cleanupLoginProcess(): void {
  if (claudeLoginKillTimer) {
    clearTimeout(claudeLoginKillTimer);
    claudeLoginKillTimer = null;
  }
  if (claudeLoginProcess && !claudeLoginProcess.killed) {
    try { claudeLoginProcess.kill(); } catch { /* already dead */ }
  }
  claudeLoginProcess = null;
}

async function handleClaudeCodeLogin(): Promise<NativeToolResult> {
  // Clean up any previous login process
  cleanupLoginProcess();

  const binary = findClaudeBinary();
  if (!binary) {
    return {
      content: [{ type: "text", text: "Claude Code CLI not found. Ensure `claude` is installed and on PATH (npm install -g @anthropic-ai/claude-code)." }],
    };
  }

  return new Promise((resolve) => {
    let output = "";
    let resolved = false;

    const proc = spawn(binary, ["login"], {
      env: buildSafeEnv(),
      windowsHide: true,
    });

    claudeLoginProcess = proc;

    // Auto-kill after 5 minutes if OAuth never completes
    claudeLoginKillTimer = setTimeout(() => {
      cleanupLoginProcess();
    }, CLAUDE_CODE_DEFAULT_TIMEOUT);

    const onData = (data: Buffer) => {
      output += data.toString();
      // Look for a URL in the output
      const urlMatch = output.match(/https?:\/\/[^\s"'<>]+/);
      if (urlMatch && !resolved) {
        resolved = true;
        resolve({
          content: [{
            type: "text",
            text: `Claude Code login initiated. Open this URL to authenticate:\n\n${urlMatch[0]}\n\nUse the web agent to navigate to this URL and log in with the Anthropic account credentials. After login completes, retry your original task.`,
          }],
        });
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    // Timeout: if no URL found within 30s
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanupLoginProcess();
        resolve({
          content: [{
            type: "text",
            text: `Claude Code login started but no auth URL was captured within ${CLAUDE_CODE_URL_CAPTURE_TIMEOUT / 1000}s.\nOutput so far:\n${output.slice(0, 2000) || "(no output)"}`,
          }],
        });
      }
    }, CLAUDE_CODE_URL_CAPTURE_TIMEOUT);

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        cleanupLoginProcess();
        resolve({
          content: [{ type: "text", text: `Failed to start Claude Code login: ${err.message}` }],
        });
      }
    });

    // If process exits before URL captured (e.g., already logged in)
    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        cleanupLoginProcess();
        resolve({
          content: [{
            type: "text",
            text: code === 0
              ? `Claude Code login completed (already authenticated).\n${output.slice(0, 2000)}`
              : `Claude Code login exited with code ${code}.\n${output.slice(0, 2000) || "(no output)"}`,
          }],
        });
      }
    });
  });
}

async function handleClaudeCodeExecute(
  args: Record<string, unknown>,
): Promise<NativeToolResult> {
  const prompt = args.prompt ? String(args.prompt) : "";
  if (!prompt) {
    return { content: [{ type: "text", text: "Error: 'prompt' is required when action is 'execute'." }] };
  }

  const workingDir = args.workingDir ? String(args.workingDir) : homedir();
  const maxTurns = Math.min(Math.max(Number(args.maxTurns) || 10, 1), 50);

  // Validate working directory
  try {
    const s = statSync(workingDir);
    if (!s.isDirectory()) {
      return { content: [{ type: "text", text: `Working directory is not a directory: ${workingDir}` }] };
    }
  } catch {
    return { content: [{ type: "text", text: `Working directory does not exist: ${workingDir}` }] };
  }

  const binary = findClaudeBinary();
  if (!binary) {
    return {
      content: [{ type: "text", text: "Claude Code CLI not found. Ensure `claude` is installed and on PATH (npm install -g @anthropic-ai/claude-code)." }],
    };
  }

  const cliArgs = [
    "-p",
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    prompt,
  ];

  const start = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(binary, cliArgs, {
      cwd: workingDir,
      env: buildSafeEnv(),
      windowsHide: true,
    });

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      if (!proc.killed) {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }, CLAUDE_CODE_MAX_TIMEOUT);

    let stdoutDone = false;
    let stderrDone = false;

    proc.stdout?.on("data", (data: Buffer) => {
      if (stdoutDone) return;
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT * 2) {
        stdout = stdout.slice(0, MAX_OUTPUT * 2) + "\n[...truncated]";
        stdoutDone = true;
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      if (stderrDone) return;
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT) + "\n[...truncated]";
        stderrDone = true;
      }
    });

    proc.on("error", (err) => {
      clearTimeout(killTimer);
      if (!proc.killed) {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }
      resolve({
        content: [{ type: "text", text: `Claude Code execution error: ${err.message}` }],
      });
    });

    proc.on("close", (code) => {
      clearTimeout(killTimer);
      const durationMs = Date.now() - start;

      if (timedOut) {
        const parts: string[] = [`Claude Code timed out after ${CLAUDE_CODE_MAX_TIMEOUT / 1000}s.`];
        if (stdout) parts.push(stdout.slice(0, MAX_OUTPUT));
        if (stderr) parts.push(`[stderr]\n${stderr.slice(0, 5000)}`);
        resolve({ content: [{ type: "text", text: parts.join("\n") }] });
        return;
      }

      // Detect auth errors
      const combined = (stdout + stderr).toLowerCase();
      if (code !== 0 && (combined.includes("not authenticated") || combined.includes("unauthorized") || combined.includes("login required") || combined.includes("please login"))) {
        resolve({
          content: [{
            type: "text",
            text: `Claude Code authentication required. Use native__claude_code with action: "login" to authenticate, then retry.\n\n[stderr] ${stderr.slice(0, 1000)}`,
          }],
        });
        return;
      }

      // Try to parse JSON output
      try {
        const parsed = JSON.parse(stdout);
        const result = parsed.result || parsed.message || stdout;
        const meta: string[] = [];
        if (parsed.cost_usd !== undefined) meta.push(`cost: $${parsed.cost_usd.toFixed(4)}`);
        if (parsed.num_turns !== undefined) meta.push(`turns: ${parsed.num_turns}`);
        meta.push(`duration: ${(durationMs / 1000).toFixed(1)}s`);
        if (code !== 0) meta.push(`exit code: ${code}`);

        resolve({
          content: [{
            type: "text",
            text: `${result}\n\n[${meta.join(", ")}]`,
          }],
        });
      } catch {
        // Fallback to raw output
        const parts: string[] = [];
        if (stdout) parts.push(stdout.slice(0, MAX_OUTPUT));
        if (stderr) parts.push(`[stderr]\n${stderr.slice(0, 5000)}`);
        if (parts.length === 0) parts.push("(no output)");
        parts.push(`\n[exit code: ${code ?? 1}, ${(durationMs / 1000).toFixed(1)}s]`);

        resolve({
          content: [{ type: "text", text: parts.join("\n") }],
        });
      }
    });
  });
}

const handleClaudeCode: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  const action = String(args.action || "execute");

  if (action === "login") {
    return handleClaudeCodeLogin();
  }

  return handleClaudeCodeExecute(args);
};

export const claudeCodeModule: NativeToolModule = {
  group: "model",
  defs: { [CLAUDE_CODE_NAME]: claudeCodeToolDef },
  handlers: { [CLAUDE_CODE_NAME]: handleClaudeCode },
  mappings: { [CLAUDE_CODE_NAME]: { kind: "tool", id: "claude-code" } },
};
