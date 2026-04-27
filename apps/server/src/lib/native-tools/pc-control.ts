import { tool } from "ai";
import { z } from "zod";
import {
  getPcSafetyLevel,
  hasConnectedAgents,
  localBackendAvailable,
  getBackend,
} from "../pc-control.ts";
import { executePcTask } from "../pc-pipeline.ts";
import type { LlmCallFn } from "../pc-pipeline.ts";
import { getPcControlEnabled } from "../../db/config-store.ts";
import { insertActivity } from "../../db/activity-store.ts";
import { requestApproval } from "./shell.ts";
import type { NativeToolContentItem, NativeToolContext, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// PC Control tools (v2: intent-based with 3-layer pipeline)
// ---------------------------------------------------------------------------

const PC_DO_NAME = "native__pc_do";
const PC_OBSERVE_NAME = "native__pc_observe";
const PC_SHELL_NAME = "native__pc_shell";

const pcDoToolDef = tool({
  description:
    "[PC Control] Execute a task on a PC. Describe WHAT you want to do in natural language — the system automatically chooses the best method (direct action, accessibility tree, or vision). Examples: 'open Firefox', 'click the Submit button', 'type hello@example.com in the email field', 'scroll down', 'alt+tab to switch windows', 'copy the selected text'. Use for all GUI interactions.",
  parameters: z.object({
    task: z.string().describe("Natural language description of what to do on the PC"),
    targetId: z.string().optional().describe("PC target ID. Omit for local PC or if only one PC is connected."),
  }),
});

const pcObserveToolDef = tool({
  description:
    "[PC Control] Observe the current state of a PC. Returns a screenshot and the UI accessibility tree (list of visible elements). Use this to see what's on screen before acting, or to verify the result of a previous action.",
  parameters: z.object({
    targetId: z.string().optional().describe("PC target ID. Omit for local PC or if only one PC is connected."),
  }),
});

const pcShellToolDef = tool({
  description:
    "[PC Control] Execute a shell command on a PC. Returns stdout, stderr, and exit code. Use for file operations, system inspection, or automation that doesn't require the GUI.",
  parameters: z.object({
    targetId: z.string().optional().describe("PC target ID. Omit for local PC or if only one PC is connected."),
    command: z.string().describe("The shell command to execute"),
    cwd: z.string().optional().describe("Working directory for the command"),
  }),
});

// ── PC control loop detection ──────────────────────────────────────
// Track consecutive pc_observe calls per session to detect screenshot loops.
const pcObserveTracker = new Map<string, { count: number; lastResetAt: number }>();
const PC_OBSERVE_LOOP_THRESHOLD = 3;
const PC_OBSERVE_TRACKER_TTL_MS = 5 * 60 * 1000; // 5 min stale window
const PC_OBSERVE_MAX_ENTRIES = 200; // prevent unbounded growth

function getPcObserveTracker(sessionId: string) {
  const now = Date.now();
  // Periodic cleanup: evict stale entries when map grows large
  if (pcObserveTracker.size > PC_OBSERVE_MAX_ENTRIES) {
    for (const [key, val] of pcObserveTracker) {
      if (now - val.lastResetAt > PC_OBSERVE_TRACKER_TTL_MS) pcObserveTracker.delete(key);
    }
  }
  let entry = pcObserveTracker.get(sessionId);
  if (!entry || now - entry.lastResetAt > PC_OBSERVE_TRACKER_TTL_MS) {
    entry = { count: 0, lastResetAt: now };
    pcObserveTracker.set(sessionId, entry);
  }
  return entry;
}

function resetPcObserveCount(sessionId: string) {
  const entry = pcObserveTracker.get(sessionId);
  if (entry) { entry.count = 0; entry.lastResetAt = Date.now(); }
}

const handlePcDo: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  if (!getPcControlEnabled()) {
    return { content: [{ type: "text", text: "PC Control is disabled. Enable it in settings to use this tool." }] };
  }

  const task = args.task as string;
  const targetId = args.targetId as string | undefined;

  // Successful pc_do resets the observe loop counter
  const sessionKey = context?.sessionId ?? "default";
  resetPcObserveCount(sessionKey);

  let backend;
  try {
    backend = getBackend(targetId);
  } catch (err) {
    return { content: [{ type: "text", text: (err as Error).message }] };
  }

  // Safety approval — use the action router to decide if this is a simple,
  // known-safe action. Only action-router matches (Layer 1) are auto-approved
  // in semi-autonomous mode. Everything else requires approval in supervised/semi-auto.
  const safetyLevel = getPcSafetyLevel();

  if (safetyLevel === "supervised") {
    const { approved } = await requestApproval(
      `PC Task: ${task}`,
      backend.hostname,
      { tier: "moderate" as const, subCommands: [] },
      context
    );
    if (!approved) {
      return { content: [{ type: "text", text: "Task denied by user." }] };
    }
  } else if (safetyLevel === "semi-autonomous") {
    // Only auto-approve tasks that match the action router (known keyboard shortcuts, etc.)
    // Everything else (LLM-resolved tasks) requires approval
    const { tryActionRouter } = await import("../action-patterns.ts");
    const isKnownAction = tryActionRouter(task) !== null;
    if (!isKnownAction) {
      const { approved } = await requestApproval(
        `PC Task: ${task}`,
        backend.hostname,
        { tier: "moderate" as const, subCommands: [] },
        context
      );
      if (!approved) {
        return { content: [{ type: "text", text: "Task denied by user." }] };
      }
    }
  }
  // autonomous mode: no approval needed

  // Build LLM call function using the server's LLM infrastructure
  const llmCall: LlmCallFn = async (prompt: string, image?: { data: string; mimeType: string }) => {
    const { createModelForRole } = await import("../llm-router.ts");
    const { generateText } = await import("ai");

    // Use "lightweight" role for a11y text-only calls, "primary" for vision
    const model = image ? createModelForRole("primary") : createModelForRole("lightweight");

    const messages: Array<{ role: "user"; content: unknown }> = [];

    if (image) {
      messages.push({
        role: "user",
        content: [
          { type: "image", image: image.data, mimeType: image.mimeType },
          { type: "text", text: prompt },
        ],
      });
    } else {
      messages.push({ role: "user", content: prompt });
    }

    const result = await generateText({
      model,
      messages: messages as Parameters<typeof generateText>[0]["messages"],
    });

    return result.text;
  };

  const result = await executePcTask(task, backend, {
    emit: context?.emitEvent ?? (() => {}),
    llmCall,
    safetyLevel,
  });

  // Audit log
  try {
    const activityEntry = insertActivity({
      source: "pc-control",
      title: `PC ${result.success ? "✓" : "✗"}: ${task.slice(0, 100)}`,
      content: `Target: ${backend.hostname}, Layer: ${result.layerUsed}, Success: ${result.success}${result.error ? `, Error: ${result.error}` : ""}`,
    });
    const { getWSInstance } = await import("../../gateway/ws-instance.ts");
    getWSInstance()?.broadcast({ type: "activity.new", data: activityEntry });
  } catch { /* non-critical */ }

  const content: NativeToolContentItem[] = [];
  content.push({
    type: "text",
    text: `${result.success ? "✓" : "✗"} ${result.summary} [Layer: ${result.layerUsed}]${result.error ? `\nError: ${result.error}` : ""}`,
  });

  if (result.screenshot) {
    content.push({
      type: "image",
      data: result.screenshot.data,
      mimeType: result.screenshot.mimeType ?? "image/jpeg",
    });
  }

  return { content };
};

