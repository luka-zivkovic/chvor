import type {
  PcAction,
  PcTaskResult,
  PcSafetyLevel,
  A11yTree,
  PcScreenshot,
  PipelineLayer,
} from "@chvor/shared";
import type { PcBackend } from "./pc-backend.ts";
import type { ExecutionEvent } from "@chvor/shared";
import { tryActionRouter } from "./action-patterns.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventEmitter = (event: ExecutionEvent) => void;

/**
 * LLM call function — injected by the server (the pipeline has no LLM dependency).
 *
 * @param prompt - The system + user message content
 * @param image  - Optional base64 image for vision calls
 * @returns The LLM's text response
 */
export type LlmCallFn = (
  prompt: string,
  image?: { data: string; mimeType: string }
) => Promise<string>;

export interface PipelineContext {
  emit: EventEmitter;
  llmCall: LlmCallFn;
  safetyLevel: PcSafetyLevel;
  authorizeActions?: (
    actions: PcAction[],
    layer: PipelineLayer
  ) => Promise<{ allowed: boolean; error?: string }>;
}

const POST_ACTION_SETTLE_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function authorizeActions(
  actions: PcAction[],
  layer: PipelineLayer,
  ctx: PipelineContext
): Promise<{ allowed: boolean; error?: string }> {
  return ctx.authorizeActions ? ctx.authorizeActions(actions, layer) : { allowed: true };
}

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

/**
 * Execute a PC task through the 3-layer pipeline:
 *
 * 1. **Action Router** — Pattern matching for common tasks (zero LLM)
 * 2. **Accessibility Tree** — Query OS a11y tree, text-only LLM inference
 * 3. **Vision** — Screenshot + vision LLM inference (fallback)
 *
 * Each layer can fall through to the next if it can't handle the task.
 */
