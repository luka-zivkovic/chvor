/**
 * Orchestrator round checkpoints (Phase D3).
 *
 * One snapshot per LLM round captures the orchestrator's view of the world
 * at that moment — bag scope, emotion bucket, model used, tool outcomes,
 * recent-tools window. Used for replay / forensics / debugging today;
 * future PR will let `POST /api/sessions/:id/resume?checkpoint=<id>`
 * rehydrate a session from one with possibly-edited args.
 *
 * State stays small + JSON-friendly: no full message history, no LLM
 * outputs, no payloads. Just the orchestrator decisions that shaped the
 * round.
 */

export interface OrchestratorCheckpointSummary {
  id: string;
  sessionId: string;
  round: number;
  createdAt: number;
}

export interface OrchestratorCheckpointSnapshot {
  /** Zero-based round index within the session's current turn. */
  round: number;

  /** Skill-scoped tool-bag floor summary (Phase C). */
  bag: {
    groups: string[];
    contributingSkills: string[];
    isPermissive: boolean;
    permissiveReason?: string;
    deniedTools: string[];
    requiredTools: string[];
    toolCount: number;
  };

  /** Emotion-modulated risk gate state (Phase H). */
  emotion: {
    bucket: "collaborative" | "neutral" | "frustrated" | "hostile";
    vad: { valence: number; arousal: number; dominance: number } | null;
    maskedToolCount: number;
  } | null;

  /** Model the LLM call landed on this round. */
  model: { providerId: string; model: string; wasFallback: boolean };

  /** Top of the Cognitive Tool Graph ranking handed to the LLM (Phase G+). */
  ranking: Array<{
    toolName: string;
    composite: number;
  }>;

  /** Tool outcomes recorded during this round. */
  toolOutcomes: Array<{
    toolName: string;
    success: boolean;
  }>;

  /** Recent-successful-tool window used as input to co-activation scoring. */
  recentTools: string[];

  /**
   * Number of fitted vs total messages from `executeConversation`'s
   * token-budget pass. Lets a replay UI show how much history was
   * truncated for this round.
   */
  messages: { total: number; fitted: number };

  /**
   * Memory IDs activated during the round (no content — that's still in
   * memory_nodes). Lets replay link a checkpoint to the memory layer.
   */
  memoryIds: string[];
}

export interface OrchestratorCheckpoint extends OrchestratorCheckpointSummary {
  state: OrchestratorCheckpointSnapshot;
}
