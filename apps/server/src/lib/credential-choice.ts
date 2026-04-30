import { randomUUID } from "node:crypto";
import type {
  CredentialChoiceCandidate,
  CredentialChoiceResponseData,
  GatewayServerEvent,
} from "@chvor/shared";
import { listCredentials } from "../db/credential-store.ts";
import { setSessionPin } from "../db/session-pin-store.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

interface PendingCredentialChoice {
  requestId: string;
  sessionId: string;
  credentialType: string;
  candidateIds: Set<string>;
  targetClientId?: string;
  resolve: (response: CredentialChoiceResponseData | "expired") => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

const pending = new Map<string, PendingCredentialChoice>();

function getTimeoutMs(): number {
  const raw = process.env.CHVOR_CREDENTIAL_CHOICE_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 1000) return DEFAULT_TIMEOUT_MS;
  return ms;
}

function candidateSummaries(
  credentialType: string,
  candidateIds?: string[]
): CredentialChoiceCandidate[] {
  const allowed = candidateIds && candidateIds.length > 0 ? new Set(candidateIds) : null;
  return listCredentials()
    .filter((c) => c.type === credentialType)
    .filter((c) => !allowed || allowed.has(c.id))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      usageContext: c.usageContext,
      testStatus: c.testStatus,
    }));
}

export type CredentialChoiceOutcome =
  | { ok: true; credentialId: string; action: "use-once" | "pin-session"; credentialName: string }
  | { ok: false; reason: "cancelled" | "expired" | "no-candidates" | "no-active-ui" };

export interface RequestCredentialChoiceArgs {
  sessionId: string;
  originClientId?: string;
  credentialType: string;
  candidateIds?: string[];
  toolName?: string;
  reason: string;
}

/**
 * Ask the user to choose between same-type credentials when automatic picker
 * signals are ambiguous. This is intentionally metadata-only: the LLM/UI sees
 * ids, names, type, usage_context, and test status, never field values.
 */
export async function requestCredentialChoice(
  args: RequestCredentialChoiceArgs
): Promise<CredentialChoiceOutcome> {
  const candidates = candidateSummaries(args.credentialType, args.candidateIds);
  if (candidates.length === 0) return { ok: false, reason: "no-candidates" };

  const requestId = randomUUID();
  const timeoutMs = getTimeoutMs();

  const responsePromise = new Promise<CredentialChoiceResponseData | "expired">((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve("expired");
    }, timeoutMs);
    pending.set(requestId, {
      requestId,
      sessionId: args.sessionId,
      credentialType: args.credentialType,
      candidateIds: new Set(candidates.map((c) => c.id)),
      targetClientId: args.originClientId,
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      timer,
      createdAt: Date.now(),
    });
  });

  const event: GatewayServerEvent = {
    type: "credential.choice.request",
    data: {
      requestId,
      sessionId: args.sessionId,
      credentialType: args.credentialType,
      toolName: args.toolName,
      reason: args.reason,
      candidates,
      timeoutMs,
      timestamp: new Date().toISOString(),
    },
  };

  let delivered = false;
  try {
    const { getWSInstance } = await import("../gateway/ws-instance.ts");
    const ws = getWSInstance();
    if (ws) {
      if (args.originClientId) {
        delivered = ws.sendTo(args.originClientId, event);
      } else {
        delivered = ws.getClientsBySessionId(args.sessionId).length > 0;
        if (delivered) ws.broadcastToSession(args.sessionId, event);
      }
    }
  } catch (err) {
    console.warn(
      "[credential-choice] failed to emit credential.choice.request:",
      err instanceof Error ? err.message : String(err)
    );
  }

  if (!delivered) {
    const handle = pending.get(requestId);
    if (handle) {
      pending.delete(requestId);
      clearTimeout(handle.timer);
      handle.resolve("expired");
    }
    return { ok: false, reason: "no-active-ui" };
  }

  const response = await responsePromise;
  if (response === "expired") return { ok: false, reason: "expired" };
  if (response.action === "cancel") return { ok: false, reason: "cancelled" };

  const selected = candidates.find((c) => c.id === response.credentialId);
  if (!selected) return { ok: false, reason: "cancelled" };

  if (response.action === "pin-session") {
    setSessionPin(args.sessionId, args.credentialType, selected.id);
  }

  return {
    ok: true,
    credentialId: selected.id,
    credentialName: selected.name,
    action: response.action,
  };
}

export function resolveCredentialChoice(
  response: CredentialChoiceResponseData,
  responderClientId?: string
): { ok: true } | { ok: false; reason: "not-found" | "responder-mismatch" | "invalid-choice" } {
  const handle = pending.get(response.requestId);
  if (!handle) return { ok: false, reason: "not-found" };
  if (handle.targetClientId && handle.targetClientId !== responderClientId) {
    return { ok: false, reason: "responder-mismatch" };
  }
  if (
    response.action !== "cancel" &&
    (!response.credentialId || !handle.candidateIds.has(response.credentialId))
  ) {
    return { ok: false, reason: "invalid-choice" };
  }
  pending.delete(response.requestId);
  handle.resolve(response);
  return { ok: true };
}

/** Test/debug helper: safe metadata only. */
export function listPendingCredentialChoices(): Array<{
  requestId: string;
  sessionId: string;
  credentialType: string;
  candidateIds: string[];
  createdAt: number;
}> {
  return Array.from(pending.values()).map((p) => ({
    requestId: p.requestId,
    sessionId: p.sessionId,
    credentialType: p.credentialType,
    candidateIds: Array.from(p.candidateIds),
    createdAt: p.createdAt,
  }));
}