const handlePcObserve: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  if (!getPcControlEnabled()) {
    return { content: [{ type: "text", text: "PC Control is disabled. Enable it in settings to use this tool." }] };
  }

  const targetId = args.targetId as string | undefined;

  // Loop detection: warn if observing too many times without taking action
  const sessionKey = context?.sessionId ?? "default";
  const tracker = getPcObserveTracker(sessionKey);
  tracker.count++;

  let backend;
  try {
    backend = getBackend(targetId);
  } catch (err) {
    return { content: [{ type: "text", text: (err as Error).message }] };
  }

  context?.emitEvent?.({ type: "pc.screenshot", data: { agentId: backend.id } });

  // Capture screenshot and a11y tree in parallel
  const [screenshot, a11yTree] = await Promise.all([
    backend.captureScreen().catch((err) => {
      console.error("[pc-observe] screenshot failed:", err);
      return null;
    }),
    backend.queryA11yTree({ maxDepth: 5 }).catch(() => null),
  ]);

  const content: NativeToolContentItem[] = [];

  if (screenshot) {
    content.push({
      type: "image",
      data: screenshot.data,
      mimeType: screenshot.mimeType ?? "image/jpeg",
    });
  }

  if (a11yTree) {
    try {
      const { serializeA11yTree } = await import("@chvor/pc-agent/a11y");
      const serialized = serializeA11yTree(a11yTree, { maxDepth: 5, maxNodes: 200 });
      content.push({
        type: "text",
        text: `UI Elements (${a11yTree.nodeCount} nodes):\n${serialized}`,
      });
    } catch {
      content.push({
        type: "text",
        text: `Screenshot taken. Accessibility tree available but serializer not loaded.`,
      });
    }
  } else {
    content.push({
      type: "text",
      text: screenshot
        ? `Screenshot taken (${screenshot.width}×${screenshot.height}). Accessibility tree not available on this platform.`
        : "Failed to capture screen.",
    });
  }

  // Loop detection warning
  if (tracker.count >= PC_OBSERVE_LOOP_THRESHOLD) {
    content.push({
      type: "text",
      text: `⚠ WARNING: You have observed the screen ${tracker.count} times without executing an action (pc_do). Either take a concrete action with pc_do, or tell the user what you see and what is blocking progress. Do NOT observe again without acting first.`,
    });
  }

  return { content };
};

