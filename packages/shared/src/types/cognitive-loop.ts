// ─── Cognitive Loop Types ──────────────────────────────────

export type CognitiveLoopStatus = "running" | "paused" | "completed" | "failed";
export type CognitiveLoopSeverity = "warning" | "critical" | "info";

export type CognitiveLoopStage =
  | "playbook.started"
  | "playbook.step.started"
  | "playbook.step.completed"
  | "playbook.action.requested"
  | "pulse.detected"
  | "a2ui.action.received"
  | "memory.consolidation.started"
  | "memory.consolidation.skipped"
  | "memory.insight.created"
  | "memory.consolidation.completed"
  | "daemon.task.queued"
  | "daemon.task.started"
  | "daemon.task.completed"
  | "daemon.task.failed"
  | "tool.synthesized"
  | "a2ui.surface.pinned"
  | "loop.paused"
  | "loop.resumed"
  | "loop.completed"
  | "loop.failed";

export interface CognitiveLoopRun {
  id: string;
  title: string;
  status: CognitiveLoopStatus;
  severity: CognitiveLoopSeverity;
  trigger: "pulse" | "a2ui" | "daemon" | "manual" | "system";
  summary: string;
  currentStage: CognitiveLoopStage | null;
  surfaceId: string | null;
  parentLoopId: string | null;
  parentEventId: string | null;
  branchReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CognitiveLoopEvent {
  id: string;
  loopId: string;
  stage: CognitiveLoopStage;
  title: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  ts: string;
}

export interface CognitiveLoopWithEvents {
  run: CognitiveLoopRun;
  events: CognitiveLoopEvent[];
}
