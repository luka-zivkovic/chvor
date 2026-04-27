/**
 * Pluggable security-analysis layer (Phase D1).
 *
 * Native, MCP, and synthesized tool calls funnel through the same analyzer
 * registry before execution. Each analyzer returns a {@link SecurityVerdict}
 * with a risk level and reason. The aggregator returns the maximum risk
 * across all analyzers. Orchestrator policy decides what to do with HIGH
 * (block + tell LLM, vs request HITL approval).
 */

export type SecurityRisk = "low" | "medium" | "high";

export type SecurityActionKind = "native" | "mcp" | "synthesized" | "pc_control" | "shell";

/**
 * Subset of an action passed to security analyzers. Kept small + JSON-safe so
 * analyzers can be ported to a worker / LLM service later without dragging
 * orchestrator types along.
 */
export interface SecurityActionContext {
  /** Type of underlying tool. */
  kind: SecurityActionKind;
  /** Qualified tool name as the LLM saw it (e.g. "native__shell_execute"). */
  toolName: string;
  /** For MCP/synthesized: the toolId portion (before "__"). */
  toolId?: string;
  /** For MCP/synthesized: the endpoint/method portion. */
  endpointName?: string;
  /** Tool group (when known). */
  group?: import("./tool-group.js").ToolGroupId;
  /** Args object as the LLM produced it. May contain user-controlled strings. */
  args: Record<string, unknown>;
  /** Session id of the calling conversation, when available. */
  sessionId?: string;
  /** Actor classification (session / apikey / daemon / webhook). */
  actorType?: "session" | "apikey" | "daemon" | "webhook" | "system";
}

export interface SecurityVerdict {
  risk: SecurityRisk;
  /** Stable id of the analyzer that returned this verdict. */
  analyzer: string;
  /** Short, user-facing rationale. */
  reason: string;
  /** Optional structured details for the audit log + canvas event. */
  details?: Record<string, unknown>;
  /** Optional suggested replacement args (HITL "edit-before-execute" hook). */
  suggestedEdit?: Record<string, unknown>;
}

/** Aggregated verdict across all registered analyzers. */
export interface AggregatedSecurityVerdict {
  /** Max risk across all individual verdicts. */
  risk: SecurityRisk;
  /** Every verdict — kept for audit / debug, not just the worst. */
  verdicts: SecurityVerdict[];
  /** Convenience: which verdicts contributed to the max risk. */
  highest: SecurityVerdict[];
  /** True when chvor decided to block execution based on policy. */
  blocked: boolean;
}

/**
 * Canvas event emitted for every analyzer pass — even LOW-risk verdicts get
 * a row so users can see the gate worked. Keeps the brain canvas honest.
 */
export interface SecurityVerdictEvent {
  toolName: string;
  kind: SecurityActionKind;
  risk: SecurityRisk;
  blocked: boolean;
  reasons: Array<{ analyzer: string; risk: SecurityRisk; reason: string }>;
}
