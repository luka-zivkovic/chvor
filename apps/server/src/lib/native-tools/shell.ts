import { tool } from "ai";
import { z } from "zod";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ApprovalRecord, GatewayServerEvent, SecurityRisk } from "@chvor/shared";
import { classifyCommand } from "../command-classifier.ts";
import type { ClassificationResult } from "../command-classifier.ts";
import { logShellExecution } from "../shell-audit.ts";
import {
  createAbortError,
  throwIfAborted,
  withAbortSideEffectFence,
} from "../orchestrator/abort.ts";
import {
  recordTrajectoryApprovalRequested,
  recordTrajectoryApprovalResolved,
} from "../orchestrator/trajectory-adapter.ts";
import {
  getShellConfig as getShellApprovalConfig,
  isTrustedCommand,
  addTrustedCommand,
} from "../../db/config-store.ts";
import type {
  NativeToolContext,
  NativeToolHandler,
  NativeToolModule,
  NativeToolResult,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Shell Execute tool
// ---------------------------------------------------------------------------

const SHELL_EXECUTE_NAME = "native__shell_execute";
const MAX_OUTPUT = 50_000;
const APPROVAL_TIMEOUT_MS = 120_000; // 2 minutes

const shellExecuteToolDef = tool({
  description:
    "[System Control] Execute a shell command on the host machine. " +
    "Commands are auto-classified by risk: SAFE (ls, cat, pwd, grep, find, ps, df) auto-execute; " +
    "MODERATE (mkdir, cp, mv, npm, git, curl, docker) and DANGEROUS (rm, kill, sudo, shutdown) require user approval; " +
    "BLOCKED patterns (fork bombs, raw disk writes) are rejected outright. " +
    "Prefer SAFE commands — they execute instantly without interrupting the user. " +
    "Chain multiple safe commands rather than risky all-in-one patterns. " +
    "Always specify workingDir when the command is path-sensitive. " +
    "On Windows use PowerShell syntax (Get-ChildItem, Remove-Item); on macOS/Linux use bash/zsh. " +
    "When a command needs approval, briefly explain WHY it's necessary before the user sees the prompt. " +
    "If a command is denied, suggest a safer alternative.",
  parameters: z.object({
    command: z.string().describe("The shell command to execute"),
    workingDir: z.string().optional().describe("Working directory (defaults to user home)"),
    timeoutMs: z.number().optional().describe("Timeout in ms (default: 30000, max: 300000)"),
  }),
});

// --- Approval system ---

const MAX_PENDING_APPROVALS = 50;

function approvalRisk(classification: ClassificationResult): SecurityRisk {
  if (classification.tier === "safe") return "low";
  if (classification.tier === "moderate") return "medium";
  return "high";
}

function transientApprovalRecord(
  requestId: string,
  command: string,
  workingDir: string,
  classification: ClassificationResult,
  context?: NativeToolContext
): ApprovalRecord {
  const createdAt = Date.now();
  const pcTask = /^PC Task:/i.test(command);
  const pcShell = /^PC shell:/i.test(command);
  const isPc = pcTask || pcShell;
  return {
    id: requestId,
    sessionId: context?.sessionId ?? null,
    actionId: null,
    toolName: pcTask ? "native__pc_do" : pcShell ? "native__pc_shell" : SHELL_EXECUTE_NAME,
    kind: isPc ? "pc_control" : "shell",
    args: { command, workingDir, classifiedCommands: classification.subCommands },
    risk: approvalRisk(classification),
    reasons: [`${classification.tier} command requires user approval`],
    checkpointId: null,
    status: "pending",
    decision: null,
    decidedAt: null,
    decidedBy: null,
    createdAt,
    expiresAt: createdAt + APPROVAL_TIMEOUT_MS,
  };
}

function captureApprovalRequested(record: ApprovalRecord, toolCallId?: string): void {
  try {
    recordTrajectoryApprovalRequested(record, toolCallId);
  } catch (error) {
    console.warn("[shell] failed to capture pending approval:", error);
  }
}

function captureApprovalResolved(
  record: ApprovalRecord,
  outcome: "allowed" | "denied" | "expired",
  decidedBy: "user" | "system" | "auto-expire",
  toolCallId?: string
): void {
  try {
    recordTrajectoryApprovalResolved({
      ...record,
      status: outcome,
      decision: outcome === "allowed" ? "allow-once" : outcome === "denied" ? "deny" : null,
      decidedAt: Date.now(),
      decidedBy,
    }, toolCallId);
  } catch (error) {
    console.warn("[shell] failed to capture approval resolution:", error);
  }
}

const pendingApprovals = new Map<
  string,
  {
    resolve: (approved: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
    command: string;
    allowAlwaysAllow: boolean;
  }
>();

export async function requestApproval(
  command: string,
  workingDir: string,
  classification: ClassificationResult,
  context?: NativeToolContext,
  opts?: { allowTrusted?: boolean; allowAlwaysAllow?: boolean }
): Promise<{ approved: boolean; requestId: string }> {
  const abortSignal = context?.abortSignal;
  throwIfAborted(abortSignal);

  // Check trusted commands — auto-approve if matched
  const isPc = /^PC (Task|shell):/i.test(command);
  if (opts?.allowTrusted !== false && isTrustedCommand(command, isPc)) {
    throwIfAborted(abortSignal);
    return { approved: true, requestId: "trusted-auto" };
  }

  // Prevent unbounded growth of pending approvals
  if (pendingApprovals.size >= MAX_PENDING_APPROVALS) {
    return { approved: false, requestId: "limit-exceeded" };
  }

  const requestId = randomUUID();
  const trajectoryApproval = transientApprovalRecord(
    requestId,
    command,
    workingDir,
    classification,
    context
  );

  // Send confirmation request via WS
  const { getWSInstance } = await import("../../gateway/ws-instance.ts");
  throwIfAborted(abortSignal);
  const ws = getWSInstance();

  const confirmEvent: GatewayServerEvent = {
    type: "command.confirm",
    data: {
      requestId,
      command,
      workingDir,
      tier: classification.tier,
      classifiedCommands: classification.subCommands,
      timestamp: new Date().toISOString(),
      allowAlwaysAllow: opts?.allowAlwaysAllow !== false,
    },
  };

  // Install the waiter before notifying clients so an immediate response
  // cannot beat registration. Cancellation resolves to a marker rather than
  // rejecting while notification imports/sends may still be in flight.
  let timedOut = false;
  const approvalPromise = new Promise<boolean | "aborted">((resolve) => {
    let settled = false;
    const finish = (approved: boolean | "aborted"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingApprovals.delete(requestId);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve(approved);
    };
    const onAbort = (): void => finish("aborted");
    const timer = setTimeout(() => {
      timedOut = true;
      finish(false);
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(requestId, {
      resolve: (approved) => finish(approved),
      timer,
      command,
      allowAlwaysAllow: opts?.allowAlwaysAllow !== false,
    });

    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
  captureApprovalRequested(trajectoryApproval, context?.toolCallId);

  try {
    // Route to originating client if web, or broadcast
    throwIfAborted(abortSignal);
    if (context?.originClientId) {
      ws?.sendTo(context.originClientId, confirmEvent);
    } else {
      ws?.broadcast(confirmEvent);
    }

    // For non-web channels, send approval prompt (with inline buttons if supported)
    if (context?.channelType && context.channelType !== "web" && context.channelId) {
      const { getGatewayInstance } = await import("../../gateway/gateway-instance.ts");
      throwIfAborted(abortSignal);
      const gw = getGatewayInstance();
      if (gw) {
        const channel = gw.getChannel(context.channelType);
        if (channel?.sendApproval) {
          throwIfAborted(abortSignal);
          await channel.sendApproval(context.channelId, requestId, command, classification.tier);
          throwIfAborted(abortSignal);
        } else {
          // Fallback for channels without inline approval buttons
          const tierEmoji = classification.tier === "dangerous" ? "\u{1f534}" : "\u{1f7e1}";
          throwIfAborted(abortSignal);
          await gw.sendToChannel(
            context.channelType,
            context.channelId,
            `${tierEmoji} **Command requires approval:**\n\`\`\`\n${command}\n\`\`\`\nRisk: ${classification.tier.toUpperCase()}\n\nApprove or deny this command in the web dashboard.`
          );
          throwIfAborted(abortSignal);
        }
      }
    }
  } catch (error) {
    pendingApprovals.get(requestId)?.resolve(false);
    await approvalPromise;
    if (abortSignal?.aborted) {
      captureApprovalResolved(trajectoryApproval, "expired", "system", context?.toolCallId);
      throw createAbortError();
    }
    captureApprovalResolved(trajectoryApproval, "expired", "system", context?.toolCallId);
    throw error;
  }

  const approved = await approvalPromise;
  if (approved === "aborted" || abortSignal?.aborted) {
    captureApprovalResolved(trajectoryApproval, "expired", "system", context?.toolCallId);
    throw createAbortError();
  }
  captureApprovalResolved(
    trajectoryApproval,
    approved ? "allowed" : timedOut ? "expired" : "denied",
    timedOut ? "auto-expire" : "user",
    context?.toolCallId
  );

  return { approved, requestId };
}

/** Called when user responds to a command.confirm event. */
export function resolveApproval(
  requestId: string,
  approved: boolean,
  alwaysAllow?: boolean
): boolean {
  const pending = pendingApprovals.get(requestId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingApprovals.delete(requestId);

  // If approved with alwaysAllow, store the trusted pattern
  if (approved && alwaysAllow && pending.allowAlwaysAllow && pending.command) {
    const isPc = /^PC (Task|shell):/i.test(pending.command);
    if (isPc) {
      const cleaned = pending.command.replace(/^PC (Task|shell):\s*/i, "");
      const parts = cleaned.trim().split(/\s+/);
      // Store up to 3 tokens for more precise matching (matching shell pattern)
      const pattern = parts.slice(0, Math.min(parts.length, 3)).join(" ").toLowerCase();
      if (pattern) addTrustedCommand("pc", pattern);
    } else {
      // Store 3 tokens (binary + subcommand + first arg) for more precise matching
      // e.g. "npm install express" not just "npm install" which would approve any package
      const parts = pending.command.trim().split(/\s+/);
      const pattern = parts.slice(0, Math.min(parts.length, 3)).join(" ").toLowerCase();
      if (pattern) addTrustedCommand("shell", pattern);
    }
  }

  pending.resolve(approved);
  return true;
}

// --- Shell execution (cross-platform) ---

function getShellConfig(): { shell: string; shellFlag: string } {
  if (process.platform === "win32") {
    return { shell: "powershell.exe", shellFlag: "-Command" };
  }
  const shellEnv = process.env.SHELL || "/bin/bash";
  return { shell: shellEnv, shellFlag: "-c" };
}

// Whitelist safe env vars — never leak API keys, tokens, or secrets to child processes
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "USER",
  "USERNAME",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "COMSPEC",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "NODE_ENV",
  "EDITOR",
  "VISUAL",
  "PAGER",
];

export function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

function executeCommand(
  command: string,
  workingDir: string,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  throwIfAborted(abortSignal);
  const { shell, shellFlag } = getShellConfig();
  const start = Date.now();

  return new Promise((resolve, reject) => {
    throwIfAborted(abortSignal);
    const proc = spawn(shell, [shellFlag, command], {
      cwd: workingDir,
      env: buildSafeEnv(),
      timeout: timeoutMs,
      windowsHide: true,
      detached: process.platform !== "win32",
      signal: abortSignal,
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;
    let processError: Error | null = null;
    const killProcessTree = (): void => {
      aborted = true;
      if (proc.pid && process.platform !== "win32") {
        try {
          process.kill(-proc.pid, "SIGKILL");
          return;
        } catch {
          // Fall back to killing the direct child below.
        }
      }
      if (!proc.killed) {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }
    };
    abortSignal?.addEventListener("abort", killProcessTree, { once: true });

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT) + "\n[...truncated]";
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT) + "\n[...truncated]";
      }
    });

    // Force-kill if process ignores SIGTERM after timeout
    proc.on("close", (code, signal) => {
      abortSignal?.removeEventListener("abort", killProcessTree);
      if (aborted || abortSignal?.aborted) {
        reject(createAbortError());
        return;
      }
      resolve({
        stdout: stdout.trimEnd(),
        stderr:
          signal === "SIGKILL"
            ? (stderr.trimEnd() + "\n[process killed after timeout]").trimStart()
            : processError
              ? processError.message
              : stderr.trimEnd(),
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      if (err.name === "AbortError" || abortSignal?.aborted) {
        killProcessTree();
        return;
      }
      // Node fires 'error' with code ETIMEDOUT when spawn timeout triggers —
      // escalate to SIGKILL in case the process ignored SIGTERM
      if (!proc.killed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
      processError = err;
    });
  });
}

function formatShellOutput(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
  if (parts.length === 0) parts.push("(no output)");
  parts.push(`\n[exit code: ${result.exitCode}, ${result.durationMs}ms]`);
  return parts.join("\n");
}

const handleShellExecute: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  throwIfAborted(context?.abortSignal);
  const command = String(args.command);
  const workingDir = args.workingDir ? String(args.workingDir) : homedir();
  const timeoutMs = Math.min(Number(args.timeoutMs) || 30_000, 300_000);

  // Validate working directory
  try {
    const s = statSync(workingDir);
    if (!s.isDirectory()) {
      return {
        content: [{ type: "text", text: `Working directory is not a directory: ${workingDir}` }],
      };
    }
  } catch {
    return {
      content: [{ type: "text", text: `Working directory does not exist: ${workingDir}` }],
    };
  }

  // 1. Classify (includes blocked pattern detection)
  const classification = classifyCommand(command);

  // 2. Blocked — reject immediately
  if (classification.tier === "blocked") {
    logShellExecution({
      command,
      workingDir,
      tier: "blocked",
      approved: false,
      deniedReason: "blocked pattern",
      durationMs: 0,
      sessionId: context?.sessionId,
    });
    return {
      content: [
        {
          type: "text",
          text: "Command blocked: this command pattern is never allowed for safety reasons.",
        },
      ],
    };
  }

  // 3. Approval gate (respects configured approval mode)
  const approvalMode = getShellApprovalConfig().approvalMode;

  if (approvalMode === "block_all" && classification.tier !== "safe") {
    logShellExecution({
      command,
      workingDir,
      tier: classification.tier,
      approved: false,
      deniedReason: "block_all mode",
      durationMs: 0,
      sessionId: context?.sessionId,
    });
    return {
      content: [
        {
          type: "text",
          text: `Command blocked: shell approval mode is set to "block all non-safe commands".`,
        },
      ],
    };
  }

  const needsApproval =
    classification.tier !== "safe" &&
    approvalMode !== "always_approve" &&
    (approvalMode === "moderate_plus" ||
      (approvalMode === "dangerous_only" && classification.tier === "dangerous"));

  if (needsApproval) {
    const { approved } = await requestApproval(command, workingDir, classification, context);
    throwIfAborted(context?.abortSignal);

    if (!approved) {
      logShellExecution({
        command,
        workingDir,
        tier: classification.tier,
        approved: false,
        deniedReason: "user denied or timeout",
        durationMs: 0,
        sessionId: context?.sessionId,
      });
      return {
        content: [{ type: "text", text: `Command denied by user: \`${command}\`` }],
      };
    }
  }

  // 4. Execute
  throwIfAborted(context?.abortSignal);
  const result = await withAbortSideEffectFence(
    executeCommand(command, workingDir, timeoutMs, context?.abortSignal),
    context?.abortSignal
  );

  // 5. Audit
  logShellExecution({
    command,
    workingDir,
    tier: classification.tier,
    approved: true,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 10_000), // store truncated in audit
    stderr: result.stderr.slice(0, 10_000),
    durationMs: result.durationMs,
    sessionId: context?.sessionId,
  });

  // 6. Return
  return {
    content: [{ type: "text", text: formatShellOutput(result) }],
  };
};

export const shellModule: NativeToolModule = {
  group: "shell",
  defs: { [SHELL_EXECUTE_NAME]: shellExecuteToolDef },
  handlers: { [SHELL_EXECUTE_NAME]: handleShellExecute },
};
