/**
 * Session-scoped approval + repair budget + auth-success tracking for synthesized tools.
 *
 * - Approval gate: non-GET endpoints require user confirmation per (tool, endpoint).
 *   "Allow for session" caches the decision and is persisted across restart.
 *   "Allow once" grants single use, never persisted.
 * - Repair budget: caps native__repair_synthesized_tool to 2 attempts per (tool, endpoint) per session.
 * - Success tracking: records which (tool, endpoint) combinations have ever returned a 2xx in this session,
 *   used by the auth-failure classifier in synthesized-caller.ts.
 *
 * In-memory caches stay for fast lookups; the SQLite mirror in
 * `synthesized-store.ts` is the source of truth across server restarts.
 */

import { randomUUID } from "node:crypto";
import type {
  SynthesizedConfirmData,
  SynthesizedResponseData,
} from "@chvor/shared";
import {
  persistSessionApproval,
  hasSessionApproval as dbHasSessionApproval,
  persistRepairAttempts,
  loadRepairAttempts,
  persistCounter,
  loadCounter,
  loadToolCounter,
  clearRepairAttemptsFor,
} from "../db/synthesized-store.ts";

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

interface PendingApproval {
  resolve: (r: SynthesizedResponseData) => void;
  /** WS clientId that originated the tool call — only this client may respond. */
  targetClientId?: string;
}

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Called by the WS handler when a client responds. Rejects the response if it
 * comes from a WS client other than the one that originated the tool call
 * (prevents another logged-in client from answering your confirm prompt).
 */
export function resolveSynthesizedApproval(
  requestId: string,
  response: SynthesizedResponseData,
  responderClientId?: string,
): boolean {
  const pending = pendingApprovals.get(requestId);
  if (!pending) return false;
  if (pending.targetClientId && responderClientId && pending.targetClientId !== responderClientId) {
    console.warn(
      `[approval-gate] rejected mismatched responder: expected ${pending.targetClientId}, got ${responderClientId}`,
    );
    return false;
  }
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
  pathParams?: Record<string, string | number>;
  queryParams?: Record<string, string | number | boolean>;
  body?: unknown;
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

  // Check existing session approval (only for verified tools).
  // In-memory cache first; DB fallback rehydrates after a server restart.
  if (sessionId && args.verified) {
    const state = getOrCreateSession(sessionId);
    if (state.sessionApprovals.has(approvalKey)) {
      return { allowed: true, persisted: true };
    }
    try {
      if (dbHasSessionApproval(sessionId, args.toolId, args.endpointName)) {
        state.sessionApprovals.add(approvalKey);
        return { allowed: true, persisted: true };
      }
    } catch (err) {
      console.warn("[approval-gate] DB approval lookup failed:", err instanceof Error ? err.message : String(err));
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
      pathParams: args.pathParams,
      queryParams: args.queryParams,
      body: args.body,
      verified: args.verified,
      source: args.source,
      options: args.verified
        ? ["allow-once", "allow-session", "deny"]
        : ["allow-once", "deny"],
      timestamp: new Date().toISOString(),
      timeoutMs: MAX_PENDING,
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
      targetClientId: args.originClientId,
      resolve: (r) => { clearTimeout(timer); resolve(r); },
    });
  });

  if (response.decision === "allow-session" && sessionId && args.verified) {
    const state = getOrCreateSession(sessionId);
    state.sessionApprovals.add(approvalKey);
    try {
      persistSessionApproval(sessionId, args.toolId, args.endpointName);
    } catch (err) {
      console.warn("[approval-gate] DB persist approval failed:", err instanceof Error ? err.message : String(err));
    }
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
  const k = key(toolId, endpointName);
  const cached = state.repairAttempts.get(k);
  if (cached) return cached;
  // Rehydrate from DB on first lookup after restart.
  try {
    const persisted = loadRepairAttempts(sessionId, toolId, endpointName);
    if (persisted) {
      state.repairAttempts.set(k, persisted);
      return persisted;
    }
  } catch (err) {
    console.warn("[approval-gate] DB repair lookup failed:", err instanceof Error ? err.message : String(err));
  }
  return { count: 0, lastError: "" };
}

