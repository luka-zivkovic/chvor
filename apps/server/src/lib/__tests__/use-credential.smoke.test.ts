import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "chvor-use-cred-"));
process.env.CHVOR_DATA_DIR = tmp;
process.env.CHVOR_HITL_TIMEOUT_MS = "1500";

let handleUseCredential: typeof import("../native-tools/credential/crud.ts").handleUseCredential;
let handleListCredentials: typeof import("../native-tools/credential/crud.ts").handleListCredentials;
let createCredential: typeof import("../../db/credential-store.ts").createCredential;
let deleteCredential: typeof import("../../db/credential-store.ts").deleteCredential;
let listCredentials: typeof import("../../db/credential-store.ts").listCredentials;
let updateConnectionConfig: typeof import("../../db/credential-store.ts").updateConnectionConfig;
let listApprovals: typeof import("../../db/approval-store.ts").listApprovals;
let resolveHITLApproval: typeof import("../approval-gate-hitl.ts").resolveHITLApproval;
let listAudit: typeof import("../../db/audit-log-store.ts").listAudit;
let beginAction: typeof import("../event-bus.ts").beginAction;
let listTraces: typeof import("../../db/event-store.ts").listTraces;

beforeAll(async () => {
  ({ handleUseCredential, handleListCredentials } =
    await import("../native-tools/credential/crud.ts"));
  ({ createCredential, deleteCredential, listCredentials, updateConnectionConfig } =
    await import("../../db/credential-store.ts"));
  ({ listApprovals } = await import("../../db/approval-store.ts"));
  ({ resolveHITLApproval } = await import("../approval-gate-hitl.ts"));
  ({ listAudit } = await import("../../db/audit-log-store.ts"));
  ({ beginAction } = await import("../event-bus.ts"));
  ({ listTraces } = await import("../../db/event-store.ts"));
});

function reset() {
  for (const c of listCredentials()) deleteCredential(c.id);
}

function text(result: Awaited<ReturnType<typeof handleUseCredential>>): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function json(result: Awaited<ReturnType<typeof handleUseCredential>>): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

async function waitForPendingApproval(sessionId: string) {
  for (let i = 0; i < 50; i++) {
    const pending = listApprovals({ sessionId, status: "pending" });
    if (pending.length > 0) return pending;
    await new Promise((r) => setTimeout(r, 10));
  }
  return listApprovals({ sessionId, status: "pending" });
}

