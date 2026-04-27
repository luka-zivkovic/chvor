import { tool } from "ai";
import { z } from "zod";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { insertActivity } from "../../db/activity-store.ts";
import { sanitizeYamlValue } from "./security.ts";
import { resolveWorkflowParams } from "./workflow-params.ts";
import { USER_SKILLS_DIR } from "./skill.ts";
import { CREATE_SCHEDULE_NAME, DELETE_SCHEDULE_NAME, LIST_SCHEDULES_NAME } from "./schedule.ts";
import { CREATE_WEBHOOK_NAME, DELETE_WEBHOOK_NAME, LIST_WEBHOOKS_NAME } from "./webhook.ts";
import type { NativeToolContext, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Workflow tools
// ---------------------------------------------------------------------------

const CREATE_WORKFLOW_NAME = "native__create_workflow";
const RUN_WORKFLOW_NAME = "native__run_workflow";
const LIST_WORKFLOWS_NAME = "native__list_workflows";
const DELETE_WORKFLOW_NAME = "native__delete_workflow";

export const WORKFLOW_EXCLUDED_TOOLS = [
  RUN_WORKFLOW_NAME,
  CREATE_WORKFLOW_NAME,
  DELETE_WORKFLOW_NAME,
  LIST_WORKFLOWS_NAME,
  CREATE_SCHEDULE_NAME,
  DELETE_SCHEDULE_NAME,
  LIST_SCHEDULES_NAME,
  CREATE_WEBHOOK_NAME,
  DELETE_WEBHOOK_NAME,
  LIST_WEBHOOKS_NAME,
];

const createWorkflowToolDef = tool({
  description:
    "[Create Workflow] Save a multi-step procedure as a reusable workflow template. Use when the user asks to save, template, or automate a series of steps. The workflow appears on the Brain Canvas and can be run later with native__run_workflow or linked to a schedule.",
  parameters: z.object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "Must be a lowercase slug (letters, digits, hyphens; cannot start with a hyphen)")
      .describe(
        "Unique slug (lowercase, hyphens ok). Used as filename. e.g. 'daily-crm-review'"
      ),
    name: z.string().describe("Display name (e.g. 'Daily CRM Review')"),
    description: z
      .string()
      .describe("Short description of what this workflow accomplishes"),
    category: z
      .enum([
        "ai",
        "communication",
        "data",
        "developer",
        "file",
        "productivity",
        "web",
      ])
      .optional()
      .describe("Workflow category"),
    icon: z
      .string()
      .optional()
      .describe("Icon name (e.g. 'workflow', 'rocket', 'repeat')"),
    steps: z
      .array(z.string())
      .min(1)
      .describe(
        "Ordered list of step instructions. Each step is a clear directive. Use {{param_name}} for parameter placeholders. Example: ['Fetch issues from {{repo_url}}', 'Summarize top {{count}} by priority']"
      ),
    parameters: z
      .array(
        z.object({
          name: z
            .string()
            .describe(
              "Parameter name (snake_case, used in {{name}} placeholders)"
            ),
          type: z
            .enum(["string", "number", "boolean"])
            .describe("Parameter value type"),
          description: z
            .string()
            .describe("Human-readable description of this parameter"),
          required: z
            .boolean()
            .describe("Whether this parameter must be provided at runtime"),
          default: z
            .string()
            .optional()
            .describe("Default value if not provided (as string)"),
        })
      )
      .optional()
      .describe(
        "Parameters that can be customized each time the workflow runs"
      ),
  }),
});

