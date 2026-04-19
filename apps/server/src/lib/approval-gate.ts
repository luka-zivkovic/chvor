/**
 * Session-scoped approval + repair budget + auth-success tracking for synthesized tools.
 *
 * - Approval gate: non-GET endpoints require user confirmation per (tool, endpoint).
 *   "Allow for session" caches the decision in memory only. "Allow once" grants single use.
 * - Repair budget: caps native__repair_synthesized_tool to 2 attempts per (tool, endpoint) per session.
 * - Success tracking: records which (tool, endpoint) combinations have ever returned a 2xx in this session,
 *   used by the auth-failure classifier in synthesized-caller.ts.
 *
 * All state is in-memory and evaporates on server restart.
 */

import { randomUUID } from "node:crypto";
import type {
  SynthesizedConfirmData,
  SynthesizedResponseData,
} from "@chvor/shared";

// ── Session state ──────────────────────────────────────────────

interface SessionState {
  /** Allowed (toolId::endpointName) pairs — session-scoped approvals. */
  sessionApprovals: Set<string>;
  /** Repair attempts per (toolId::endpointName). */
  repairAttempts: Map<string, { count: number; lastError: string }>;
  /** Success counts per toolId and per endpoint. */
  toolSuccesses: Map<string, number>;
  endpointSuccesses: Map<string, number>;
  /** Auth failures per toolId and per endpoint (for classifier). */
  toolFailures: Map<string, number>;
  endpointFailures: Map<string, number>;
}

const sessions = new Map<string, SessionState>();

function getOrCreateSession(sessionId: string): SessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = {
      sessionApprovals: new Set(),
      repairAttempts: new Map(),
      toolSuccesses: new Map(),
      endpointSuccesses: new Map(),
      toolFailures: new Map(),
      endpointFailures: new Map(),
    };
    sessions.set(sessionId, state);
  }
  return state;
}

function key(toolId: string, endpointName: string): string {
  return `${toolId}::${endpointName}`;
}

// ── Approval gate ──────────────────────────────────────────────

const MAX_PENDING = 5 * 60_000;

const pendingApprovals = new Map<
  string,
  { resolve: (r: SynthesizedResponseData) => void }
>();

/** Called by the WS handler when the client responds. */
export function resolveSynthesizedApproval(
  requestId: string,
  response: SynthesizedResponseData,
): boolean {
  const pending = pendingApprovals.get(requestId);
  if (!pending) return false;
  pendingApprovals.delete(requestId);
  pending.resolve(response);
  return true;
}

export interface RequestApprovalArgs {
  sessionId?: string;
  originClientId?: string;
  toolId: string;
  toolName: string;
  endpointName: string;
  method: string;
  path: string;
  resolvedUrl: string;
  argsPreview: string;
  verified: boolean;
  source: "openapi" | "ai-draft";
}

/**
 * Ask the user to approve a non-GET synthesized call. Returns true if allowed.
 * verified: false tools never get the session-wide approval shortcut — prompt every time.
 */
export async function requestApproval(args: RequestApprovalArgs): Promise<
  | { allowed: true; persisted: boolean }
  | { allowed: false; reason: "denied" | "no-ws" | "timeout" }
