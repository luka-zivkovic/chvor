import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionConfig, Tool } from "@chvor/shared";

const tmp = mkdtempSync(join(tmpdir(), "chvor-synth-oauth-"));
process.env.CHVOR_DATA_DIR = tmp;

// Mock the shared pinned network layer so the API call and OAuth refresh never
// perform real sockets or DNS.
const h = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  pinned: vi.fn(),
}));
vi.mock("../synthesized/network.ts", () => ({
  resolveSafeSynthesizedTarget: h.resolveTarget,
  pinnedHttpsRequest: h.pinned,
  assertSafeSynthesizedUrl: vi.fn(),
}));

let callSynthesizedEndpoint: typeof import("../synthesized-caller.ts").callSynthesizedEndpoint;
let createCredential: typeof import("../../db/credential-store.ts").createCredential;
let updateConnectionConfig: typeof import("../../db/credential-store.ts").updateConnectionConfig;
let updateCredential: typeof import("../../db/credential-store.ts").updateCredential;
let getCredentialData: typeof import("../../db/credential-store.ts").getCredentialData;
let deleteCredential: typeof import("../../db/credential-store.ts").deleteCredential;
let listCredentials: typeof import("../../db/credential-store.ts").listCredentials;
let setupStore: typeof import("../../db/integration-setup-store.ts");
let setWSInstance: typeof import("../../gateway/ws-instance.ts").setWSInstance;
let resolveSynthesizedApproval: typeof import("../approval-gate.ts").resolveSynthesizedApproval;
const approvalEvents: Array<
  Extract<import("@chvor/shared").GatewayServerEvent, { type: "synthesized.confirm" }>
> = [];

beforeAll(async () => {
  ({ callSynthesizedEndpoint } = await import("../synthesized-caller.ts"));
  ({
    createCredential,
    updateConnectionConfig,
    updateCredential,
    getCredentialData,
    deleteCredential,
    listCredentials,
  } = await import("../../db/credential-store.ts"));
  setupStore = await import("../../db/integration-setup-store.ts");
  ({ setWSInstance } = await import("../../gateway/ws-instance.ts"));
  ({ resolveSynthesizedApproval } = await import("../approval-gate.ts"));
  setWSInstance({
    sendTo: (_clientId: string, event: import("@chvor/shared").GatewayServerEvent) => {
      if (event.type === "synthesized.confirm") approvalEvents.push(event);
      return true;
    },
    broadcast: () => undefined,
  } as never);
});

const connection: ConnectionConfig = {
  auth: { scheme: "bearer" },
  baseUrl: "https://api.demo.test",
  source: "user-provided",
  confidence: "high",
};

function oauthTool(method: "GET" | "POST" = "GET"): Tool {
  return {
    kind: "tool",
    id: "demo-api",
    instructions: "",
    source: "user",
    path: "demo-api.md",
    builtIn: false,
    metadata: { name: "Demo API", description: "test", version: "1.0.0", group: "git" },
    mcpServer: { transport: "synthesized" },
    synthesized: {
      source: "ai-draft",
      verified: true,
      generatedAt: new Date().toISOString(),
      credentialType: "demo-oauth",
    },
    endpoints: [{ name: "me", description: "who am i", method, path: "/v1/me" }],
  };
}

function pinnedResponse(status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body), "utf-8");
  return {
    status,
    statusText: status === 200 ? "OK" : "Unauthorized",
    headers: { "content-type": "application/json" },
    body: buf,
    truncated: false,
    size: buf.byteLength,
  };
}