describe("native__use_credential redaction", () => {
  beforeEach(reset);

  it("returns metadata by default, not raw values", async () => {
    const c = createCredential(
      "Work GitHub",
      "github",
      { apiKey: "ghp_super_secret_token", apiUrl: "https://api.github.com" },
      "work, enterprise"
    );
    updateConnectionConfig(c.id, {
      auth: { scheme: "bearer", headerName: "Authorization", headerTemplate: "Bearer {{apiKey}}" },
      baseUrl: "https://api.github.com/base/ghp_super_secret_token",
      headers: {
        "X-Api-Key": "ghp_super_secret_token",
        "X-Api-Version": "2022-11-28",
      },
      source: "user-provided",
      confidence: "high",
    });

    const payload = json(await handleUseCredential({ credentialId: c.id }));
    expect(payload.credentialId).toBe(c.id);
    expect(payload.field_names).toEqual(["apiKey", "apiUrl"]);
    expect(payload).not.toHaveProperty("fields");
    expect(JSON.stringify(payload)).not.toContain("ghp_super_secret_token");
    expect(String(payload.connectionHint)).toContain("Base URL: {{apiUrl}}/base/{{apiKey}}");
    expect(String(payload.connectionHint)).toContain("Bearer {{apiKey}}");
    expect(String(payload.connectionHint)).toContain('"X-Api-Key":"{{apiKey}}"');
    expect(String(payload.connectionHint)).toContain('"X-Api-Version":"2022-11-28"');
  });

  it("credentialId lookup wins over type lookup", async () => {
    const openai = createCredential("OpenAI", "openai", { apiKey: "sk_secret" });
    createCredential("GitHub", "github", { apiKey: "ghp_secret" });
    const payload = json(await handleUseCredential({ credentialId: openai.id, type: "github" }));
    expect(payload.credentialId).toBe(openai.id);
    expect(payload.type).toBe("openai");
  });

  it("returns typed errors for unknown id and type", async () => {
    expect(text(await handleUseCredential({ credentialId: "missing-id" }))).toContain(
      "Credential id missing-id not found"
    );
    expect(text(await handleUseCredential({ type: "missing-type" }))).toContain(
      "Credential type missing-type not found"
    );
  });

  it("revealValues without a session stays redacted and audits denial", async () => {
    const c = createCredential("GitHub", "github", { apiKey: "ghp_super_secret_token" });
    const payload = json(await handleUseCredential({ credentialId: c.id, revealValues: true }));
    expect(payload).toHaveProperty("field_names");
    expect(payload).not.toHaveProperty("fields");
    expect(JSON.stringify(payload)).not.toContain("ghp_super_secret_token");
    expect(
      listAudit({ resourceId: c.id }).some((r) => r.eventType === "credential.reveal.denied")
    ).toBe(true);
  });

  it("revealValues denied by HITL returns redacted", async () => {
    const c = createCredential("GitHub", "github", { apiKey: "ghp_super_secret_token" });
    const promise = handleUseCredential(
      { credentialId: c.id, revealValues: true },
      { sessionId: "sess-deny" }
    );
    const pending = await waitForPendingApproval("sess-deny");
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].args).toEqual({ credentialId: c.id, type: "github", revealValues: true });
    expect(JSON.stringify(pending[0].args)).not.toContain("ghp_super_secret_token");
    resolveHITLApproval({ id: pending[0].id, decision: "deny", decidedBy: "user" });
    const payload = json(await promise);
    expect(payload).not.toHaveProperty("fields");
    expect(JSON.stringify(payload)).not.toContain("ghp_super_secret_token");
    expect(
      listAudit({ resourceId: c.id }).some((r) => r.eventType === "credential.reveal.denied")
    ).toBe(true);
  });

  it("revealValues allowed by HITL returns raw values once", async () => {
    const c = createCredential("GitHub", "github", { apiKey: "ghp_super_secret_token" });
    beginAction(
      "native",
      "native__use_credential",
      { credentialId: c.id, type: "github", revealValues: true },
      {
        sessionId: "sess-allow",
      }
    );
    const promise = handleUseCredential(
      { credentialId: c.id, revealValues: true },
      { sessionId: "sess-allow" }
    );
    const pending = await waitForPendingApproval("sess-allow");
    resolveHITLApproval({ id: pending[0].id, decision: "allow-once", decidedBy: "user" });
    const payload = json(await promise);
    expect(payload.fields).toEqual({ apiKey: "ghp_super_secret_token" });
    expect(payload.audit).toBeTruthy();
    expect(
      listAudit({ resourceId: c.id }).some((r) => r.eventType === "credential.reveal.allowed")
    ).toBe(true);
    const traces = listTraces({ sessionId: "sess-allow", tool: "native__use_credential" });
    expect(JSON.stringify(traces.map((t) => t.action.args))).not.toContain(
      "ghp_super_secret_token"
    );
  });
});

describe("native__list_credentials skill scope filter", () => {
  beforeEach(reset);

  it("hides credentials whose type is outside allowedCredentialTypes", async () => {
    createCredential("Work GitHub", "github", { apiKey: "ghp_a" });
    createCredential("Slack Bot", "slack", { token: "xoxb_secret" });
    const result = await handleListCredentials({}, { allowedCredentialTypes: ["github"] });
    const out = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(out).toContain("Work GitHub");
    expect(out).not.toContain("Slack Bot");
    expect(out).not.toContain("xoxb_secret");
  });

  it("returns scoped empty message when nothing matches the active scope", async () => {
    createCredential("Slack Bot", "slack", { token: "xoxb_secret" });
    const result = await handleListCredentials({}, { allowedCredentialTypes: ["github"] });
    const out = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(out).toContain("active skill scope");
    expect(out).not.toContain("Slack Bot");
  });

  it("falls back to listing everything when no scope is set", async () => {
    createCredential("Work GitHub", "github", { apiKey: "ghp_a" });
    createCredential("Slack Bot", "slack", { token: "xoxb_secret" });
    const result = await handleListCredentials({}, {});
    const out = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(out).toContain("Work GitHub");
    expect(out).toContain("Slack Bot");
  });
});
