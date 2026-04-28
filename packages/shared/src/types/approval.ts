/**
 * Durable HITL approvals (Phase D4).
 *
 * When the security analyzer flags a tool call as HIGH risk and policy is
 * `request-approval`, the orchestrator persists a pending approval row,
 * emits an InterruptEvent over WS, and pauses the round until the user
 * decides (or the gate times out). Pending rows survive a restart so an
 * approval prompt never silently dies with the server.
 */

import type { SecurityActionKind, SecurityRisk } from "./security.js";

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";

/** What the user (or auto-expire) chose. */
export type ApprovalDecision = "allow-once" | "allow-session" | "deny";

export interface ApprovalRecord {
  id: string;
  sessionId: string | null;
  /** ActionEvent id of the gated call (if one was already emitted). */
  actionId: string | null;
  toolName: string;
  kind: SecurityActionKind;
  /** JSON-serialized args (truncated for storage). */
  args: Record<string, unknown>;
  risk: SecurityRisk;
  /** Human-readable analyzer reasons, joined with " | ". */
  reasons: string[];
  /** OrchestratorCheckpoint id captured when the gate fired (for replay). */
  checkpointId: string | null;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  decidedAt: number | null;
  /** "user" | "auto-expire" | "system". */
  decidedBy: string | null;
  createdAt: number;
  expiresAt: number;
}

/**
 * Canvas / WS event emitted when an approval is requested. The UI uses
 * this to render the prompt; the user's response comes back as either a
 * REST POST to `/api/approvals/:id/decide` or an `approval.respond` WS
 * message — both flows hit `resolveApproval()`.
 */
export interface ApprovalRequestedEvent {
  approvalId: string;
  sessionId: string | null;
  actionId: string | null;
  toolName: string;
  kind: SecurityActionKind;
  argsPreview: string;
  risk: SecurityRisk;
  reasons: string[];
  checkpointId: string | null;
  expiresAt: number;
  options: ApprovalDecision[];
}

/** WS message body for an approval response. */
export interface ApprovalResponseData {
  approvalId: string;
  decision: ApprovalDecision;
}
