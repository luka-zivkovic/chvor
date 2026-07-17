import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthProviderConfig, PendingOAuthFlow } from "../oauth-engine.ts";

const network = vi.hoisted(() => ({ resolve: vi.fn(), pinned: vi.fn() }));
vi.mock("../synthesized/network.ts", () => ({
  resolveSafeSynthesizedTarget: network.resolve,
  pinnedHttpsRequest: network.pinned,
}));

const dataDir = mkdtempSync(join(tmpdir(), "chvor-oauth-engine-"));
process.env.CHVOR_DATA_DIR = dataDir;

let engine: typeof import("../oauth-engine.ts");
let bindingStore: typeof import("../../db/integration-credential-binding-store.ts");
let credentialStore: typeof import("../../db/credential-store.ts");
let setupStore: typeof import("../../db/integration-setup-store.ts");
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;

const provider: OAuthProviderConfig = {
  id: "demo",
  name: "Demo",
  authUrl: "https://demo.test/authorize",
  tokenUrl: "https://demo.test/token",
  scopes: ["read", "write"],
  extraAuthParams: { access_type: "offline" },
  networkMode: "builtin",
};

function jsonResponse(body: unknown, _ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pendingFlow(): PendingOAuthFlow {
  return {
    schemaVersion: 1,
    flowId: "flow-demo",
    providerId: "demo",
    codeVerifier: "verifier-abc",
    clientId: "client-123",
    clientSecret: "secret-xyz",
    redirectUri: "http://localhost:9147/api/oauth/callback",
    postMessageOrigin: "http://localhost:9147",
    createdAt: new Date().toISOString(),
    credentialType: "oauth-token-demo",
    oauthManifestCredentialId: "oauth.direct",
  };
}

beforeAll(async () => {
  engine = await import("../oauth-engine.ts");
  bindingStore = await import("../../db/integration-credential-binding-store.ts");
  credentialStore = await import("../../db/credential-store.ts");
  setupStore = await import("../../db/integration-setup-store.ts");
  ({ getDb, closeDb } = await import("../../db/database.ts"));
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM integration_setup_flows").run();
  db.prepare("DELETE FROM credentials").run();
  network.resolve.mockReset();
  network.pinned.mockReset();
});

afterEach(() => vi.restoreAllMocks());

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("PKCE", () => {
  it("uses an RFC-compliant verifier and SHA-256 base64url challenge", () => {
    const verifier = engine.generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(engine.generateCodeChallenge(verifier)).toBe(
      createHash("sha256").update(verifier).digest("base64url")
    );
  });
});

describe("durable pending OAuth state", () => {
  it("encrypts callback material, hashes state, and resumes after a database reopen", () => {
    const generated = engine.generateAuthUrl(
      provider,
      "client-123",
      "secret-xyz",
      "http://localhost:9147/api/oauth/callback"
    );
    const url = new URL(generated.authUrl);
    expect(url.searchParams.get("state")).toBe(generated.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");

    const row = getDb()
      .prepare(
        `SELECT state_sha256, encrypted_payload FROM integration_setup_secret_envelopes
         WHERE flow_id = ?`
      )
      .get(generated.flowId) as { state_sha256: string; encrypted_payload: string };
    expect(row.state_sha256).toBe(createHash("sha256").update(generated.state).digest("hex"));
    expect(row.encrypted_payload).not.toContain("secret-xyz");
    expect(row.encrypted_payload).not.toContain("client-123");
    const flowRow = JSON.stringify(
      getDb().prepare("SELECT * FROM integration_setup_flows WHERE id = ?").get(generated.flowId)
    );
    expect(flowRow).not.toContain("secret-xyz");
    expect(flowRow).not.toContain("client-123");

    closeDb();
    const pending = engine.getPendingFlow(generated.state);
    expect(pending).toMatchObject({
      flowId: generated.flowId,
      providerId: "demo",
      clientId: "client-123",
      clientSecret: "secret-xyz",
    });
    expect(engine.generateCodeChallenge(pending!.codeVerifier)).toBe(
      url.searchParams.get("code_challenge")
    );
  });

  it("rejects case-insensitive reserved parameter overrides", () => {
    expect(() =>
      engine.generateAuthUrl(
        { ...provider, extraAuthParams: { STATE: "attacker" } },
        "client",
        undefined,
        "http://localhost/callback"
      )
    ).toThrow(/reserved/i);
    expect(() =>
      engine.generateAuthUrl(
        { ...provider, extraTokenParams: { Client_Secret: "attacker" } },
        "client",
        undefined,
        "http://localhost/callback"
      )
    ).toThrow(/reserved/i);
  });

  it("consumes state once and rejects expired state while cleaning its envelope", () => {
    const generated = engine.generateAuthUrl(
      provider,
      "client",
      undefined,
      "http://localhost/callback"
    );
    expect(engine.consumePendingFlow(generated.state)?.flowId).toBe(generated.flowId);
    expect(engine.consumePendingFlow(generated.state)).toBeUndefined();

    const expired = engine.generateAuthUrl(
      provider,
      "client",
      undefined,
      "http://localhost/callback"
    );
    const afterExpiry = new Date(Date.parse(expired.expiresAt) + 1).toISOString();
    expect(engine.getPendingFlow(expired.state, afterExpiry)).toBeUndefined();
    expect(
      getDb()
        .prepare(
          "SELECT count(*) AS count FROM integration_setup_secret_envelopes WHERE flow_id = ?"
        )
        .get(expired.flowId)
    ).toEqual({ count: 0 });
  });
});

describe("OAuth duplicate preflight", () => {
  it("reserves the WAL writer before reading duplicate candidates", () => {
    const candidate = credentialStore.createCredential("Existing OAuth", "oauth-token-demo", {
      accessToken: "existing-access-token",
    });
    bindingStore.upsertIntegrationCredentialBinding({
      credentialId: candidate.id,
      integrationId: "oauth.demo",
      manifestVersion: "1.0.0",
      manifestCredentialId: "oauth.direct",
      authMethod: "oauth2",
      authStatus: "active",
    });
    let flow = setupStore.createIntegrationSetupFlow({
      integrationId: "oauth.demo",
      manifestVersion: "1.0.0",
      manifestCredentialId: "oauth.direct",
      credentialType: "oauth-token-demo",
      mode: "setup",
    });
    flow = setupStore.initializeIntegrationSetupStepJournal(flow.id, flow.revision, [
      { id: "oauth.authorize", kind: "oauth" },
    ]);
    flow = setupStore.transitionIntegrationSetupFlow(flow.id, flow.revision, {
      status: "awaiting-oauth",
      step: { id: "oauth.authorize", status: "active" },
    });

    const db = getDb();
    const contender = new Database(join(dataDir, "chvor.db"), { timeout: 0 });
    contender.pragma("journal_mode = WAL");
    contender.pragma("foreign_keys = ON");
    const transaction = db.transaction.bind(db);
    let nestedTransactions = 0;
    let competingWriteError: unknown;
    vi.spyOn(db, "transaction").mockImplementation((fn) => {
      // The first nested transaction reads the flow snapshot. The second starts
      // the candidate update, after both the flow and duplicate rows were read.
      if (db.inTransaction && ++nestedTransactions === 2) {
        try {
          contender
            .prepare("UPDATE credentials SET name = ? WHERE id = ?")
            .run("Concurrent writer", candidate.id);
        } catch (error) {
          competingWriteError = error;
        }
      }
      return transaction(fn);
    });

    try {
      const result = engine.preflightOAuthAccountChoice(
        flow.id,
        "oauth-token-demo",
        "oauth.direct"
      );
      expect(result.paused).toMatchObject({
        id: flow.id,
        status: "awaiting-confirmation",
        duplicateCandidates: [{ id: candidate.id }],
      });
      expect(competingWriteError).toMatchObject({ code: "SQLITE_BUSY" });
    } finally {
      contender.close();
    }
  });
});

describe("token requests", () => {
  it("exchanges a code with PKCE without persisting the authorization code", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read write",
      })
    );
    const tokens = await engine.exchangeCode(provider, "authorization-code", pendingFlow());
    const sent = new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string);
    expect(sent.get("code")).toBe("authorization-code");
    expect(sent.get("code_verifier")).toBe("verifier-abc");
    expect(sent.get("client_secret")).toBe("secret-xyz");
    expect(tokens).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });
    expect(tokens.expiresAt).toBeDefined();
    expect(
      JSON.stringify(getDb().prepare("SELECT * FROM integration_setup_flows").all())
    ).not.toContain("authorization-code");
  });

  it("uses HTTP Basic for Reddit and validates successful token payloads", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ access_token: "at" }));
    await engine.exchangeCode({ ...provider, id: "reddit" }, "code", pendingFlow());
    expect((fetchMock.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("client-123:secret-xyz").toString("base64")}`
    );

    fetchMock.mockResolvedValueOnce(jsonResponse({ refresh_token: "rt" }));
    await expect(engine.refreshAccessToken(provider, "rt", "client")).rejects.toThrow(
      /missing access_token/
    );
  });

  it("rejects 307 redirects without replaying token secrets", async () => {
    const unreadBody = new ReadableStream({
      pull() {
        throw new Error("redirect response body must not be read");
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(unreadBody, { status: 307, headers: { Location: "https://attacker.test" } })
      );

    await expect(engine.exchangeCode(provider, "secret-code", pendingFlow())).rejects.toMatchObject(
      { status: 307, providerCode: "redirect_rejected" }
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("enforces the streaming response limit for exchange and refresh", async () => {
    const oversized = "x".repeat(128 * 1_024 + 1);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(oversized))
      .mockResolvedValueOnce(new Response(oversized));

    await expect(engine.exchangeCode(provider, "code", pendingFlow())).rejects.toThrow(
      /exceeded the safe limit/
    );
    await expect(engine.refreshAccessToken(provider, "refresh", "client")).rejects.toThrow(
      /exceeded the safe limit/
    );
    expect(fetchMock.mock.calls.map((call) => call[1]?.redirect)).toEqual(["manual", "manual"]);
  });

  it("safely classifies denial/account, app-configuration, and retryable failures", () => {
    expect(engine.classifyOAuthProviderError("access_denied")).toBe("denial-or-account");
    expect(engine.classifyOAuthProviderError(400, "invalid_grant")).toBe("denial-or-account");
    expect(engine.classifyOAuthProviderError(401, "INVALID_CLIENT")).toBe("app-configuration");
    expect(
      engine.classifyOAuthProviderError({ status: 400, providerCode: "unauthorized_client" })
    ).toBe("app-configuration");
    expect(engine.classifyOAuthProviderError(503, "temporarily_unavailable")).toBe("retryable");
    expect(engine.classifyOAuthProviderError(new TypeError("fetch failed"))).toBe("retryable");
    expect(engine.classifyOAuthProviderError("<script>invalid_client</script>")).toBe("retryable");
  });

  it("preserves refresh tokens and attaches safe provider classifications", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ access_token: "at-2" }));
    expect(await engine.refreshAccessToken(provider, "rt-original", "client")).toMatchObject({
      accessToken: "at-2",
      refreshToken: "rt-original",
    });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ error: "invalid_grant" }, false, 400)
    );
    await expect(engine.refreshAccessToken(provider, "rt", "client")).rejects.toMatchObject({
      status: 400,
      providerCode: "invalid_grant",
      classification: "denial-or-account",
      terminal: true,
    });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ error: "invalid_client", error_description: "do not expose me" }, false, 401)
    );
    await expect(engine.refreshAccessToken(provider, "rt", "client")).rejects.toMatchObject({
      status: 401,
      providerCode: "invalid_client",
      classification: "app-configuration",
      terminal: true,
      message: "OAuth token request failed (401, invalid_client)",
    });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ error: "temporarily_unavailable" }, false, 503)
    );
    await expect(engine.refreshAccessToken(provider, "rt", "client")).rejects.toMatchObject({
      status: 503,
      classification: "retryable",
      terminal: false,
    });
  });

  it("pins synthesized token requests, rejects redirects, and extracts bounded account identity", async () => {
    const synthesized = {
      ...provider,
      tokenUrl: "https://tokens.example.test/oauth/token",
      networkMode: "synthesized" as const,
    };
    network.resolve.mockResolvedValue({
      url: new URL(synthesized.tokenUrl),
      resolvedIp: "93.184.216.34",
      hostname: "tokens.example.test",
    });
    network.pinned.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          access_token: "access",
          account_id: "account-42",
          account_name: "Work account",
        })
      ),
      truncated: false,
      size: 100,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const tokens = await engine.exchangeCode(synthesized, "code", pendingFlow());

    expect(tokens.accountIdentity).toEqual({
      source: "account_id",
      value: "account-42",
      label: "Work account",
    });
    expect(network.resolve).toHaveBeenCalledWith(synthesized.tokenUrl);
    expect(network.pinned).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000, maxBytes: 128 * 1_024 })
    );
    expect(fetchMock).not.toHaveBeenCalled();

    network.pinned.mockResolvedValueOnce({
      status: 302,
      statusText: "Found",
      headers: { location: "https://other.example.test/token" },
      body: Buffer.alloc(0),
      truncated: false,
      size: 0,
    });
    await expect(engine.exchangeCode(synthesized, "code", pendingFlow())).rejects.toMatchObject({
      status: 302,
      providerCode: "redirect_rejected",
    });
  });
});
