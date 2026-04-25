/**
 * Typed audit events for orchestrator actions and observations.
 *
 * ActionEvent is written before a tool is invoked. ObservationEvent is written
 * after the tool finishes (success or error) and references its ActionEvent.
 * The pair is the durable audit trail; the brain-canvas ExecutionEvent stream
 * is a separate, transient UI channel.
 */

export type ActionKind =
  | "tool_invoke"
  | "native"
  | "pc_control"
  | "knowledge_ingest"
  | "memory_recall"
  | "credential_use"
  | "synthesized_call"
  | "mcp_call";

export type ObservationKind = "result" | "error" | "partial";

export type ActorType = "session" | "apikey" | "daemon" | "webhook" | "system";

export interface ActionEvent {
  id: string;
  sessionId: string | null;
  kind: ActionKind;
  tool: string;
  args: Record<string, unknown>;
  ts: number;
  actorType: ActorType;
  actorId: string | null;
  parentActionId: string | null;
}

export interface ObservationEvent {
  id: string;
  sessionId: string | null;
  actionId: string;
  kind: ObservationKind;
  payload: unknown;
  ts: number;
  durationMs: number;
}

/** Normalized audit-log row — one per security-relevant operation. */
export interface AuditLogEntry {
  id: string;
  eventType: string;
  actorType: ActorType;
  actorId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  action: string | null;
  httpMethod: string | null;
  httpPath: string | null;
  httpStatusCode: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}