> {
  const { sessionId } = args;
  const approvalKey = key(args.toolId, args.endpointName);

  // Check existing session approval (only for verified tools)
  if (sessionId && args.verified) {
    const state = getOrCreateSession(sessionId);
    if (state.sessionApprovals.has(approvalKey)) {
      return { allowed: true, persisted: true };
    }
  }

  const { getWSInstance } = await import("../gateway/ws-instance.ts");
  const ws = getWSInstance();
  if (!ws) {
    return { allowed: false, reason: "no-ws" };
  }

  const requestId = randomUUID();
  const event: import("@chvor/shared").GatewayServerEvent = {
    type: "synthesized.confirm",
    data: {
      requestId,
      toolId: args.toolId,
      toolName: args.toolName,
      endpointName: args.endpointName,
      method: args.method,
      path: args.path,
      resolvedUrl: args.resolvedUrl,
      argsPreview: args.argsPreview,
      verified: args.verified,
      source: args.source,
      options: args.verified
        ? ["allow-once", "allow-session", "deny"]
        : ["allow-once", "deny"],
      timestamp: new Date().toISOString(),
    } satisfies SynthesizedConfirmData,
  };

  if (args.originClientId) {
    ws.sendTo(args.originClientId, event);
  } else {
    ws.broadcast(event);
  }

  const response = await new Promise<SynthesizedResponseData>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId);
      resolve({ requestId, decision: "deny" });
    }, MAX_PENDING);
    pendingApprovals.set(requestId, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
    });
  });

  if (response.decision === "allow-session" && sessionId && args.verified) {
    const state = getOrCreateSession(sessionId);
    state.sessionApprovals.add(approvalKey);
    return { allowed: true, persisted: true };
  }
  if (response.decision === "allow-once") {
    return { allowed: true, persisted: false };
  }
  return { allowed: false, reason: response.decision === "deny" ? "denied" : "timeout" };
}

// ── Repair budget ──────────────────────────────────────────────

const REPAIR_BUDGET_LIMIT = 2;

export function getRepairAttempts(
  sessionId: string,
  toolId: string,
  endpointName: string,
): { count: number; lastError: string } {
  const state = getOrCreateSession(sessionId);
  return state.repairAttempts.get(key(toolId, endpointName)) ?? { count: 0, lastError: "" };
}

export function incrementRepairAttempts(
  sessionId: string,
  toolId: string,
  endpointName: string,
  lastError: string,
): number {
  const state = getOrCreateSession(sessionId);
  const k = key(toolId, endpointName);
  const prev = state.repairAttempts.get(k);
  const count = (prev?.count ?? 0) + 1;
  state.repairAttempts.set(k, { count, lastError });
  return count;
}

export function isRepairBudgetExhausted(
  sessionId: string,
  toolId: string,
  endpointName: string,
): boolean {
  return getRepairAttempts(sessionId, toolId, endpointName).count >= REPAIR_BUDGET_LIMIT;
}

export function resetRepairBudget(sessionId?: string): void {
  if (sessionId) {
    const state = sessions.get(sessionId);
    if (state) state.repairAttempts.clear();
  } else {
    for (const state of sessions.values()) state.repairAttempts.clear();
  }
}

// ── Success / failure tracking ─────────────────────────────────

export function recordSuccess(
  sessionId: string | undefined,
  toolId: string,
  endpointName: string,
): void {
  if (!sessionId) return;
  const state = getOrCreateSession(sessionId);
  state.toolSuccesses.set(toolId, (state.toolSuccesses.get(toolId) ?? 0) + 1);
  state.endpointSuccesses.set(key(toolId, endpointName), (state.endpointSuccesses.get(key(toolId, endpointName)) ?? 0) + 1);
}

export function recordFailure(
  sessionId: string | undefined,
  toolId: string,
  endpointName: string,
): void {
  if (!sessionId) return;
  const state = getOrCreateSession(sessionId);
  state.toolFailures.set(toolId, (state.toolFailures.get(toolId) ?? 0) + 1);
  state.endpointFailures.set(key(toolId, endpointName), (state.endpointFailures.get(key(toolId, endpointName)) ?? 0) + 1);
}

export interface SessionStats {
  toolSuccessCount: number;
  toolFailureCount: number;
  endpointSuccessCount: number;
  endpointFailureCount: number;
}

export function getSessionStats(
  sessionId: string | undefined,
  toolId: string,
  endpointName: string,
): SessionStats {
  if (!sessionId) {
    return { toolSuccessCount: 0, toolFailureCount: 0, endpointSuccessCount: 0, endpointFailureCount: 0 };
  }
  const state = getOrCreateSession(sessionId);
  return {
    toolSuccessCount: state.toolSuccesses.get(toolId) ?? 0,
    toolFailureCount: state.toolFailures.get(toolId) ?? 0,
    endpointSuccessCount: state.endpointSuccesses.get(key(toolId, endpointName)) ?? 0,
    endpointFailureCount: state.endpointFailures.get(key(toolId, endpointName)) ?? 0,
  };
}