export function incrementRepairAttempts(
  sessionId: string,
  toolId: string,
  endpointName: string,
  lastError: string,
): number {
  const state = getOrCreateSession(sessionId);
  const k = key(toolId, endpointName);
  const prev = state.repairAttempts.get(k) ?? loadRepairAttempts(sessionId, toolId, endpointName) ?? { count: 0, lastError: "" };
  const count = prev.count + 1;
  state.repairAttempts.set(k, { count, lastError });
  try {
    persistRepairAttempts(sessionId, toolId, endpointName, count, lastError);
  } catch (err) {
    console.warn("[approval-gate] DB persist repair failed:", err instanceof Error ? err.message : String(err));
  }
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
  try {
    clearRepairAttemptsFor(sessionId);
  } catch (err) {
    console.warn("[approval-gate] DB clear repair failed:", err instanceof Error ? err.message : String(err));
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
  const k = key(toolId, endpointName);
  const next = (state.endpointSuccesses.get(k) ?? 0) + 1;
  state.endpointSuccesses.set(k, next);
  try {
    persistCounter(sessionId, "tool-success", toolId, endpointName, next);
  } catch (err) {
    console.warn("[approval-gate] DB persist success failed:", err instanceof Error ? err.message : String(err));
  }
}

export function recordFailure(
  sessionId: string | undefined,
  toolId: string,
  endpointName: string,
): void {
  if (!sessionId) return;
  const state = getOrCreateSession(sessionId);
  state.toolFailures.set(toolId, (state.toolFailures.get(toolId) ?? 0) + 1);
  const k = key(toolId, endpointName);
  const next = (state.endpointFailures.get(k) ?? 0) + 1;
  state.endpointFailures.set(k, next);
  try {
    persistCounter(sessionId, "tool-failure", toolId, endpointName, next);
  } catch (err) {
    console.warn("[approval-gate] DB persist failure failed:", err instanceof Error ? err.message : String(err));
  }
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
  const k = key(toolId, endpointName);

  // Rehydrate per-endpoint counters lazily from DB if the in-memory state was
  // empty (e.g. first call after server restart). Tool-level counters are
  // summed from the per-endpoint rows so they self-heal.
  let endpointSuccess = state.endpointSuccesses.get(k);
  let endpointFailure = state.endpointFailures.get(k);
  if (endpointSuccess === undefined) {
    try {
      endpointSuccess = loadCounter(sessionId, "tool-success", toolId, endpointName);
      state.endpointSuccesses.set(k, endpointSuccess);
    } catch {
      endpointSuccess = 0;
    }
  }
  if (endpointFailure === undefined) {
    try {
      endpointFailure = loadCounter(sessionId, "tool-failure", toolId, endpointName);
      state.endpointFailures.set(k, endpointFailure);
    } catch {
      endpointFailure = 0;
    }
  }

  let toolSuccess = state.toolSuccesses.get(toolId);
  let toolFailure = state.toolFailures.get(toolId);
  if (toolSuccess === undefined) {
    try {
      toolSuccess = loadToolCounter(sessionId, "tool-success", toolId);
      state.toolSuccesses.set(toolId, toolSuccess);
    } catch {
      toolSuccess = 0;
    }
  }
  if (toolFailure === undefined) {
    try {
      toolFailure = loadToolCounter(sessionId, "tool-failure", toolId);
      state.toolFailures.set(toolId, toolFailure);
    } catch {
      toolFailure = 0;
    }
  }

  return {
    toolSuccessCount: toolSuccess,
    toolFailureCount: toolFailure,
    endpointSuccessCount: endpointSuccess,
    endpointFailureCount: endpointFailure,
  };
}
