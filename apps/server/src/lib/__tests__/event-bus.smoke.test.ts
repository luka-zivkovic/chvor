import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route the DB to a throwaway temp dir before anything else loads the singleton.
const tmp = mkdtempSync(join(tmpdir(), "chvor-smoke-"));
process.env.CHVOR_DATA_DIR = tmp;

// Dynamic imports run after env is set so the DB opens in the temp dir.
let beginAction: typeof import("../event-bus.ts").beginAction;
let finishAction: typeof import("../event-bus.ts").finishAction;
let failAction: typeof import("../event-bus.ts").failAction;
let listTraces: typeof import("../../db/event-store.ts").listTraces;
let appendAudit: typeof import("../../db/audit-log-store.ts").appendAudit;
let listAudit: typeof import("../../db/audit-log-store.ts").listAudit;
let parseScopes: typeof import("../../middleware/auth.ts").parseScopes;
let scopeMatches: typeof import("../../middleware/auth.ts").scopeMatches;
let requiredScopeFor: typeof import("../../middleware/auth.ts").requiredScopeFor;
let runSecurityAudit: typeof import("../security-auditor.ts").runSecurityAudit;

beforeAll(async () => {
  ({ beginAction, finishAction, failAction } = await import("../event-bus.ts"));
  ({ listTraces } = await import("../../db/event-store.ts"));
  ({ appendAudit, listAudit } = await import("../../db/audit-log-store.ts"));
  ({ parseScopes, scopeMatches, requiredScopeFor } = await import("../../middleware/auth.ts"));
  ({ runSecurityAudit } = await import("../security-auditor.ts"));
});

describe("Phase A + B smoke — typed events, audit log, scope matcher", () => {
  it("persists paired action + observation with success result", () => {
    const h = beginAction(
      "native",
      "native__web_search",
      { query: "hello" },
      { sessionId: "sess1", actorType: "session", actorId: "sess1" }
    );
    finishAction(h, { results: ["a", "b", "c"] });

    const traces = listTraces({ sessionId: "sess1", limit: 10 });
    expect(traces.length).toBeGreaterThanOrEqual(1);
    const found = traces.find((t) => t.action.id === h.actionId);
    expect(found).toBeDefined();
    expect(found!.action.tool).toBe("native__web_search");
    expect(found!.action.actorType).toBe("session");
    expect(found!.observations).toHaveLength(1);
    expect(found!.observations[0].kind).toBe("result");
  });

  it("persists paired action + error observation on failure", () => {
    const h = beginAction(
      "synthesized_call",
      "github__create_issue",
      { title: "x" },
      { sessionId: "sess1", actorType: "apikey", actorId: "key123" }
    );
    failAction(h, new Error("401 unauthorized"));

    const traces = listTraces({ sessionId: "sess1", limit: 50 });
    const found = traces.find((t) => t.action.id === h.actionId);
    expect(found).toBeDefined();
    expect(found!.action.actorType).toBe("apikey");
    expect(found!.observations).toHaveLength(1);
    expect(found!.observations[0].kind).toBe("error");
  });

  it("appends and lists audit rows", () => {
    const id = appendAudit({
      eventType: "apikey.forbidden",
      actorType: "apikey",
      actorId: "key123",
      resourceType: "scope",
      resourceId: "tool:execute:*",
      action: "deny",
      httpMethod: "POST",
      httpPath: "/api/sessions",
      httpStatusCode: 403,
    });
    expect(id).toBeTruthy();
    const rows = listAudit({ limit: 10 });
    expect(rows.some((r) => r.id === id)).toBe(true);
  });

  it("matches scopes with wildcards correctly", () => {
    expect(scopeMatches(parseScopes("*"), "tool:execute:anything")).toBe(true);
    expect(scopeMatches(parseScopes("tool:execute:*"), "tool:execute:native__web_search")).toBe(true);
    expect(scopeMatches(parseScopes("tool:execute:native__web_*"), "tool:execute:native__web_search")).toBe(true);
    expect(scopeMatches(parseScopes("credential:read"), "credential:write")).toBe(false);
    expect(scopeMatches(parseScopes("tool:execute:shell"), "tool:execute:native__shell_execute")).toBe(false);
  });

  it("maps paths to required scopes", () => {
    expect(requiredScopeFor("GET", "/api/credentials")).toBe("credential:read");
    expect(requiredScopeFor("POST", "/api/credentials/abc")).toBe("credential:write");
    expect(requiredScopeFor("POST", "/api/sessions")).toBe("tool:execute:*");
    expect(requiredScopeFor("GET", "/api/health")).toBe("api:read");
  });

  it("requires write scope for destructive /api/debug POSTs", () => {
    expect(requiredScopeFor("GET", "/api/debug/events")).toBe("debug:read");
    expect(requiredScopeFor("GET", "/api/debug/audit")).toBe("debug:read");
    expect(requiredScopeFor("POST", "/api/debug/prune")).toBe("debug:write");
    // a debug:read-only key must NOT satisfy debug:write
    expect(scopeMatches(parseScopes("debug:read"), "debug:write")).toBe(false);
  });

  it("requires audit:run for POST /api/audit and audit:read for GET", () => {
    expect(requiredScopeFor("POST", "/api/audit")).toBe("audit:run");
    expect(requiredScopeFor("GET", "/api/audit")).toBe("audit:read");
    // a generic api:write key should not satisfy audit:run
    expect(scopeMatches(parseScopes("api:write"), "audit:run")).toBe(false);
  });

  it("redacts secrets in observation payloads before storage", () => {
    const h = beginAction(
      "synthesized_call",
      "github__get_token",
      { repo: "x" },
      { sessionId: "sess-redact", actorType: "session", actorId: "sess-redact" }
    );
    // Embed a token-shaped string in the response body. SENSITIVE_PATTERNS
    // matches `ghp_` PATs ≥36 chars; keep the structure.
    const fakePat = "ghp_" + "A".repeat(40);
    finishAction(h, {
      status: 200,
      body: { access_token: `Bearer ${"x".repeat(40)}`, note: fakePat },
      truncated: false,
    });

    const traces = listTraces({ sessionId: "sess-redact", limit: 5 });
    const found = traces.find((t) => t.action.id === h.actionId);
    expect(found).toBeDefined();
    expect(found!.observations).toHaveLength(1);
    const stored = JSON.stringify(found!.observations[0].payload);
    expect(stored).not.toContain(fakePat);
    expect(stored).toContain("[REDACTED]");
  });

  it("redacts secrets in error messages from failAction", () => {
    const h = beginAction(
      "mcp_call",
      "some__tool",
      {},
      { sessionId: "sess-err-redact", actorType: "session", actorId: "sess-err-redact" }
    );
    const fakeKey = "sk-" + "B".repeat(40);
    failAction(h, new Error(`upstream rejected token ${fakeKey}`));

    const traces = listTraces({ sessionId: "sess-err-redact", limit: 5 });
    const found = traces.find((t) => t.action.id === h.actionId);
    expect(found).toBeDefined();
    const stored = JSON.stringify(found!.observations[0].payload);
    expect(stored).not.toContain(fakeKey);
    expect(stored).toContain("[REDACTED]");
  });

  it("runs the security auditor without throwing", () => {
    const report = runSecurityAudit();
    expect(report.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.summary).toHaveProperty("total");
    expect(report.findings).toBeInstanceOf(Array);
  });
});
