export type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type NodeExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface NodeExecutionState {
  nodeId: string;
  status: NodeExecutionStatus;
  startedAt?: string;
  completedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface ExecutionState {
  id: string;
  workspaceId: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt?: string;
  nodeStates: Record<string, NodeExecutionState>;
  finalOutput?: unknown;
  error?: string;
}

import type { EmotionState, EmotionSnapshot } from "./emotion.js";
import type { CommandTier } from "./shell.js";
import type { MemoryCategory, EdgeRelation } from "./memory.js";

export interface MemoryRetrievalTraceEntry {
  memoryId: string;
  abstract: string;
  category: MemoryCategory;
  scores: {
    vector: number;
    strength: number;
    recency: number;
    categoryRelevance: number;
    emotionalResonance: number | null;
    composite: number;
  };
  source: "direct" | "associated" | "predicted";
  relation?: EdgeRelation;
  rank: number;
}

export interface MemoryRetrievalTrace {
  queryText?: string; // omitted from broadcast to prevent leaking user messages
  categoriesDetected: MemoryCategory[];
  totalCandidates: number;
  entries: MemoryRetrievalTraceEntry[];
  durationMs: number;
}

export type ExecutionEvent =
  | { type: "execution.started"; data: { executionId: string } }
  | { type: "brain.thinking"; data: { thought: string } }
  | { type: "brain.decision"; data: { skillId?: string; toolId?: string; capabilityKind: "skill" | "tool"; reason: string } }
  | { type: "brain.emotion"; data: EmotionState | EmotionSnapshot }
  | { type: "skill.invoked"; data: { nodeId: string; skillId: string; isApiConnection?: boolean } }
  | { type: "skill.output"; data: { nodeId: string; chunk: string } }
  | { type: "skill.completed"; data: { nodeId: string; output: unknown; media?: import("./message.js").MediaArtifact[] } }
  | { type: "skill.failed"; data: { nodeId: string; error: string } }
  | { type: "tool.invoked"; data: { nodeId: string; toolId: string } }
  | { type: "tool.output"; data: { nodeId: string; chunk: string } }
  | { type: "tool.completed"; data: { nodeId: string; output: unknown; media?: import("./message.js").MediaArtifact[] } }
  | { type: "tool.failed"; data: { nodeId: string; error: string } }
  // Memory events (cognitive memory system)
  | { type: "memory.recalled"; data: { memoryId: string; abstract: string; strength: number; source: "direct" | "associated" } }
  | { type: "memory.created"; data: { memoryId: string; abstract: string; category: MemoryCategory } }
  | { type: "memory.consolidated"; data: { newMemoryId: string; sourceCount: number; insight: string } }
  | { type: "memory.contradiction"; data: { oldId: string; newId: string; abstract: string } }
  | { type: "memory.decayed"; data: { memoryId: string; oldStrength: number; newStrength: number } }
  | { type: "memory.retrieval_trace"; data: MemoryRetrievalTrace }
  | { type: "shell.waiting"; data: { nodeId: string } }
  | { type: "shell.approved"; data: { nodeId: string } }
  | { type: "shell.denied"; data: { nodeId: string } }
  | { type: "pipeline.step"; data: { edgeId: string; toNodeId: string } }
  | { type: "pipeline.stepCompleted"; data: { edgeId: string; nodeId: string } }
  | { type: "pc.action"; data: { agentId: string; action: import("./pc-control.js").PcActionType; coordinate?: [number, number] } }
  | { type: "pc.screenshot"; data: { agentId: string } }
  | { type: "pc.actionCompleted"; data: { agentId: string; success: boolean; error?: string } }
  | { type: "pc.pipeline.start"; data: { targetId: string; task: string } }
  | { type: "pc.pipeline.layer"; data: { targetId: string; layer: import("./pc-control.js").PipelineLayer; status: "trying" | "success" | "fallthrough" } }
  | { type: "pc.pipeline.complete"; data: { targetId: string; layer: import("./pc-control.js").PipelineLayer; success: boolean } }
  | { type: "sandbox.started"; data: { nodeId: string; language: import("./sandbox.js").SandboxLanguage } }
  | { type: "sandbox.completed"; data: { nodeId: string; exitCode: number; durationMs: number } }
  | { type: "sandbox.failed"; data: { nodeId: string; error: string } }
  | { type: "execution.tokenBudget"; data: TokenBudgetInfo }
  | { type: "execution.completed"; data: { output: unknown } }
  | { type: "execution.failed"; data: { error: string } }
  | { type: "tool.bag.resolved"; data: ToolBagResolvedEvent }
  | { type: "credential.resolved"; data: CredentialResolvedEvent }
  | { type: "security.verdict"; data: import("./security.js").SecurityVerdictEvent }
  | { type: "tool.graph.observed"; data: ToolGraphObservedEvent }
  | { type: "tool.bag.emotion-gated"; data: import("./emotion-gate.js").EmotionGatedToolsEvent }
  | { type: "tool.bag.ranked"; data: ToolBagRankedEvent };

/** Per-turn rationale for graph-driven bag ordering (Phase G+). */
export interface ToolBagRankedEvent {
  /** Top-N entries with their per-signal score breakdown — useful for the canvas debug drawer. */
  top: Array<{
    toolName: string;
    composite: number;
    strength: number;
    coActivation: number;
    semantic: number;
    category: number;
  }>;
  /** Total tools the resolver considered. */
  totalRanked: number;
  /** Recent successful tool names used for co-activation scoring. */
  recentTools: string[];
  /** True when the embedder contributed at least one semantic score. */
  semanticActive: boolean;
}

/** Per-call rationale from the Cognitive Tool Graph (Phase G). */
export interface ToolGraphObservedEvent {
  toolName: string;
  success: boolean;
  /** Strength before and after the update — lets the canvas animate the bar. */
  strengthBefore: number;
  strengthAfter: number;
  /** Total successful invocations so far. */
  successCount: number;
  /** Total failed invocations so far. */
  failureCount: number;
  /** Hebbian edges bumped this call (canonical pair keys). */
  edgesBumped: Array<{ a: string; b: string }>;
  /** Whether the node is still in its trial-boost window. */
  inTrialBoost: boolean;
}

/** Per-pick rationale for which credential ended up resolving `{{credentials.X}}`. */
export interface CredentialResolvedEvent {
  /** Credential type (e.g. "github", "openai"). */
  credentialType: string;
  /** ID of the credential the picker chose. */
  credentialId: string;
  /** Human-readable name of the credential ("Work GitHub"). */
  credentialName: string;
  /** Why the picker landed here. */
  reason:
    | "tool-pinned"
    | "session-pin"
    | "context-match"
    | "single-match"
    | "first-match-fallback";
  /** Total candidates of this type the picker chose from. */
  candidateCount: number;
  /** Whether this happened on the synth-call hot path or at MCP spawn. */
  surface: "synthesized" | "mcp" | "native";
  /** Optional short detail for the canvas — never includes secret values. */
  detail?: string;
}

/** Per-turn rationale for which tools landed in the LLM's choice set. */
export interface ToolBagResolvedEvent {
  /** Active group IDs contributing to the bag (may include "*" for permissive). */
  groups: string[];
  /** Explicit tool names required regardless of group. */
  requiredTools: string[];
  /** Tool names explicitly excluded. */
  deniedTools: string[];
  /** True when no skill declared scoping → fall back to legacy inject-all. */
  isPermissive: boolean;
  /** Why permissive (only set when isPermissive=true). */
  permissiveReason?: string;
  /** IDs of skills that contributed declarations to this scope. */
  contributingSkills: string[];
  /** Total tools in the final bag handed to the LLM. */
  toolCount: number;
}

export interface TokenBudgetInfo {
  contextWindow: number;
  systemTokens: number;
  toolTokens: number;
  messageBudget: number;
  messagesTotal: number;
  messagesTruncated: number;
}