export async function executePcTask(
  task: string,
  backend: PcBackend,
  ctx: PipelineContext
): Promise<PcTaskResult> {
  const targetId = backend.id;

  ctx.emit({ type: "pc.pipeline.start", data: { targetId, task } });

  // Layer 1: Action Router (zero LLM)
  ctx.emit({
    type: "pc.pipeline.layer",
    data: { targetId, layer: "action-router", status: "trying" },
  });
  const routedActions = tryActionRouter(task);

  if (routedActions) {
    ctx.emit({
      type: "pc.pipeline.layer",
      data: { targetId, layer: "action-router", status: "success" },
    });

    const authorization = await authorizeActions(routedActions, "action-router", ctx);
    if (!authorization.allowed) {
      ctx.emit({
        type: "pc.pipeline.complete",
        data: { targetId, layer: "action-router", success: false },
      });
      return {
        success: false,
        layerUsed: "action-router",
        summary: "Action router resolved actions, but safety policy denied execution.",
        actions: routedActions,
        error: authorization.error ?? "Denied by PC safety policy.",
      };
    }

    const execution = await executeActionSequence(routedActions, backend);
    const success = execution.success;
    ctx.emit({ type: "pc.pipeline.complete", data: { targetId, layer: "action-router", success } });

    return {
      success,
      layerUsed: "action-router",
      summary: success
        ? `Executed ${execution.executedCount} action(s) via pattern matching.`
        : `Action router matched but execution failed after ${execution.executedCount}/${routedActions.length} action(s): ${execution.error}`,
      actions: routedActions,
      screenshot: execution.screenshot,
      error: success ? undefined : execution.error,
    };
  }

  ctx.emit({
    type: "pc.pipeline.layer",
    data: { targetId, layer: "action-router", status: "fallthrough" },
  });

  // Layer 2: Accessibility Tree (text-only LLM)
  ctx.emit({ type: "pc.pipeline.layer", data: { targetId, layer: "a11y", status: "trying" } });
  let a11yTree: A11yTree | null = null;

  try {
    a11yTree = await backend.queryA11yTree({ maxDepth: 6 });
  } catch {
    // a11y not available, skip
  }

  if (!a11yTree) {
    console.log("[pc-pipeline] a11y tree: null (not available on this platform or error)");
  } else {
    console.log(`[pc-pipeline] a11y tree: ${a11yTree.nodeCount} nodes`);
  }

  if (a11yTree && a11yTree.nodeCount > 3) {
    // Import the serializer dynamically (from pc-agent lib)
    let serialized: string;
    try {
      const { serializeA11yTree } = await import("@chvor/pc-agent/a11y");
      serialized = serializeA11yTree(a11yTree, { maxDepth: 6, maxNodes: 200 });
    } catch {
      console.log("[pc-pipeline] a11y serializer import failed, skipping a11y layer");
      serialized = "";
    }

    if (serialized) {
      const a11yPrompt = buildA11yPrompt(task, serialized);
      const response = await ctx.llmCall(a11yPrompt);
      const actions = await parseActionsFromLlm(
        response,
        a11yTree,
        backend.screenSize,
        backend.coordinateSize
      );

      if (actions) {
        ctx.emit({
          type: "pc.pipeline.layer",
          data: { targetId, layer: "a11y", status: "success" },
        });

        const authorization = await authorizeActions(actions, "a11y", ctx);
        if (!authorization.allowed) {
          ctx.emit({
            type: "pc.pipeline.complete",
            data: { targetId, layer: "a11y", success: false },
          });
          return {
            success: false,
            layerUsed: "a11y",
            summary: "A11y layer resolved actions, but safety policy denied execution.",
            actions,
            error: authorization.error ?? "Denied by PC safety policy.",
          };
        }

        const execution = await executeActionSequence(actions, backend);
        const success = execution.success;
        ctx.emit({ type: "pc.pipeline.complete", data: { targetId, layer: "a11y", success } });

        return {
          success,
          layerUsed: "a11y",
          summary: success
            ? `Executed ${execution.executedCount} action(s) via accessibility tree.`
            : `A11y layer resolved actions but execution failed after ${execution.executedCount}/${actions.length} action(s): ${execution.error}`,
          actions,
          screenshot: execution.screenshot,
          error: success ? undefined : execution.error,
        };
      }
    }
  }

  const a11yReason = !a11yTree
    ? "tree unavailable"
    : a11yTree.nodeCount <= 3
      ? `too few nodes (${a11yTree.nodeCount})`
      : "no actions parsed from LLM";
  console.log(`[pc-pipeline] a11y layer fallthrough: ${a11yReason}`);
  ctx.emit({ type: "pc.pipeline.layer", data: { targetId, layer: "a11y", status: "fallthrough" } });

  // Layer 3: Vision (screenshot + vision LLM)
  ctx.emit({ type: "pc.pipeline.layer", data: { targetId, layer: "vision", status: "trying" } });

  const screenshot = await backend.captureScreen();
  // Prompt with the actual screenshot dimensions. The pc-agent maps these
  // perceived coordinates back to native display coordinates during execution.
  const visionPrompt = buildVisionPrompt(task, {
    width: screenshot.width,
    height: screenshot.height,
  });
  const visionResponse = await ctx.llmCall(visionPrompt, {
    data: screenshot.data,
    mimeType: screenshot.mimeType ?? "image/jpeg",
  });
  const visionActions = parseVisionActions(visionResponse, screenshot);

  if (visionActions.length > 0) {
    ctx.emit({ type: "pc.pipeline.layer", data: { targetId, layer: "vision", status: "success" } });

    const authorization = await authorizeActions(visionActions, "vision", ctx);
    if (!authorization.allowed) {
      ctx.emit({
        type: "pc.pipeline.complete",
        data: { targetId, layer: "vision", success: false },
      });
      return {
        success: false,
        layerUsed: "vision",
        summary: "Vision layer resolved actions, but safety policy denied execution.",
        actions: visionActions,
        error: authorization.error ?? "Denied by PC safety policy.",
      };
    }

    const execution = await executeActionSequence(visionActions, backend);
    const success = execution.success;
    ctx.emit({ type: "pc.pipeline.complete", data: { targetId, layer: "vision", success } });

    return {
      success,
      layerUsed: "vision",
      summary: success
        ? `Executed ${execution.executedCount} action(s) via vision analysis.`
        : `Vision layer resolved actions but execution failed after ${execution.executedCount}/${visionActions.length} action(s): ${execution.error}`,
      actions: visionActions,
      screenshot: execution.screenshot,
      error: success ? undefined : execution.error,
    };
  }

  ctx.emit({
    type: "pc.pipeline.layer",
    data: { targetId, layer: "vision", status: "fallthrough" },
  });
  ctx.emit({ type: "pc.pipeline.complete", data: { targetId, layer: "vision", success: false } });

  return {
    success: false,
    layerUsed: "vision",
    summary: "Could not determine actions for this task.",
    actions: [],
    screenshot,
    error: "No layer could resolve the task into actions.",
  };
}

