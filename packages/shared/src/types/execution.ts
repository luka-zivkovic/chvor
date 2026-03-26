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
  | { type: "execution.completed"; data: { output: unknown } }
  | { type: "execution.failed"; data: { error: string } };
