import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { logError } from "../error-logger.ts";
import type { ErrorCategory } from "../error-logger.ts";
import type { NativeToolContext, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Sandbox: Docker code execution
// ---------------------------------------------------------------------------

const SANDBOX_EXECUTE_NAME = "native__sandbox_execute";

const sandboxExecuteToolDef = tool({
  description:
    "[Code Sandbox] Execute code safely in an isolated Docker container. " +
    "Supports Python, Node.js, and Bash. Code runs in ephemeral containers with resource limits. " +
    "No network access by default. Use this for running untrusted code, testing scripts, or computation that needs isolation. " +
    "Prefer this over shell_execute for any code execution that doesn't need host access.",
  parameters: z.object({
    language: z.enum(["python", "node", "bash"]).describe("Programming language"),
    code: z.string().describe("The code to execute"),
    timeoutMs: z.number().optional().describe("Override timeout in ms (max 120000)"),
  }),
});

const handleSandboxExecute: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const { isSandboxEnabled, getSandboxConfig } = await import("../../db/config-store.ts");
  const { isDockerAvailable, executeInSandbox } = await import("../sandbox.ts");

  if (!isSandboxEnabled()) {
    return { content: [{ type: "text", text: "Sandbox is disabled. Enable it in Settings → Permissions → Code Sandbox." }] };
  }
  if (!isDockerAvailable()) {
    return { content: [{ type: "text", text: "Docker is not available. Install Docker Desktop (https://docker.com/get-started) and ensure the daemon is running." }] };
  }

  const VALID_SANDBOX_LANGUAGES = ["python", "node", "bash"] as const;
  const rawLang = String(args.language);
  if (!(VALID_SANDBOX_LANGUAGES as readonly string[]).includes(rawLang)) {
    return { content: [{ type: "text", text: `Unsupported sandbox language: "${rawLang}". Supported: python, node, bash.` }] };
  }
  const language = rawLang as import("@chvor/shared").SandboxLanguage;
  const code = String(args.code);
  const config = getSandboxConfig();
  const timeoutMs = Math.min(Number(args.timeoutMs ?? config.timeoutMs), 120000);

  const nodeId = randomUUID();
  context?.emitEvent?.({ type: "sandbox.started", data: { nodeId, language } });

  try {
    const result = await executeInSandbox({
      language,
      code,
      config: { ...config, timeoutMs },
    });

    context?.emitEvent?.({ type: "sandbox.completed", data: { nodeId, exitCode: result.exitCode, durationMs: result.durationMs } });

    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    if (parts.length === 0) parts.push("(no output)");

    const meta: string[] = [`exit: ${result.exitCode}`, `${(result.durationMs / 1000).toFixed(1)}s`];
    if (result.timedOut) meta.push("TIMED OUT");
    if (result.oomKilled) meta.push("OOM KILLED");
    parts.push(`\n[${meta.join(", ")}]`);

    return { content: [{ type: "text", text: parts.join("\n") }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context?.emitEvent?.({ type: "sandbox.failed", data: { nodeId, error: msg } });
    logError("native_tool" as ErrorCategory, err, { tool: SANDBOX_EXECUTE_NAME });
    return { content: [{ type: "text", text: `Sandbox execution failed: ${msg}` }] };
  }
};

export const sandboxModule: NativeToolModule = {
  defs: { [SANDBOX_EXECUTE_NAME]: sandboxExecuteToolDef },
  handlers: { [SANDBOX_EXECUTE_NAME]: handleSandboxExecute },
  mappings: { [SANDBOX_EXECUTE_NAME]: { kind: "tool", id: "sandbox" } },
};