// ---------------------------------------------------------------------------
// Action execution + post-action observation
// ---------------------------------------------------------------------------

interface ActionSequenceExecution {
  success: boolean;
  executedCount: number;
  error?: string;
  screenshot?: PcScreenshot;
}

async function executeActionSequence(
  actions: PcAction[],
  backend: PcBackend
): Promise<ActionSequenceExecution> {
  const errors: string[] = [];
  let executedCount = 0;

  for (const action of actions) {
    try {
      const result = await backend.executeAction(action);
      if (!result.success) {
        errors.push(result.error ?? "Unknown action execution error");
        break;
      }
      executedCount++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      break;
    }
  }

  if (actions.length > 0) {
    await delay(POST_ACTION_SETTLE_MS);
  }

  const screenshot = await backend.captureScreen().catch((err) => {
    console.warn("[pc-pipeline] post-action screenshot failed:", (err as Error).message);
    return undefined;
  });

  return {
    success: errors.length === 0,
    executedCount,
    error: errors.length > 0 ? errors.join(", ") : undefined,
    screenshot,
  };
}

// ---------------------------------------------------------------------------
// LLM prompt builders
// ---------------------------------------------------------------------------

function buildA11yPrompt(task: string, serializedTree: string): string {
  return `You are a PC automation agent. Given the UI accessibility tree below, determine what actions to take to accomplish the task.

TASK: ${task}

UI ACCESSIBILITY TREE:
${serializedTree}

Respond with a JSON array of actions. Each action is one of:
- {"action": "left_click", "nodeId": <id>} — click an element by its [id]
- {"action": "right_click", "nodeId": <id>}
- {"action": "double_click", "nodeId": <id>}
- {"action": "type", "text": "<text>", "nodeId": <id>} — click the element first, then type
- {"action": "key", "keys": "<combo>"} — e.g. "ctrl+c", "enter", "tab"
- {"action": "scroll", "direction": "up"|"down"}

If the task cannot be accomplished with the visible UI elements, respond with exactly: null

Respond ONLY with the JSON array or null. No explanation.`;
}

