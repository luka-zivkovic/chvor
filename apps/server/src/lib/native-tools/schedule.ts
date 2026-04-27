import { tool } from "ai";
import { z } from "zod";
import type { NativeToolContext, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Schedule tools
// ---------------------------------------------------------------------------
// Schedule + session imports are lazy to avoid circular dependency:
// orchestrator → native-tools → scheduler → orchestrator
// Instead, we import at call time inside handlers.

export const CREATE_SCHEDULE_NAME = "native__create_schedule";

const createScheduleToolDef = tool({
  description:
    "[Create Schedule] Create a recurring or one-shot scheduled task. Use this when the user asks you to remind them, check something periodically, or set up any automated task. For one-time reminders (e.g. 'remind me in 5 minutes', 'remind me at 3pm'), set oneShot=true so it auto-disables after firing once. For recurring tasks (e.g. 'every day at 9am'), leave oneShot false.",
  parameters: z.object({
    name: z.string().describe("Short name for the schedule (e.g. 'Morning briefing')"),
    cronExpression: z
      .string()
      .describe(
        "Cron expression for when to run (5 fields: minute hour day-of-month month day-of-week). Examples: '0 9 * * *' = daily 9 AM, '*/30 * * * *' = every 30 min, '0 9 * * 1' = every Monday 9 AM, '30 14 * * *' = 2:30 PM daily"
      ),
    prompt: z
      .string()
      .describe(
        "The instruction/prompt that will be executed when the schedule fires. Write it as a direct action — do NOT include scheduling language like 'remind me' or 'every day'. Example: 'Send a friendly greeting to my friend' not 'Remind me every day to send a greeting'."
      ),
    oneShot: z
      .boolean()
      .optional()
      .describe(
        "If true, the schedule auto-disables after firing once. Use for one-time reminders like 'remind me in 5 minutes' or 'remind me at 3pm today'. Default: false (recurring)."
      ),
    deliverToChannel: z
      .enum(["telegram", "discord", "slack"])
      .optional()
      .describe(
        "If set, deliver the result to this channel. Auto-resolves the chat ID from the most recent conversation on that channel."
      ),
    workflowId: z
      .string()
      .optional()
      .describe(
        "If set, this schedule runs the specified workflow instead of the raw prompt. The prompt field still serves as a human-readable description."
      ),
    workflowParams: z
      .record(z.string())
      .optional()
      .describe(
        "Parameter values for the workflow. Required parameters must be provided here since no user is present during scheduled execution."
      ),
  }),
});

const handleCreateSchedule: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const { createSchedule } = await import("../../db/schedule-store.ts");
  const { syncSchedule } = await import("../scheduler.ts");
  const { listChannelTargets } = await import("../../db/session-store.ts");

  const name = String(args.name);
  const cronExpression = String(args.cronExpression);
  const prompt = String(args.prompt);
  const oneShot = Boolean(args.oneShot);
  const deliverToChannel = args.deliverToChannel
    ? String(args.deliverToChannel)
    : undefined;
  const workflowId = args.workflowId ? String(args.workflowId) : undefined;
  const workflowParams = args.workflowParams as Record<string, string> | undefined;

  // Validate cron expression
  try {
    const cronParser = await import("cron-parser");
    const parse = cronParser.parseExpression ?? cronParser.default?.parseExpression;
    if (parse) parse(cronExpression);
  } catch {
    return {
      content: [{ type: "text", text: `Invalid cron expression: "${cronExpression}". Use 5 fields: minute hour day-of-month month day-of-week.` }],
    };
  }

  // Validate workflow if specified
  if (workflowId) {
    const { getSkill } = await import("../capability-loader.ts");
    const skill = getSkill(workflowId);
    if (!skill || skill.skillType !== "workflow") {
      return {
        content: [{ type: "text", text: `Workflow "${workflowId}" not found or is not a workflow-type skill.` }],
      };
    }
    // Validate all required params are provided (no user to prompt during cron)
    const definedParams = skill.metadata.inputs ?? [];
    const provided = workflowParams ?? {};
    const missing = definedParams.filter(
      (p) => p.required && provided[p.name] === undefined && p.default === undefined
    );
    if (missing.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: `Cannot schedule workflow: missing required parameter(s): ${missing.map((p) => p.name).join(", ")}. All required parameters must be provided at schedule creation since no user is present during cron execution.`,
          },
        ],
      };
    }
  }

  // Resolve delivery target from session history
  let deliverTo = undefined;
  if (deliverToChannel) {
    const targets = listChannelTargets();
    const match = targets.find((t) => t.channelType === deliverToChannel);
    if (match) {
      deliverTo = [
        {
          channelType: match.channelType as "telegram" | "discord" | "slack",
          channelId: match.channelId,
        },
      ];
    }
  }

  const schedule = createSchedule({
    name,
    cronExpression,
    prompt,
    workspaceId: context?.workspaceId ?? "default-constellation",
    oneShot,
    deliverTo,
    workflowId,
    workflowParams,
  });

  syncSchedule(schedule.id);

  const { getWSInstance } = await import("../../gateway/ws-instance.ts");
  getWSInstance()?.broadcast({ type: "schedule.created" as const, data: schedule });

  const workflowLabel = workflowId ? ` Linked to workflow: ${workflowId}.` : "";
  return {
    content: [
      {
        type: "text",
        text: `Schedule "${name}" created (id: ${schedule.id}). Cron: ${cronExpression}.${oneShot ? " One-shot (will auto-disable after first run)." : ""}${deliverTo ? ` Will deliver to ${deliverToChannel}.` : ""}${workflowLabel} The schedule is now active and armed.`,
      },
    ],
  };
};

