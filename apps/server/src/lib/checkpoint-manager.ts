import type {
  OrchestratorCheckpointSnapshot,
  ToolBagScope,
} from "@chvor/shared";
import { appendCheckpoint } from "../db/checkpoint-store.ts";
import { startPeriodicJob, stopPeriodicJob } from "./job-runner.ts";
import { pruneCheckpointsOlderThan } from "../db/checkpoint-store.ts";

/**
 * Phase D3 — orchestrator round checkpointer (snapshot-only).
 *
 * Captures one row per LLM round so every turn becomes inspectable:
 *   - which skill bag was active
 *   - which emotion bucket the gate landed in
 *   - which tools fired and what outcome they produced
 *   - which model handled the round
 *   - the recent-tools window used for co-activation scoring
 *
 * The orchestrator stays simple: a single `snapshotRound(...)` call per
 * round. Failures are absorbed; checkpointing must never break a turn.
 *
 * `CHVOR_CHECKPOINT_DISABLE` env var lets ops opt out (default: enabled).
 */

export function isCheckpointingEnabled(): boolean {
  const raw = (process.env.CHVOR_CHECKPOINT_DISABLE ?? "0").toLowerCase();
  return !["1", "true", "on", "yes"].includes(raw);
}

export interface SnapshotRoundArgs {
  sessionId: string | undefined;
  round: number;
  bagScope: ToolBagScope;
  bagToolCount: number;
  emotion: OrchestratorCheckpointSnapshot["emotion"];
  model: OrchestratorCheckpointSnapshot["model"];
  ranking: OrchestratorCheckpointSnapshot["ranking"];
  toolOutcomes: OrchestratorCheckpointSnapshot["toolOutcomes"];
  recentTools: string[];
  messages: OrchestratorCheckpointSnapshot["messages"];
  memoryIds: string[];
}

/**
 * Persist a round snapshot. Returns the checkpoint id, or null on any
 * failure (disabled, missing session id, DB error).
 */
export function snapshotRound(args: SnapshotRoundArgs): string | null {
  if (!isCheckpointingEnabled()) return null;
  if (!args.sessionId) return null;

  const snapshot: OrchestratorCheckpointSnapshot = {
    round: args.round,
    bag: {
      groups: Array.from(args.bagScope.groups).sort(),
      contributingSkills: [...args.bagScope.contributingSkills].sort(),
      isPermissive: args.bagScope.isPermissive,
      permissiveReason: args.bagScope.permissiveReason,
      deniedTools: Array.from(args.bagScope.deniedTools).sort(),
      requiredTools: Array.from(args.bagScope.requiredTools).sort(),
      toolCount: args.bagToolCount,
    },
    emotion: args.emotion,
    model: args.model,
    // Cap the ranking we persist to keep checkpoints small (~1–4 KB).
    ranking: args.ranking.slice(0, 12),
    toolOutcomes: args.toolOutcomes,
    recentTools: args.recentTools.slice(0, 20),
    messages: args.messages,
    memoryIds: args.memoryIds.slice(0, 30),
  };

  return appendCheckpoint(args.sessionId, snapshot);
}

// ── Periodic prune job ────────────────────────────────────────

/** Default 7 days; override via CHVOR_CHECKPOINT_RETENTION_DAYS. */
export function getRetentionMs(): number {
  const raw = process.env.CHVOR_CHECKPOINT_RETENTION_DAYS;
  const days = raw ? Number(raw) : 7;
  const safe = Number.isFinite(days) && days > 0 ? days : 7;
  return safe * 24 * 60 * 60 * 1000;
}

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h

function runPrune(): void {
  try {
    const removed = pruneCheckpointsOlderThan(getRetentionMs());
    if (removed > 0) {
      console.log(`[checkpoint-prune] removed ${removed} old checkpoint(s)`);
    }
  } catch (err) {
    console.warn(
      "[checkpoint-prune] pass failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

export function startCheckpointPrune(): void {
  startPeriodicJob({
    id: "orchestrator-checkpoint-prune",
    intervalMs: PRUNE_INTERVAL_MS,
    run: runPrune,
  });
}

export function stopCheckpointPrune(): void {
  stopPeriodicJob("orchestrator-checkpoint-prune");
}
