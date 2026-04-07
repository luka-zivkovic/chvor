import type { ChatMessage, ExecutionEvent } from "@chvor/shared";
import type { WSManager } from "../gateway/ws.ts";
import {
  listSchedules,
  getSchedule,
  recordRun,
  updateSchedule,
} from "../db/schedule-store.ts";
import { executeConversation } from "./orchestrator.ts";
import type { ExecuteOptions } from "./orchestrator.ts";
import { logError } from "./error-logger.ts";
import { insertActivity } from "../db/activity-store.ts";

const SCHEDULE_TOOL_NAMES = [
  "native__create_schedule",
  "native__delete_schedule",
  "native__list_schedules",
];
const SCHEDULE_EXEC_OPTIONS: ExecuteOptions = { excludeTools: SCHEDULE_TOOL_NAMES };

export type ChannelSender = (
  channelType: string,
  channelId: string,
  text: string,
  threadId?: string
) => Promise<void>;

const MAX_TIMEOUT_MS = 2_147_483_647; // setTimeout max (~24.8 days)

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>(); // guards against overlapping executions
let wsManager: WSManager | null = null;
let channelSender: ChannelSender | null = null;

// Dynamic import for cron-parser (ESM/CJS interop)
let parseExpression: (expr: string) => { next: () => { toDate: () => Date } };

async function loadCronParser(): Promise<void> {
  const mod = await import("cron-parser");
  // Handle both default and named export styles
  const cp = (mod as Record<string, unknown>).default ?? mod;
  parseExpression = (cp as { parseExpression: typeof parseExpression }).parseExpression;
}

export async function initScheduler(
  ws: WSManager,
  sender?: ChannelSender
): Promise<void> {
  wsManager = ws;
  channelSender = sender ?? null;
  await loadCronParser();

  const schedules = listSchedules();
  for (const s of schedules) {
    if (s.enabled) armTimer(s.id, s.cronExpression);
  }
  console.log(
    `[scheduler] initialized with ${timers.size} active schedule(s)`
  );
}

export function shutdownScheduler(): void {
  for (const [, timer] of timers) clearTimeout(timer);
  timers.clear();
  console.log("[scheduler] shutdown, all timers cleared");
}

/**
 * Called by REST routes after every DB mutation.
 * Cancels existing timer and re-arms if enabled.
 */
export function syncSchedule(id: string): void {
  const existing = timers.get(id);
  if (existing) {
    clearTimeout(existing);
    timers.delete(id);
  }

  const schedule = getSchedule(id);
  if (!schedule || !schedule.enabled) return;

  armTimer(id, schedule.cronExpression);
}

function armTimer(id: string, cronExpression: string): void {
  let next: Date;
  try {
    const interval = parseExpression(cronExpression);
    next = interval.next().toDate();
  } catch (err) {
    console.error(
      `[scheduler] invalid cron for ${id}: "${cronExpression}"`,
      err
    );
    return;
  }

  const delay = next.getTime() - Date.now();
  if (delay < 0) {
    // Past due — fire immediately, then re-arm for next occurrence
    void fireAndRearm(id);
    return;
  }

  // Clamp delay to prevent setTimeout overflow (max ~24.8 days).
  // If clamped, the timer will wake early and re-arm for the real next time.
  const clampedDelay = Math.min(delay, MAX_TIMEOUT_MS);

  const timer = setTimeout(async () => {
    timers.delete(id);

    if (clampedDelay < delay) {
      // Woke early due to clamping — re-arm without firing
      const refreshed = getSchedule(id);
      if (refreshed?.enabled) armTimer(id, refreshed.cronExpression);
      return;
    }

    await fireAndRearm(id);
  }, clampedDelay);

  timers.set(id, timer);
  console.log(`[scheduler] armed "${id}" → ${next.toISOString()}`);
}

async function fireAndRearm(id: string): Promise<void> {
  await runSchedule(id);
  const refreshed = getSchedule(id);
  if (refreshed?.enabled) armTimer(id, refreshed.cronExpression);
}

