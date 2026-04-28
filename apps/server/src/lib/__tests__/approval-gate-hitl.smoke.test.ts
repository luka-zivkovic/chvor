import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route the DB to a throwaway temp dir before anything loads the singleton.
const tmp = mkdtempSync(join(tmpdir(), "chvor-hitl-"));
process.env.CHVOR_DATA_DIR = tmp;
// Tight timeout so the auto-expire path runs quickly under test.
process.env.CHVOR_HITL_TIMEOUT_MS = "1500";

let requestNativeApproval: typeof import("../approval-gate-hitl.ts").requestNativeApproval;
let resolveHITLApproval: typeof import("../approval-gate-hitl.ts").resolveHITLApproval;
let isHITLEnabled: typeof import("../approval-gate-hitl.ts").isHITLEnabled;
let appendPendingApproval: typeof import("../../db/approval-store.ts").appendPendingApproval;
let decideApproval: typeof import("../../db/approval-store.ts").decideApproval;
let getApproval: typeof import("../../db/approval-store.ts").getApproval;
let listApprovals: typeof import("../../db/approval-store.ts").listApprovals;
let expireStaleApprovals: typeof import("../../db/approval-store.ts").expireStaleApprovals;
let pruneApprovalsOlderThan: typeof import("../../db/approval-store.ts").pruneApprovalsOlderThan;
let countApprovals: typeof import("../../db/approval-store.ts").countApprovals;
let countPendingApprovals: typeof import("../../db/approval-store.ts").countPendingApprovals;

beforeAll(async () => {
  ({ requestNativeApproval, resolveHITLApproval, isHITLEnabled } = await import(
    "../approval-gate-hitl.ts"
  ));
  ({
    appendPendingApproval,
    decideApproval,
    getApproval,
    listApprovals,
    expireStaleApprovals,
    pruneApprovalsOlderThan,
    countApprovals,
    countPendingApprovals,
  } = await import("../../db/approval-store.ts"));
});

describe("approval-store", () => {
  it("appends a pending row and round-trips it through getApproval", () => {
    const id = appendPendingApproval({
      sessionId: "sess-1",
      actionId: null,
      toolName: "native__shell_execute",
      kind: "native",
      args: { command: "rm -rf /" },
      risk: "high",
      reasons: ["[static-rules] dangerous shell command"],
      checkpointId: "ckpt-1",
      ttlMs: 5_000,
    });
    expect(id).toBeTypeOf("string");

    const record = getApproval(id);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("pending");
    expect(record!.toolName).toBe("native__shell_execute");
    expect(record!.kind).toBe("native");
    expect(record!.risk).toBe("high");
    expect(record!.reasons).toEqual(["[static-rules] dangerous shell command"]);
    expect(record!.checkpointId).toBe("ckpt-1");
    expect(record!.expiresAt).toBeGreaterThan(record!.createdAt);
    expect(record!.args).toEqual({ command: "rm -rf /" });
  });

  it("decideApproval flips pending → final and records who decided", () => {
    const id = appendPendingApproval({
      sessionId: "sess-decide",
      actionId: null,
      toolName: "native__send_telegram",
      kind: "native",
      args: {},
      risk: "high",
      reasons: ["test"],
      checkpointId: null,
      ttlMs: 60_000,
    });
    const allowed = decideApproval({ id, decision: "allow-once", decidedBy: "user" });
    expect(allowed).not.toBeNull();
    expect(allowed!.status).toBe("allowed");
    expect(allowed!.decision).toBe("allow-once");
    expect(allowed!.decidedBy).toBe("user");

    // Second decide is a noop — already-decided rows can't be re-decided.
    const second = decideApproval({ id, decision: "deny", decidedBy: "user" });
    expect(second).toBeNull();
  });

  it("expireStaleApprovals only touches rows whose expiresAt has passed", () => {
    // Fresh row — should not expire.
    const fresh = appendPendingApproval({
      sessionId: "sess-fresh",
      actionId: null,
      toolName: "x",
      kind: "native",
      args: {},
      risk: "high",
      reasons: [],
      checkpointId: null,
      ttlMs: 60_000,
    });
    // Stale row — write directly with past expiry.
    const stale = appendPendingApproval({
      sessionId: "sess-stale",
      actionId: null,
      toolName: "y",
      kind: "native",
      args: {},
      risk: "high",
      reasons: [],
      checkpointId: null,
      ttlMs: 1, // 1 ms expiry → instantly stale by the time the next call runs
    });
    // Make sure 1 ms has elapsed.
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    const expired = expireStaleApprovals();
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(getApproval(fresh)!.status).toBe("pending");
    expect(getApproval(stale)!.status).toBe("expired");
  });

  it("listApprovals filters by status + session", () => {
    const sId = "sess-list";
    appendPendingApproval({
      sessionId: sId, actionId: null, toolName: "a", kind: "native", args: {},
      risk: "high", reasons: [], checkpointId: null, ttlMs: 60_000,
    });
    const decided = appendPendingApproval({
      sessionId: sId, actionId: null, toolName: "b", kind: "native", args: {},
      risk: "high", reasons: [], checkpointId: null, ttlMs: 60_000,
    });
    decideApproval({ id: decided, decision: "deny", decidedBy: "user" });

    const pending = listApprovals({ sessionId: sId, status: "pending" });
    const denied = listApprovals({ sessionId: sId, status: "denied" });
    expect(pending.every((r) => r.status === "pending" && r.sessionId === sId)).toBe(true);
    expect(denied.every((r) => r.status === "denied" && r.sessionId === sId)).toBe(true);
    expect(denied.length).toBeGreaterThanOrEqual(1);
  });

  it("pruneApprovalsOlderThan only removes decided rows", () => {
    const stillPending = appendPendingApproval({
      sessionId: "sess-prune", actionId: null, toolName: "p", kind: "native", args: {},
      risk: "high", reasons: [], checkpointId: null, ttlMs: 60_000,
    });
    const decided = appendPendingApproval({
      sessionId: "sess-prune", actionId: null, toolName: "d", kind: "native", args: {},
      risk: "high", reasons: [], checkpointId: null, ttlMs: 60_000,
    });
    decideApproval({ id: decided, decision: "deny", decidedBy: "user" });

    // Negative horizon → cutoff in the future → all decided rows match.
    const removed = pruneApprovalsOlderThan(-1);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(getApproval(stillPending)).not.toBeNull(); // pending row preserved
    expect(getApproval(decided)).toBeNull();
  });

  it("countApprovals + countPendingApprovals reflect the table", () => {
    const totalBefore = countApprovals();
    const pendingBefore = countPendingApprovals();
    appendPendingApproval({
      sessionId: "sess-count", actionId: null, toolName: "c", kind: "native", args: {},
      risk: "high", reasons: [], checkpointId: null, ttlMs: 60_000,
    });
    expect(countApprovals()).toBe(totalBefore + 1);
    expect(countPendingApprovals()).toBe(pendingBefore + 1);
  });
});

