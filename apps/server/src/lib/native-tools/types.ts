import type { tool } from "ai";
import type { ExecutionEvent } from "@chvor/shared";

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
}
