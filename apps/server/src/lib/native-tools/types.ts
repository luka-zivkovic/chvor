import type { tool } from "ai";
import type { ExecutionEvent, ToolGroupId, ToolCriticality, RiskTag } from "@chvor/shared";

export type NativeToolContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface NativeToolResult {
  content: NativeToolContentItem[];
}

export interface NativeToolContext {
  sessionId?: string;
  emitEvent?: (event: ExecutionEvent) => void;
  originClientId?: string;
  channelType?: string;
  channelId?: string;
  workspaceId?: string;
  /**
   * The most recent user message in this turn. Used by `request_credential`
   * to capture deferred intent so the AI can resume the original task once
   * credentials arrive.
   */
  latestUserText?: string;
}

export type NativeToolHandler = (
  args: Record<string, unknown>,
  context?: NativeToolContext
) => Promise<NativeToolResult>;

export interface NativeToolModule {
  defs: Record<string, ReturnType<typeof tool>>;
  handlers: Record<string, NativeToolHandler>;
  /** Optional predicate evaluated each time getNativeToolDefinitions() is called. */
  enabled?: () => boolean;
  /** Optional native-tool → capability mapping for canvas animation. */
  mappings?: Record<string, { kind: "skill" | "tool"; id: string }>;
  /**
   * Group all tools in this module belong to. Used by skill-scoped
   * injection (Phase C). One module = one group keeps the model simple;
   * if a module hosts mixed-purpose tools, split it.
   */
  group: ToolGroupId;
  /**
   * Per-tool overrides keyed by qualified tool name. Use this when a single
   * module has one or two tools that don't fit the module's primary group
   * (e.g. a "diagnose" tool inside a domain-specific module wants `core`).
   */
  toolOverrides?: Record<string, { group?: ToolGroupId; criticality?: ToolCriticality; riskTag?: RiskTag }>;
  /** Default criticality for tools in this module. Defaults to "normal". */
  criticality?: ToolCriticality;
  /**
   * Default risk classification used by the Phase H emotion gate. When
   * omitted, falls back to the group-default mapping in emotion-gate.ts.
   * Override per-tool via `toolOverrides`.
   */
  riskTag?: RiskTag;
}