const handlePcShell: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  if (!getPcControlEnabled()) {
    return { content: [{ type: "text", text: "PC Control is disabled. Enable it in settings to use this tool." }] };
  }

  const targetId = args.targetId as string | undefined;
  const command = args.command as string;
  const cwd = args.cwd as string | undefined;

  let backend;
  try {
    backend = getBackend(targetId);
  } catch (err) {
    return { content: [{ type: "text", text: (err as Error).message }] };
  }

  // Shell commands always require approval (regardless of safety level)
  const { approved } = await requestApproval(
    `PC shell: ${command}`,
    cwd ?? backend.hostname,
    { tier: "dangerous" as const, subCommands: [] },
    context
  );
  if (!approved) {
    return { content: [{ type: "text", text: "Shell command denied by user." }] };
  }

  const result = await backend.executeShell(command, cwd);

  // Audit log
  try {
    const activityEntry = insertActivity({
      source: "pc-control",
      title: `PC Shell: ${command.slice(0, 80)}`,
      content: `Target: ${backend.hostname}, Exit: ${result.exitCode}${cwd ? `, CWD: ${cwd}` : ""}`,
    });
    const { getWSInstance } = await import("../../gateway/ws-instance.ts");
    getWSInstance()?.broadcast({ type: "activity.new", data: activityEntry });
  } catch { /* non-critical */ }

  let output = "";
  if (result.stdout) output += `stdout:\n${result.stdout}\n`;
  if (result.stderr) output += `stderr:\n${result.stderr}\n`;
  output += `Exit code: ${result.exitCode}`;

  return { content: [{ type: "text", text: output }] };
};

export const pcControlModule: NativeToolModule = {
  group: "pc",
  defs: {
    [PC_DO_NAME]: pcDoToolDef,
    [PC_OBSERVE_NAME]: pcObserveToolDef,
    [PC_SHELL_NAME]: pcShellToolDef,
  },
  handlers: {
    [PC_DO_NAME]: handlePcDo,
    [PC_OBSERVE_NAME]: handlePcObserve,
    [PC_SHELL_NAME]: handlePcShell,
  },
  mappings: {
    [PC_DO_NAME]: { kind: "skill", id: "pc-control" },
    [PC_OBSERVE_NAME]: { kind: "skill", id: "pc-control" },
    [PC_SHELL_NAME]: { kind: "skill", id: "pc-control" },
  },
  enabled: () => getPcControlEnabled() && (localBackendAvailable() || hasConnectedAgents()),
};