async function runSchedule(id: string): Promise<void> {
  if (running.has(id)) {
    console.warn(`[scheduler] skipping "${id}" — already running`);
    return;
  }

  const schedule = getSchedule(id);
  if (!schedule) return;

  running.add(id);
  const startedAt = new Date().toISOString();
  console.log(`[scheduler] firing "${schedule.name}" (${id})`);

  try {
    const messages: ChatMessage[] = [
      {
        id: `sched-${id}-${Date.now()}`,
        role: "user",
        content: `[SCHEDULED TASK EXECUTION — This task is already scheduled and running automatically. Do NOT create, modify, or delete any schedules. Just perform the task below.]\n\n${schedule.prompt}`,
        channelType: "scheduler",
        timestamp: new Date().toISOString(),
      },
    ];

    const emit = (event: ExecutionEvent): void => {
      wsManager?.broadcast({ type: "execution.event", data: event });
    };

    // Broadcast start so canvas animates
    emit({ type: "execution.started", data: { executionId: `sched-${id}` } });

    let result: string | null = null;
    let error: string | null = null;

    try {
      // If this schedule is linked to a workflow, run the workflow instead
      if (schedule.workflowId) {
        const { getSkill } = await import("./capability-loader.ts");
        const { WORKFLOW_EXCLUDED_TOOLS, resolveWorkflowParams } = await import("./native-tools.ts");
        const skill = getSkill(schedule.workflowId);

        if (!skill || skill.skillType !== "workflow") {
          throw new Error(`Workflow "${schedule.workflowId}" not found or not a workflow type`);
        }

        // Resolve parameters + substitute placeholders (single-pass, shared logic)
        const storedParams = schedule.workflowParams ?? {};
        const { missing, instructions } = resolveWorkflowParams(
          skill.metadata.inputs ?? [],
          storedParams,
          skill.instructions
        );
        if (missing.length > 0) {
          throw new Error(`Workflow "${schedule.workflowId}" missing required parameter(s): ${missing.join(", ")}`);
        }

        const workflowPrompt = `[WORKFLOW EXECUTION: "${skill.metadata.name}" — Triggered by schedule "${schedule.name}"]\n\nExecute the following workflow steps in order. Complete each step fully before moving to the next. Use your available tools as needed.\n\n${instructions}`;

        const workflowMessages: ChatMessage[] = [
          {
            id: `sched-wf-${id}-${Date.now()}`,
            role: "user",
            content: workflowPrompt,
            channelType: "scheduler",
            timestamp: new Date().toISOString(),
          },
        ];

        const convResult = await executeConversation(workflowMessages, emit, undefined, undefined, {
          excludeTools: WORKFLOW_EXCLUDED_TOOLS,
          extraRounds: 5,
          channelType: "scheduler",
          sessionId: `sched-wf-${id}`,
        });
        result = convResult.text;
      } else {
        const convResult = await executeConversation(messages, emit, undefined, undefined, SCHEDULE_EXEC_OPTIONS);
        result = convResult.text;
      }
      emit({ type: "execution.completed", data: { output: result } });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] schedule ${id} failed:`, error);
      logError("scheduler_error", err, { scheduleId: id, scheduleName: schedule.name });
      emit({ type: "execution.failed", data: { error } });
    }

    recordRun(id, startedAt, result, error);

    const activityEntry = insertActivity({
      source: schedule.workflowId ? "workflow" : "schedule",
      title: schedule.workflowId ? `Workflow: ${schedule.name}` : schedule.name,
      content: result || error || null,
      scheduleId: schedule.id,
    });
    wsManager?.broadcast({ type: "activity.new", data: activityEntry });

    // Auto-disable one-shot schedules after execution
    if (schedule.oneShot) {
      updateSchedule(id, { enabled: false });
      timers.delete(id);
      console.log(`[scheduler] one-shot "${schedule.name}" auto-disabled after execution`);
      const { getWSInstance } = await import("../gateway/ws-instance.ts");
      const updated = getSchedule(id);
      if (updated) {
        getWSInstance()?.broadcast({ type: "schedule.updated" as const, data: updated });
      }
    }

    // Deliver to external channels if configured
    if (result && schedule.deliverTo && schedule.deliverTo.length > 0 && channelSender) {
      for (const target of schedule.deliverTo) {
        try {
          await channelSender(target.channelType, target.channelId, result);
          console.log(`[scheduler] delivered "${schedule.name}" → ${target.channelType}/${target.channelId}`);
        } catch (err) {
          console.error(`[scheduler] delivery to ${target.channelType}/${target.channelId} failed:`, err);
        }
      }
    }
  } finally {
    running.delete(id);
  }
}