describe("approval-gate-hitl — env knobs", () => {
  it("isHITLEnabled is on by default and disabled when env flag is set", () => {
    const original = process.env.CHVOR_HITL_DISABLE;
    delete process.env.CHVOR_HITL_DISABLE;
    expect(isHITLEnabled()).toBe(true);

    process.env.CHVOR_HITL_DISABLE = "1";
    expect(isHITLEnabled()).toBe(false);

    if (original === undefined) delete process.env.CHVOR_HITL_DISABLE;
    else process.env.CHVOR_HITL_DISABLE = original;
  });
});

describe("approval-gate-hitl — request/resolve flow", () => {
  it("a fast user response resolves to allow with the decision recorded", async () => {
    const promise = requestNativeApproval({
      sessionId: "sess-fast",
      actionId: null,
      toolName: "native__shell_execute",
      kind: "native",
      args: { command: "ls" },
      risk: "high",
      reasons: ["test"],
      checkpointId: null,
    });
    // Pull the pending id from the latest row.
    await new Promise((r) => setTimeout(r, 10));
    const pending = listApprovals({ sessionId: "sess-fast", status: "pending" });
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const id = pending[0].id;
    const result = resolveHITLApproval({ id, decision: "allow-session", decidedBy: "user" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe("allowed");
      expect(result.record.decision).toBe("allow-session");
    }

    const outcome = await promise;
    expect(outcome.allowed).toBe(true);
    if (outcome.allowed) expect(outcome.decision).toBe("allow-session");
  });

  it("a denial resolves to allowed=false reason=denied", async () => {
    const promise = requestNativeApproval({
      sessionId: "sess-deny",
      actionId: null,
      toolName: "native__shell_execute",
      kind: "native",
      args: {},
      risk: "high",
      reasons: ["test"],
      checkpointId: null,
    });
    await new Promise((r) => setTimeout(r, 10));
    const pending = listApprovals({ sessionId: "sess-deny", status: "pending" });
    const id = pending[0].id;
    resolveHITLApproval({ id, decision: "deny", decidedBy: "user" });

    const outcome = await promise;
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.reason).toBe("denied");
  });

  it("the auto-expire timer closes a stale pending request", async () => {
    const promise = requestNativeApproval({
      sessionId: "sess-expire",
      actionId: null,
      toolName: "native__shell_execute",
      kind: "native",
      args: {},
      risk: "high",
      reasons: ["test"],
      checkpointId: null,
    });
    const outcome = await promise;
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) {
      // Either "expired" (WS available) or "no-ws" (which also implies the
      // gate ran the timeout path) — both are acceptable terminal states.
      expect(["expired", "no-ws"]).toContain(outcome.reason);
    }
  }, 6_000);

  it("resolveHITLApproval returns not-found for unknown ids", () => {
    const result = resolveHITLApproval({
      id: "00000000-0000-0000-0000-000000000000",
      decision: "deny",
      decidedBy: "user",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-found");
  });
});
