import type { ActionKind, ActorType, ObservationKind } from "@chvor/shared";
import { appendAction, appendObservation } from "../db/event-store.ts";
import { appendAudit } from "../db/audit-log-store.ts";
import { redactSensitiveData } from "./sensitive-filter.ts";

/**
 * Event bus: the single entry point for persisting typed ActionEvent /
 * ObservationEvent pairs. Thin wrapper around the DB stores; future phases
 * (checkpoints, canvas fan-out, multi-agent handoff) subscribe here.
 *
 * Keep this file tiny and side-effect-light. All persistence is synchronous
 * (better-sqlite3 is sync) so orchestrator code can keep its linear flow.
 */

/**
 * Run a payload through the sensitive-data redactor before it lands in the
 * audit store. Synthesized OpenAPI and MCP tools can return secrets in
 * response bodies (token endpoints, config dumps); we don't want those in
 * action_events/observation_events. JSON-roundtrip preserves shape; if a
 * payload isn't JSON-serializable it passes through unchanged.
 */
function redactPayloadForAudit(payload: unknown): unknown {
  if (payload === undefined || payload === null) return payload;
  try {
    const json = JSON.stringify(payload);
    const redacted = redactSensitiveData(json);
    if (redacted === json) return payload;
    return JSON.parse(redacted);
  } catch {
    return payload;
  }
}

export interface ActionContext {
  sessionId: string | null;
  actorType?: ActorType;
  actorId?: string | null;
  parentActionId?: string | null;
}

export interface ActionHandle {
  actionId: string;
  sessionId: string | null;
  startedAt: number;
}

/**
 * Record an action being taken. Returns a handle the caller threads into
 * `finishAction` / `failAction` so the observation pairs up.
 */
export function beginAction(
  kind: ActionKind,
  tool: string,
  args: Record<string, unknown>,
  ctx: ActionContext
): ActionHandle {
  const { id, ts } = appendAction({
    sessionId: ctx.sessionId,
    kind,
    tool,
    args,
    actorType: ctx.actorType ?? "session",
    actorId: ctx.actorId ?? null,
    parentActionId: ctx.parentActionId ?? null,
  });
  return { actionId: id, sessionId: ctx.sessionId, startedAt: ts };
}

/** Record a successful observation for a prior action. */
export function finishAction(handle: ActionHandle, payload: unknown): void {
  const durationMs = Date.now() - handle.startedAt;
  appendObservation({
    sessionId: handle.sessionId,
    actionId: handle.actionId,
    kind: "result",
    payload: redactPayloadForAudit(payload),
    durationMs,
  });
}

/** Record a failed observation (error) for a prior action. */
export function failAction(handle: ActionHandle, error: unknown): void {
  const durationMs = Date.now() - handle.startedAt;
  const message = error instanceof Error ? error.message : String(error);
  appendObservation({
    sessionId: handle.sessionId,
    actionId: handle.actionId,
    kind: "error",
    payload: { error: redactSensitiveData(message) },
    durationMs,
  });
}

/** Record a partial/progress observation mid-flight (optional). */
export function progressAction(handle: ActionHandle, payload: unknown): void {
  appendObservation({
    sessionId: handle.sessionId,
    actionId: handle.actionId,
    kind: "partial",
    payload: redactPayloadForAudit(payload),
    durationMs: Date.now() - handle.startedAt,
  });
}

/** Thin re-export so callers can log security-relevant events without a second import. */
export { appendAudit };