const handleCreateWorkflow: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const id = String(args.id)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  const name = String(args.name);
  const description = String(args.description);
  const category = args.category ? String(args.category) : undefined;
  const icon = args.icon ? String(args.icon) : undefined;
  const steps = args.steps as string[];
  const parameters = (args.parameters ?? []) as Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
    default?: string;
  }>;

  // Guard: prevent overwriting bundled skills
  const { getSkill: lookupWorkflowSkill } = await import("../capability-loader.ts");
  const existingWf = lookupWorkflowSkill(id);
  if (existingWf?.source === "bundled") {
    return {
      content: [{ type: "text", text: `Cannot create workflow "${id}" — a bundled skill with this ID exists. Choose a different ID.` }],
    };
  }

  // Build YAML frontmatter
  const frontmatter: string[] = [
    `name: ${sanitizeYamlValue(name)}`,
    `description: ${sanitizeYamlValue(description)}`,
    `version: 1.0.0`,
    `type: workflow`,
  ];
  if (category) frontmatter.push(`category: ${sanitizeYamlValue(category)}`);
  if (icon) frontmatter.push(`icon: ${sanitizeYamlValue(icon)}`);

  // Serialize parameters as YAML inputs
  if (parameters.length > 0) {
    frontmatter.push("inputs:");
    for (const p of parameters) {
      frontmatter.push(`  - name: ${sanitizeYamlValue(p.name)}`);
      frontmatter.push(`    type: ${p.type}`);
      frontmatter.push(
        `    description: ${sanitizeYamlValue(p.description)}`
      );
      frontmatter.push(`    required: ${p.required}`);
      if (p.default !== undefined) {
        frontmatter.push(`    default: ${sanitizeYamlValue(p.default)}`);
      }
    }
  }

  // Build body as numbered steps
  const body = steps.map((step, i) => `${i + 1}. ${step}`).join("\n");

  const content = `---\n${frontmatter.join("\n")}\n---\n${body}\n`;

  mkdirSync(USER_SKILLS_DIR, { recursive: true });
  const filePath = join(USER_SKILLS_DIR, `${id}.md`);
  writeFileSync(filePath, content, "utf8");

  // reloadAll() is called by the orchestrator after this tool returns
  // (same pattern as native__create_skill)

  return {
    content: [
      {
        type: "text",
        text: `Workflow "${name}" (id: ${id}) created with ${steps.length} steps and ${parameters.length} parameters. Saved to ${filePath}. It will appear on the Brain Canvas and can be run with native__run_workflow or linked to a schedule.`,
      },
    ],
  };
};

const runWorkflowToolDef = tool({
  description:
    "[Run Workflow] Execute a saved workflow by its ID. Resolves parameters (user-provided or defaults), substitutes them into the steps, and runs the procedure. Use native__list_workflows first if you need to find the workflow ID.",
  parameters: z.object({
    workflowId: z
      .string()
      .describe(
        "The workflow ID (slug) to execute. Same as the filename without .md extension."
      ),
    parameters: z
      .record(z.string())
      .optional()
      .describe(
        "Parameter values as key-value pairs. Keys must match parameter names defined in the workflow. Values are always strings. Missing optional parameters use their defaults."
      ),
  }),
});