export const LIST_SCHEDULES_NAME = "native__list_schedules";

const listSchedulesToolDef = tool({
  description:
    "[List Schedules] List all scheduled tasks with their status, cron timing, and last run info.",
  parameters: z.object({}),
});

const handleListSchedules: NativeToolHandler = async (): Promise<NativeToolResult> => {
  const { listSchedules } = await import("../../db/schedule-store.ts");
  const schedules = listSchedules();
  if (schedules.length === 0) {
    return {
      content: [{ type: "text", text: "No schedules found." }],
    };
  }

  const lines = schedules.map((s) => {
    const status = s.enabled ? "enabled" : "paused";
    const lastRun = s.lastRunAt ?? "never";
    const delivery =
      s.deliverTo && s.deliverTo.length > 0
        ? ` → ${s.deliverTo.map((d) => d.channelType).join(", ")}`
        : "";
    return `- [${status}] "${s.name}" (${s.cronExpression}) | last run: ${lastRun}${delivery} | id: ${s.id}`;
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
};

export const DELETE_SCHEDULE_NAME = "native__delete_schedule";

const deleteScheduleToolDef = tool({
  description:
    "[Delete Schedule] Delete a scheduled task by its ID. Use native__list_schedules first to find the ID.",
  parameters: z.object({
    id: z.string().describe("The schedule ID to delete"),
  }),
});

const handleDeleteSchedule: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const { deleteSchedule } = await import("../../db/schedule-store.ts");
  const { syncSchedule } = await import("../scheduler.ts");

  const id = String(args.id);
  const deleted = deleteSchedule(id);
  syncSchedule(id);

  if (deleted) {
    const { getWSInstance } = await import("../../gateway/ws-instance.ts");
    getWSInstance()?.broadcast({ type: "schedule.deleted" as const, data: { id } });
  }

  return {
    content: [
      {
        type: "text",
        text: deleted
          ? `Schedule ${id} deleted.`
          : `Schedule ${id} not found.`,
      },
    ],
  };
};

export const scheduleModule: NativeToolModule = {
  group: "daemon",
  defs: {
    [CREATE_SCHEDULE_NAME]: createScheduleToolDef,
    [LIST_SCHEDULES_NAME]: listSchedulesToolDef,
    [DELETE_SCHEDULE_NAME]: deleteScheduleToolDef,
  },
  handlers: {
    [CREATE_SCHEDULE_NAME]: handleCreateSchedule,
    [LIST_SCHEDULES_NAME]: handleListSchedules,
    [DELETE_SCHEDULE_NAME]: handleDeleteSchedule,
  },
  mappings: {
    [CREATE_SCHEDULE_NAME]: { kind: "tool", id: "scheduler" },
    [LIST_SCHEDULES_NAME]: { kind: "tool", id: "scheduler" },
    [DELETE_SCHEDULE_NAME]: { kind: "tool", id: "scheduler" },
  },
};