function buildVisionPrompt(task: string, screenSize: { width: number; height: number }): string {
  return `You are a PC automation agent. Look at this screenshot and determine what actions to take to accomplish the task.

TASK: ${task}

The screenshot is ${screenSize.width}x${screenSize.height}. All coordinates are relative to this resolution.

Respond with a JSON array of actions. Each action is one of:
- {"action": "left_click", "coordinate": [x, y]}
- {"action": "right_click", "coordinate": [x, y]}
- {"action": "double_click", "coordinate": [x, y]}
- {"action": "type", "text": "<text>", "coordinate": [x, y]} — click first, then type
- {"action": "key", "keys": "<combo>"} — e.g. "ctrl+c", "enter", "tab"
- {"action": "scroll", "direction": "up"|"down", "coordinate": [x, y]}
- {"action": "mouse_move", "coordinate": [x, y]}

Respond ONLY with the JSON array. No explanation.`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set<string>([
  "screenshot",
  "mouse_move",
  "left_click",
  "right_click",
  "double_click",
  "middle_click",
  "type",
  "key",
  "scroll",
  "wait",
]);

function isValidCoordinate(
  c: unknown,
  bounds?: { width: number; height: number }
): c is [number, number] {
  return (
    Array.isArray(c) &&
    c.length === 2 &&
    typeof c[0] === "number" &&
    typeof c[1] === "number" &&
    Number.isFinite(c[0]) &&
    Number.isFinite(c[1]) &&
    c[0] >= 0 &&
    c[0] < (bounds?.width ?? 10000) &&
    c[1] >= 0 &&
    c[1] < (bounds?.height ?? 10000)
  );
}

const COORDINATE_REQUIRED_ACTIONS = new Set<string>([
  "mouse_move",
  "left_click",
  "right_click",
  "double_click",
  "middle_click",
  "type",
]);

function coordinateRequired(action: string, layer: "a11y" | "vision"): boolean {
  // A11y prompts intentionally allow {"action":"scroll","direction":"down"}
  // without coordinates, matching pc-agent/action-router behavior. Vision
  // prompts ask for scroll coordinates so require them there.
  return COORDINATE_REQUIRED_ACTIONS.has(action) || (layer === "vision" && action === "scroll");
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

/**
 * Parse LLM response from the a11y layer.
 * Resolves nodeId references to actual coordinates using the a11y tree's bounding boxes.
 */
async function parseActionsFromLlm(
  response: string,
  tree: A11yTree,
  screenSize: { width: number; height: number },
  coordinateSize: { width: number; height: number }
): Promise<PcAction[] | null> {
  const trimmed = response.trim();
  if (trimmed === "null") return null;

  try {
    // Extract JSON from possible markdown code blocks
    const jsonStr = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return null;

    const actions: PcAction[] = [];
    for (const item of parsed) {
      if (!item.action || !VALID_ACTIONS.has(item.action)) continue;

      let coordinate: [number, number] | undefined;

      // Resolve nodeId -> coordinate
      if (item.nodeId != null) {
        const { findNodeById, bboxToCoordinate } = await import("@chvor/pc-agent");
        const node = findNodeById(tree, item.nodeId);
        if (node?.bbox) {
          coordinate = bboxToCoordinate(
            node.bbox,
            screenSize.width,
            screenSize.height,
            coordinateSize.width,
            coordinateSize.height
          );
        }
      }

      const rawCoord = coordinate ?? item.coordinate;
      const validCoordinate = isValidCoordinate(rawCoord, coordinateSize) ? rawCoord : undefined;
      if (coordinateRequired(item.action, "a11y") && !validCoordinate) continue;
      const action: PcAction = {
        action: item.action,
        coordinate: validCoordinate,
        screenWidth: validCoordinate ? coordinateSize.width : undefined,
        screenHeight: validCoordinate ? coordinateSize.height : undefined,
        text: item.text,
        keys: item.keys,
        direction: item.direction,
        amount: item.amount,
        duration: item.duration,
      };
      actions.push(action);
    }

    return actions.length > 0 ? actions : null;
  } catch (err) {
    console.warn(
      "[pc-pipeline] a11y response parse failed:",
      (err as Error).message,
      "| raw:",
      response.slice(0, 200)
    );
    return null;
  }
}

/** Parse LLM response from the vision layer (coordinates in the screenshot space). */
function parseVisionActions(response: string, screenshot: PcScreenshot): PcAction[] {
  const trimmed = response.trim();

  try {
    const jsonStr = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    const actions: PcAction[] = [];
    for (const item of parsed) {
      if (!item.action || !VALID_ACTIONS.has(item.action)) continue;
      const coordinate = isValidCoordinate(item.coordinate, screenshot)
        ? item.coordinate
        : undefined;
      if (coordinateRequired(item.action, "vision") && !coordinate) continue;
      actions.push({
        action: item.action,
        coordinate,
        screenWidth: coordinate ? screenshot.width : undefined,
        screenHeight: coordinate ? screenshot.height : undefined,
        text: item.text,
        keys: item.keys,
        direction: item.direction,
        amount: item.amount,
        duration: item.duration,
      });
    }
    return actions;
  } catch (err) {
    console.warn(
      "[pc-pipeline] vision response parse failed:",
      (err as Error).message,
      "| raw:",
      response.slice(0, 200)
    );
    return [];
  }
}

/** Internal parser hooks for focused unit tests; production callers should use executePcTask. */
export const __pcPipelineInternals = {
  parseActionsFromLlm,
  parseVisionActions,
};