const handleRunWorkflow: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const { getSkill } = await import("../capability-loader.ts");
  const { executeConversation } = await import("../orchestrator.ts");

  const workflowId = String(args.workflowId);
  const userParams = (args.parameters ?? {}) as Record<string, string>;

  // 1. Load the workflow
  const skill = getSkill(workflowId);

  if (!skill) {
    return {
      content: [
        {
          type: "text",
          text: `Workflow "${workflowId}" not found. Use native__list_workflows to see available workflows.`,
        },
      ],
    };
  }

  if (skill.skillType !== "workflow") {
    return {
      content: [
        {
          type: "text",
          text: `"${workflowId}" is a ${skill.skillType} skill, not a workflow. Only workflow-type skills can be executed with this tool.`,
        },
      ],
    };
  }

  // 2. Resolve parameters + substitute placeholders (single-pass)
  const definedParams = skill.metadata.inputs ?? [];
  const { missing, instructions } = resolveWorkflowParams(
    definedParams,
    userParams,
    skill.instructions
  );

  // 3. Fail early if required params are missing
  if (missing.length > 0) {
    const paramDetails = missing.map((name) => {
      const def = definedParams.find((p) => p.name === name);
      return `  - ${name}: ${def?.description ?? "(no description)"}`;
    });
    return {
      content: [
        {
          type: "text",
          text: `Cannot run workflow "${skill.metadata.name}": missing required parameter(s):\n${paramDetails.join("\n")}\n\nProvide these in the 'parameters' field.`,
        },
      ],
    };
  }

  // 4. Construct execution prompt
  const executionPrompt = `[WORKFLOW EXECUTION: "${skill.metadata.name}"]\n\nExecute the following workflow steps in order. Complete each step fully before moving to the next. Use your available tools as needed.\n\n${instructions}`;

  // 5. Run through the orchestrator as a sub-conversation
  const messages: import("@chvor/shared").ChatMessage[] = [
    {
      id: `wf-${workflowId}-${Date.now()}`,
      role: "user" as const,
      content: executionPrompt,
      channelType: (context?.channelType ?? "web") as import("@chvor/shared").ChannelType,
      timestamp: new Date().toISOString(),
    },
  ];

  const emit = context?.emitEvent ?? (() => {});

  try {
    const result = await executeConversation(
      messages,
      emit,
      undefined,
      undefined,
      {
        excludeTools: WORKFLOW_EXCLUDED_TOOLS,
        extraRounds: 5,
        channelType: context?.channelType,
        channelId: context?.channelId,
        sessionId: context?.sessionId,
      }
    );

    // Log to activity feed
    const activityEntry = insertActivity({
      source: "workflow",
      title: `Workflow: ${skill.metadata.name}`,
      content: result.text.slice(0, 2000),
    });
    try {
      const { getWSInstance } = await import("../../gateway/ws-instance.ts");
      getWSInstance()?.broadcast({ type: "activity.new", data: activityEntry });
    } catch { /* non-critical */ }

    return {
      content: [
        {
          type: "text",
          text: `Workflow "${skill.metadata.name}" completed.\n\n${result.text}`,
        },
      ],
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Workflow "${skill.metadata.name}" failed: ${errorMsg}`,
        },
      ],
    };
  }
};

const listWorkflowsToolDef = tool({
  description:
    "[List Workflows] List all saved workflows with their parameters and step counts.",
  parameters: z.object({}),
});

const handleListWorkflows: NativeToolHandler = async (): Promise<NativeToolResult> => {
  const { loadSkills } = await import("../capability-loader.ts");
  const workflows = loadSkills().filter(
    (s) => s.skillType === "workflow"
  );

  if (workflows.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No workflows found. Create one with native__create_workflow.",
        },
      ],
    };
  }

  const lines = workflows.map((w) => {
    const paramCount = w.metadata.inputs?.length ?? 0;
    const stepCount = w.instructions
      .split("\n")
      .filter((l) => /^\d+\./.test(l.trim())).length;
    const params =
      paramCount > 0
        ? ` | params: ${(w.metadata.inputs ?? []).map((p) => `${p.name}${p.required ? "*" : ""}`).join(", ")}`
        : "";
    return `- "${w.metadata.name}" (id: ${w.id}) | ${stepCount} steps${params}`;
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
};

const deleteWorkflowToolDef = tool({
  description:
    "[Delete Workflow] Delete a saved workflow by its ID. Use native__list_workflows first to find the ID.",
  parameters: z.object({
    workflowId: z
      .string()
      .describe("The workflow ID (slug) to delete"),
  }),
});

const handleDeleteWorkflow: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const { getSkill, reloadAll } = await import("../capability-loader.ts");
  const { listSchedules } = await import("../../db/schedule-store.ts");

  const workflowId = String(args.workflowId);
  const skill = getSkill(workflowId);

  if (!skill || skill.skillType !== "workflow") {
    return {
      content: [
        {
          type: "text",
          text: `Workflow "${workflowId}" not found.`,
        },
      ],
    };
  }

  // Check for schedules that reference this workflow
  const linkedSchedules = listSchedules().filter(
    (s) => s.workflowId === workflowId
  );

  try {
    unlinkSync(skill.path);
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to delete workflow file: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  reloadAll();

  let warning = "";
  if (linkedSchedules.length > 0) {
    const names = linkedSchedules.map((s) => `"${s.name}" (${s.id})`).join(", ");
    warning = `\n\n⚠ Warning: ${linkedSchedules.length} schedule(s) still reference this workflow and will fail on next run: ${names}. Consider deleting or updating them.`;
  }

  return {
    content: [
      {
        type: "text",
        text: `Workflow "${skill.metadata.name}" (id: ${workflowId}) deleted.${warning}`,
      },
    ],
  };
};

export const workflowModule: NativeToolModule = {
  group: "daemon",
  defs: {
    [CREATE_WORKFLOW_NAME]: createWorkflowToolDef,
    [RUN_WORKFLOW_NAME]: runWorkflowToolDef,
    [LIST_WORKFLOWS_NAME]: listWorkflowsToolDef,
    [DELETE_WORKFLOW_NAME]: deleteWorkflowToolDef,
  },
  handlers: {
    [CREATE_WORKFLOW_NAME]: handleCreateWorkflow,
    [RUN_WORKFLOW_NAME]: handleRunWorkflow,
    [LIST_WORKFLOWS_NAME]: handleListWorkflows,
    [DELETE_WORKFLOW_NAME]: handleDeleteWorkflow,
  },
  mappings: {
    [CREATE_WORKFLOW_NAME]: { kind: "skill", id: "workflows" },
    [RUN_WORKFLOW_NAME]: { kind: "skill", id: "workflows" },
    [LIST_WORKFLOWS_NAME]: { kind: "skill", id: "workflows" },
    [DELETE_WORKFLOW_NAME]: { kind: "skill", id: "workflows" },
  },
};
