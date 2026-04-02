import { randomUUID } from "node:crypto";
import type { WSManager } from "../gateway/ws.ts";
import type { DaemonPresence, DaemonTask } from "@chvor/shared";
import { initPulse, shutdownPulse, setEscalationHandler } from "./pulse-engine.ts";
import { getDaemonConfig } from "../db/config-store.ts";
import { claimNextTask, updateDaemonTask, createDaemonTask, getQueueDepth, pruneDaemonTasks } from "../db/daemon-store.ts";
import { insertActivity } from "../db/activity-store.ts";
import { startPeriodicJob, stopPeriodicJob } from "./job-runner.ts";

let wsRef: WSManager | null = null;
let currentTask: DaemonTask | null = null;
let consecutiveIdle = 0;
let lastPruneDate: string | null = null;

const DAEMON_JOB_ID = "daemon-tick";
const TICK_INTERVAL_MS = 60_000; // 60 seconds

export async function initDaemon(ws: WSManager): Promise<void> {
  wsRef = ws;

  // Always init pulse (it handles its own enabled check)
  await initPulse(ws);

  // Register escalation handler for auto-remediation
  setEscalationHandler(handleEscalation);

  const config = getDaemonConfig();
  if (config.enabled) {
    startPeriodicJob({
      id: DAEMON_JOB_ID,
      intervalMs: TICK_INTERVAL_MS,
      run: daemonTick,
    });
    console.log("[daemon] initialized and armed (tick every 60s)");
  } else {
    console.log("[daemon] initialized but disabled");
  }
}

export function syncDaemon(): void {
  stopPeriodicJob(DAEMON_JOB_ID);
  const config = getDaemonConfig();
  if (config.enabled) {
    startPeriodicJob({
      id: DAEMON_JOB_ID,
      intervalMs: TICK_INTERVAL_MS,
      run: daemonTick,
    });
  }
}

export function shutdownDaemon(): void {
  stopPeriodicJob(DAEMON_JOB_ID);
  shutdownPulse();
  console.log("[daemon] shutdown");
}

export function getDaemonPresence(): DaemonPresence {
  const config = getDaemonConfig();
  return {
    state: !config.enabled
      ? "sleeping"
      : currentTask
        ? "working"
        : "idle",
    currentTask: currentTask ? { id: currentTask.id, title: currentTask.title } : null,
    queueDepth: getQueueDepth(),
    lastActivity: null,
  };
}

// ─── Tick Loop ─────────────────────────────────────────────

async function daemonTick(): Promise<void> {
  const config = getDaemonConfig();
  if (!config.enabled) return;

  // Daily prune check
  const today = new Date().toISOString().slice(0, 10);
  if (lastPruneDate !== today) {
    lastPruneDate = today;
    const pruned = pruneDaemonTasks(7);
    if (pruned > 0) console.log(`[daemon] pruned ${pruned} old tasks`);
  }

  // Process task queue
  if (config.taskQueue && !currentTask) {
    const task = claimNextTask();
    if (task) {
      currentTask = task;
      broadcastPresence();

      try {
        console.log(`[daemon] executing task: ${task.title}`);
        // Dynamic import to avoid circular dependency
        const { executeConversation } = await import("./orchestrator.ts");
        const noop = () => {};

        const result = await executeConversation(
          [{
            id: randomUUID(),
            role: "user" as const,
            content: `[DAEMON TASK — This task was queued for autonomous execution. Complete it now.]\n\n${task.prompt}`,
            channelType: "daemon" as any,
            timestamp: new Date().toISOString(),
          }],
          noop as any,
        );

        const resultText = typeof result?.text === "string" ? result.text : JSON.stringify(result);
        updateDaemonTask(task.id, {
          status: "completed",
          result: resultText?.slice(0, 5000) ?? null,
        });

        insertActivity({
          source: "daemon",
          title: `Completed: ${task.title}`,
          content: resultText?.slice(0, 2000) ?? null,
        });

        console.log(`[daemon] task completed: ${task.title}`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        updateDaemonTask(task.id, {
          status: "failed",
          error,
        });
        console.error(`[daemon] task failed: ${task.title}`, error);
      } finally {
        currentTask = null;
        broadcastPresence();
      }

      consecutiveIdle = 0;
      return;
    }
  }

  // Idle actions
  consecutiveIdle++;

  if (config.idleActions && consecutiveIdle >= 5 && consecutiveIdle % 5 === 0) {
    try {
      console.log("[daemon] idle — triggering memory consolidation");
      broadcastPresence("consolidating");
      const { runConsolidation } = await import("./memory-consolidation.ts");
      await runConsolidation();
    } catch (err) {
      console.error("[daemon] idle consolidation failed:", err);
    } finally {
      broadcastPresence();
    }
  }
}

// ─── Escalation Handler ────────────────────────────────────

function handleEscalation(resultText: string, _healthContext: string): void {
  const config = getDaemonConfig();
  if (!config.enabled || !config.autoRemediate) return;

  if (resultText.startsWith("[CRITICAL]")) {
    // Check for MCP server issues
    const mcpMatch = resultText.match(/MCP.*?(?:down|failed|disconnected).*?:\s*(.+?)(?:\)|,|$)/i);
    if (mcpMatch) {
      createDaemonTask({
        title: `Auto-remediate: restart MCP server`,
        prompt: `A critical health alert was raised: "${resultText}". Attempt to reconnect the failed MCP server. Use the available tools to diagnose and fix the issue.`,
        source: "pulse",
        priority: 3,
      });
      console.log("[daemon] queued MCP remediation task from pulse escalation");
    }
  }

  if (resultText.includes("webhook") || resultText.includes("Webhook")) {
    createDaemonTask({
      title: `Auto-remediate: webhook failure`,
      prompt: `A health alert flagged webhook issues: "${resultText}". Investigate and attempt to resolve.`,
      source: "pulse",
      priority: 2,
    });
    console.log("[daemon] queued webhook remediation task from pulse escalation");
  }
}

// ─── Helpers ───────────────────────────────────────────────

function broadcastPresence(stateOverride?: DaemonPresence["state"]): void {
  const presence = getDaemonPresence();
  if (stateOverride) presence.state = stateOverride;
  wsRef?.broadcast({ type: "daemon.presence", data: presence } as any);
}