describe("synthesized-caller — transparent OAuth refresh on 401", () => {
  beforeEach(() => {
    approvalEvents.length = 0;
    for (const c of listCredentials()) deleteCredential(c.id);
    vi.restoreAllMocks();
    h.resolveTarget.mockReset();
    h.pinned.mockReset();
    h.resolveTarget.mockImplementation(async (url: string) => ({
      url: new URL(url),
      resolvedIp: "93.184.216.34",
      hostname: new URL(url).hostname,
    }));
  });

  afterAll(() => setWSInstance(null));

  it("refreshes the token, retries once, and persists the new access token", async () => {
    const cred = createCredential("Demo", "demo-oauth", {
      accessToken: "old-at",
      refreshToken: "old-rt",
      clientId: "cid",
      clientSecret: "csecret",
      tokenUrl: "https://token.demo.test/oauth/token",
      provider: "synthesized",
    });
    updateConnectionConfig(cred.id, connection);

    // First live call → 401; retry after refresh → 200.
    h.pinned
      .mockResolvedValueOnce(pinnedResponse(401, { error: "token expired" }))
      .mockResolvedValueOnce(
        pinnedResponse(200, {
          access_token: "new-at",
          refresh_token: "new-rt",
          expires_in: 3600,
        })
      )
      .mockResolvedValueOnce(pinnedResponse(200, { ok: true }));

    const result = await callSynthesizedEndpoint(oauthTool(), "me", {});

    expect(result.ok).toBe(true);
    expect(h.pinned).toHaveBeenCalledTimes(3);

    // The retry must carry the refreshed access token, not the stale one.
    const retryHeaders = h.pinned.mock.calls[2][0].headers as Record<string, string>;
    expect(retryHeaders["Authorization"]).toBe("Bearer new-at");

    // And the new token must be persisted back to the credential store.
    expect(getCredentialData(cred.id)?.data.accessToken).toBe("new-at");
    expect(getCredentialData(cred.id)?.data.refreshToken).toBe("new-rt");
  });

  it("refreshes an elapsed token before first runtime use", async () => {
    const cred = createCredential("Elapsed", "demo-oauth", {
      accessToken: "expired-at",
      refreshToken: "old-rt",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      clientId: "cid",
      clientSecret: "csecret",
      tokenUrl: "https://token.demo.test/oauth/token",
      provider: "synthesized",
    });
    updateConnectionConfig(cred.id, connection);
    h.pinned
      .mockResolvedValueOnce(pinnedResponse(200, { access_token: "fresh-at", expires_in: 3600 }))
      .mockResolvedValueOnce(pinnedResponse(200, { ok: true }));

    const result = await callSynthesizedEndpoint(oauthTool(), "me", {});

    expect(result.ok).toBe(true);
    expect(h.pinned).toHaveBeenCalledTimes(2);
    const requestHeaders = h.pinned.mock.calls[1][0].headers as Record<string, string>;
    expect(requestHeaders.Authorization).toBe("Bearer fresh-at");
  });

  it("blocks an elapsed token without a refresh token before network use", async () => {
    const cred = createCredential("Elapsed", "demo-oauth", {
      accessToken: "expired-at",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      clientId: "cid",
      tokenUrl: "https://token.demo.test/oauth/token",
      provider: "synthesized",
      oauthKind: "synthesized",
    });
    updateConnectionConfig(cred.id, connection);

    const result = await callSynthesizedEndpoint(oauthTool(), "me", {});

    expect(result).toMatchObject({
      ok: false,
      code: "integration_reauthentication_required",
      reauthentication: {
        credentialId: cred.id,
        authStatus: "reauthentication-required",
        failureCode: "oauth_refresh_unavailable",
      },
    });
    expect(h.resolveTarget).not.toHaveBeenCalled();
    expect(h.pinned).not.toHaveBeenCalled();
  });

  it("does not retry when there is no refresh token", async () => {
    const cred = createCredential("Demo", "demo-oauth", { accessToken: "old-at" });
    updateConnectionConfig(cred.id, connection);
    h.pinned.mockResolvedValueOnce(pinnedResponse(401, { error: "nope" }));

    const result = await callSynthesizedEndpoint(oauthTool(), "me", {});
    expect(result.ok).toBe(false);
    expect(h.pinned).toHaveBeenCalledTimes(1);
  });

  it("reports the retry response when refresh succeeds but the retry still fails", async () => {
    const cred = createCredential("Demo", "demo-oauth", {
      accessToken: "old-at",
      refreshToken: "old-rt",
      clientId: "cid",
      clientSecret: "csecret",
      tokenUrl: "https://token.demo.test/oauth/token",
      provider: "synthesized",
    });
    updateConnectionConfig(cred.id, connection);

    h.pinned
      .mockResolvedValueOnce(pinnedResponse(401, { error: "original token expired" }))
      .mockResolvedValueOnce(pinnedResponse(200, { access_token: "new-at", expires_in: 3600 }))
      .mockResolvedValueOnce(pinnedResponse(500, { error: "provider unavailable after refresh" }));

    const result = await callSynthesizedEndpoint(oauthTool(), "me", {});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the retried call to fail");
    expect(result.status).toBe(500);
    expect(result.error).toContain("provider unavailable after refresh");
    expect(result.error).not.toContain("original token expired");
    expect(h.pinned).toHaveBeenCalledTimes(3);
  });

  it("surfaces a terminal centralized refresh result as structured reauthentication", async () => {
    const cred = createCredential("Revoked", "demo-oauth", {
      accessToken: "old-at",
      refreshToken: "revoked-rt",
      clientId: "cid",
      clientSecret: "csecret",
      tokenUrl: "https://token.demo.test/oauth/token",
      provider: "synthesized",
    });
    updateConnectionConfig(cred.id, connection);
    h.pinned
      .mockResolvedValueOnce(pinnedResponse(401, { error: "token expired" }))
      .mockResolvedValueOnce(pinnedResponse(400, { error: "invalid_grant" }));

    const result = await callSynthesizedEndpoint(oauthTool(), "me", {});

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      code: "integration_reauthentication_required",
      reauthentication: {
        credentialId: cred.id,
        authStatus: "reauthentication-required",
        failureCode: "oauth_invalid_grant",
      },
    });
    expect(h.pinned).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch credentials changed during asynchronous target resolution", async () => {
    const cred = createCredential("Demo", "demo-oauth", { accessToken: "old-at" });
    updateConnectionConfig(cred.id, connection);
    let resolveTarget!: (target: { url: URL; resolvedIp: string; hostname: string }) => void;
    h.resolveTarget.mockReturnValue(
      new Promise((resolve) => {
        resolveTarget = resolve;
      })
    );

    const pending = callSynthesizedEndpoint(oauthTool(), "me", {});
    await vi.waitFor(() => expect(h.resolveTarget).toHaveBeenCalledOnce());
    updateCredential(cred.id, undefined, { accessToken: "rotated-at" });
    resolveTarget({
      url: new URL("https://api.demo.test/v1/me"),
      resolvedIp: "93.184.216.34",
      hostname: "api.demo.test",
    });

    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
    expect(h.pinned).not.toHaveBeenCalled();
  });

  it("does not dispatch a credential revoked during asynchronous target resolution", async () => {
    const cred = createCredential("Demo", "demo-oauth", { accessToken: "old-at" });
    updateConnectionConfig(cred.id, connection);
    const binding = setupStore.upsertIntegrationCredentialBinding({
      credentialId: cred.id,
      integrationId: "demo",
      manifestVersion: "1.0.0",
      manifestCredentialId: "oauth.demo",
      authMethod: "oauth2",
      authStatus: "active",
    });
    let resolveTarget!: (target: { url: URL; resolvedIp: string; hostname: string }) => void;
    h.resolveTarget.mockReturnValue(
      new Promise((resolve) => {
        resolveTarget = resolve;
      })
    );

    const pending = callSynthesizedEndpoint(oauthTool(), "me", {});
    await vi.waitFor(() => expect(h.resolveTarget).toHaveBeenCalledOnce());
    setupStore.updateIntegrationCredentialAuthState(binding, {
      authStatus: "reauthentication-required",
      failureCode: "credential_revoked",
    });
    resolveTarget({
      url: new URL("https://api.demo.test/v1/me"),
      resolvedIp: "93.184.216.34",
      hostname: "api.demo.test",
    });

    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      code: "integration_reauthentication_required",
      reauthentication: { credentialId: cred.id, failureCode: "credential_revoked" },
    });
    expect(h.pinned).not.toHaveBeenCalled();
  });

  it("does not dispatch headers built before an asynchronous approval when credentials change", async () => {
    const cred = createCredential("Demo", "demo-oauth", { accessToken: "old-at" });
    updateConnectionConfig(cred.id, connection);

    const pending = callSynthesizedEndpoint(
      oauthTool("POST"),
      "me",
      { body: { action: "write" } },
      { sessionId: "approval-race", originClientId: "approval-client" }
    );
    await vi.waitFor(() => expect(approvalEvents).toHaveLength(1));
    updateCredential(cred.id, undefined, { accessToken: "rotated-at" });
    const requestId = approvalEvents[0].data.requestId;
    expect(
      resolveSynthesizedApproval(
        requestId,
        { requestId, decision: "allow-once" },
        "approval-client"
      )
    ).toBe(true);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("changed"),
    });
    expect(h.pinned).not.toHaveBeenCalled();
  });
});
