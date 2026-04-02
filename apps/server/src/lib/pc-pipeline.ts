import type { PcAction, PcTaskResult, PcSafetyLevel, A11yTree } from "@chvor/shared";
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
export type LlmCallFn = (prompt: string, image?: { data: string; mimeType: string }) => Promise<string>;

export interface PipelineContext {
  emit: EventEmitter;
  llmCall: LlmCallFn;
  safetyLevel: PcSafetyLevel;
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
  ctx.emit({ type: "pc.pipeline.layer", data: { targetId, layer: "action-router", status: "trying" } });
  const routedActions = tryActionRouter(task);

  if (routedActions) {
    ctx.emit({ type: "pc.pipeline.layer", data: { targetId, layer: "action-router", status: "success" } });

    const errors: string[] = [];
    for (const action of routedActions) {
      const result = await backend.executeAction(action);
      if (!result.success && result.error) errors.push(result.error);
    }

    const success = errors.length === 0;
    ctx.emit({ type: "pc.pipeline.complete", data: { targetId, layer: "action-router", success } });

    return {
      success,
      layerUsed: "action-router",
      summary: success
        ? `Executed ${routedActions.length} action(s) via pattern matching.`
        : `Action router matched but execution failed: ${errors.join(", ")}`,
      actions: routedActions,
      error: success ? undefined : errors.join(", "),
    };
  }

  ctx.emit({ type: "pc.pipeline.layer", data: { targetId, layer: "action-router", status: "fallthrough" } });

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
      const actions = await parseActionsFromLlm(response, a11yTree, backend.screenSize);

      if (actions) {
        ctx.emit({ type: "pc.pipeline.layer", data: { targetId, layer: "a11y", status: "success" } });

        const errors: string[] = [];
        for (const action of actions) {
          const result = await backend.executeAction(action);
          if (!result.success && result.error) errors.push(result.error);
        }

        const success = errors.length === 0;
        ctx.emit({ type: "pc.pipeline.complete", data: { targetId, layer: "a11y", success } });

        return {
          success,
          layerUsed: "a11y",
          summary: success
            ? `Executed ${actions.length} action(s) via accessibility tree.`
            : `A11y layer resolved actions but execution failed: ${errors.join(", ")}`,
          actions,
          error: success ? undefined : errors.join(", "),
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
  const visionPrompt = buildVisionPrompt(task, backend.screenSize);
  const visionResponse = await ctx.llmCall(visionPrompt, {
    data: screenshot.data,
    mimeType: screenshot.mimeType ?? "image/jpeg",
  });
  const visionActions = parseVisionActions(visionResponse);

  if (visionActions.length > 0) {
    ctx.emit({ type: "pc.pipeline.layer", data: { targetId, layer: "vision", status: "success" } });

    const errors: string[] = [];
    for (const action of visionActions) {
      const result = await backend.executeAction(action);
      if (!result.success && result.error) errors.push(result.error);
    }

    const success = errors.length === 0;
    ctx.emit({ type: "pc.pipeline.complete", data: { targetId, layer: "vision", success } });

    return {
      success,
      layerUsed: "vision",
      summary: success
        ? `Executed ${visionActions.length} action(s) via vision analysis.`
        : `Vision layer resolved actions but execution failed: ${errors.join(", ")}`,
      actions: visionActions,
      screenshot,
      error: success ? undefined : errors.join(", "),
    };
  }

  ctx.emit({ type: "pc.pipeline.layer", data: { targetId, layer: "vision", status: "fallthrough" } });
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
// Response parsers
// ---------------------------------------------------------------------------

/**
 * Parse LLM response from the a11y layer.
 * Resolves nodeId references to actual coordinates using the a11y tree's bounding boxes.
 */
async function parseActionsFromLlm(
  response: string,
  tree: A11yTree,
  screenSize: { width: number; height: number }
): Promise<PcAction[] | null> {
  const trimmed = response.trim();
  if (trimmed === "null") return null;

  try {
    // Extract JSON from possible markdown code blocks
    const jsonStr = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return null;

    const { findNodeById, bboxToCoordinate } = await import("@chvor/pc-agent");

    const actions: PcAction[] = [];
    for (const item of parsed) {
      if (!item.action) continue;

      let coordinate: [number, number] | undefined;

      // Resolve nodeId -> coordinate
      if (item.nodeId != null) {
        const node = findNodeById(tree, item.nodeId);
        if (node?.bbox) {
          coordinate = bboxToCoordinate(node.bbox, screenSize.width, screenSize.height);
        }
      }

      const action: PcAction = {
        action: item.action,
        coordinate: coordinate ?? item.coordinate,
        text: item.text,
        keys: item.keys,
        direction: item.direction,
        amount: item.amount,
        duration: item.duration,
      };
      actions.push(action);
    }

    return actions.length > 0 ? actions : null;
  } catch {
    return null;
  }
}

/** Parse LLM response from the vision layer (coordinates already in 1024x768 space) */
function parseVisionActions(response: string): PcAction[] {
  const trimmed = response.trim();

  try {
    const jsonStr = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    const actions: PcAction[] = [];
    for (const item of parsed) {
      if (!item.action) continue;
      actions.push({
        action: item.action,
        coordinate: item.coordinate,
        text: item.text,
        keys: item.keys,
        direction: item.direction,
        amount: item.amount,
        duration: item.duration,
      });
    }
    return actions;
  } catch {
    return [];
  }
}
