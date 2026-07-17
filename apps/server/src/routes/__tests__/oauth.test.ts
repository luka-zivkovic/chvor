import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adaptOAuthProviders } from "../../lib/integration-manifest-resolver.ts";
import { OAUTH_PROVIDERS } from "../../lib/provider-registry.ts";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-oauth-routes-"));
process.env.CHVOR_DATA_DIR = dataDir;

const composio = vi.hoisted(() => ({
  initiate: vi.fn(),
  list: vi.fn(),
  disconnect: vi.fn(),
}));
const network = vi.hoisted(() => ({ resolve: vi.fn(), pinned: vi.fn() }));
const catalog = vi.hoisted(() => ({ getActive: vi.fn() }));
vi.mock("../../lib/composio-client.ts", () => ({
  initiateConnection: composio.initiate,
  listConnectedAccounts: composio.list,
  disconnectAccount: composio.disconnect,
}));
vi.mock("../../lib/synthesized/network.ts", () => ({
  resolveSafeSynthesizedTarget: network.resolve,
  pinnedHttpsRequest: network.pinned,
}));
vi.mock("../../lib/integration-manifest-catalog.ts", () => ({
  getActiveIntegrationManifest: catalog.getActive,
}));

let oauth: (typeof import("../oauth.ts"))["default"];
let callbackHtml: typeof import("../oauth.ts").callbackHtml;
let credentials: typeof import("../../db/credential-store.ts");
let setupStore: typeof import("../../db/integration-setup-store.ts");
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;

function tokenResponse(body: unknown, _ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pinnedResponse(body: unknown, status = 200) {
  const encoded = Buffer.from(JSON.stringify(body));
  return {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {},
    body: encoded,
    truncated: false,
    size: encoded.byteLength,
  };
}

async function request(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<Response> {
  return oauth.fetch(
    new Request(`http://localhost${path}`, {
      method: init?.method,
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    })
  );
}

function createGoogleApp() {
  return credentials.createCredential("Google app", "google-oauth", {
    clientId: "google-client",
    clientSecret: "google-secret",
  });
}

function googleManifest() {
  const google = OAUTH_PROVIDERS.find((provider) => provider.id === "google");
  if (!google) throw new Error("Google OAuth provider fixture missing");
  const manifest = adaptOAuthProviders({ oauthProviders: [google] }).manifests.find(
    (item) => item.id === "oauth.google"
  );
  if (!manifest) throw new Error("Google OAuth manifest fixture missing");
  return manifest;
}

async function initiateGoogle() {
  const response = await request("/initiate", {
    method: "POST",
    body: { provider: "google" },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    data: {
      redirectUrl: string;
      connectionId: string;
      flowId: string;
      method: string;
      callbackOrigin: string;
      oauthCredentialId?: string;
    };
  };
}

function createGoogleReauthenticationFlow(appCredentialId: string, oauthCredentialId: string) {
  const manifest = googleManifest();
  const oauthStep = manifest.setup.find((step) => step.kind === "oauth");
  if (!oauthStep) throw new Error("Google OAuth setup step missing");
  setupStore.upsertIntegrationCredentialBinding({
    credentialId: oauthCredentialId,
    integrationId: manifest.id,
    manifestVersion: manifest.version,
    manifestCredentialId: "oauth.direct",
    authMethod: "oauth2",
    authStatus: "reauthentication-required",
    failureCode: "oauth_refresh_unavailable",
  });
  const created = setupStore.createIntegrationSetupFlow({
    integrationId: manifest.id,
    manifestVersion: manifest.version,
    manifestCredentialId: "credential.google-oauth",
    targetCredentialId: appCredentialId,
    credentialType: "google-oauth",
    mode: "reauthenticate",
  });
  const journaled = setupStore.initializeIntegrationSetupStepJournal(created.id, created.revision, [
    { id: oauthStep.id, kind: "oauth" },
  ]);
  const awaitingOAuth = setupStore.advanceIntegrationSetupFlow(created.id, journaled.revision);
  return setupStore.transitionIntegrationSetupFlow(awaitingOAuth.id, awaitingOAuth.revision, {
    oauthCredentialId,
  });
}

beforeAll(async () => {
  ({ default: oauth, callbackHtml } = await import("../oauth.ts"));
  credentials = await import("../../db/credential-store.ts");
  setupStore = await import("../../db/integration-setup-store.ts");
  ({ getDb, closeDb } = await import("../../db/database.ts"));
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM integration_setup_flows").run();
  db.prepare("DELETE FROM credentials").run();
  composio.initiate.mockReset();
  composio.list.mockReset().mockResolvedValue([]);
  composio.disconnect.mockReset();
  network.resolve.mockReset().mockImplementation(async (url: string) => ({
    url: new URL(url),
    resolvedIp: "93.184.216.34",
    hostname: new URL(url).hostname,
  }));
  network.pinned.mockReset();
  const manifest = googleManifest();
  catalog.getActive
    .mockReset()
    .mockImplementation((id: string) => (id === manifest.id ? manifest : null));
});

afterEach(() => vi.restoreAllMocks());

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("direct OAuth routes", () => {
  it("keeps response envelopes and completes a callback after a database restart", async () => {
    const appCredential = createGoogleApp();
    const initiated = await initiateGoogle();
    expect(initiated.data).toMatchObject({
      method: "direct",
      callbackOrigin: "http://localhost:9147",
    });
    expect(new URL(initiated.data.redirectUrl).searchParams.get("state")).toBe(
      initiated.data.connectionId
    );
    expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)?.status).toBe(
      "awaiting-oauth"
    );

    closeDb();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({
        access_token: "google-access",
        refresh_token: "google-refresh",
        expires_in: 3600,
      })
    );
    const callback = await request(
      `/callback?code=auth-code&state=${encodeURIComponent(initiated.data.connectionId)}`
    );
    const html = await callback.text();
    const token = credentials
      .listCredentials()
      .find((credential) => credential.type === "oauth-token-google");
    expect(token).toBeDefined();
    const tokenRequest = new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string);
    expect(tokenRequest.getAll("client_id")).toEqual(["google-client"]);
    expect(tokenRequest.getAll("client_secret")).toEqual(["google-secret"]);
    expect(html).toContain(`"flowId":"${initiated.data.flowId}"`);
    expect(html).toContain(`"credentialId":"${token!.id}"`);
    expect(html).toContain(`"connectionId":"${initiated.data.connectionId}"`);
    expect(html).not.toContain(`"connectionId":"${token!.id}"`);
    expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)).toMatchObject({
      status: "completed",
      authStatus: "active",
      targetCredentialId: appCredential.id,
      oauthCredentialId: token!.id,
    });
    expect(credentials.getCredentialData(token!.id)?.data.oauthAppCredentialId).toBe(
      appCredential.id
    );

    const connections = await request("/connections");
    expect(await connections.json()).toMatchObject({
      data: [
        {
          id: token!.id,
          platform: "google",
          status: "active",
          authStatus: "active",
          needsReauthentication: false,
        },
      ],
    });
  });

  it("consumes callback state once and never creates a second credential", async () => {
    createGoogleApp();
    const initiated = await initiateGoogle();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(tokenResponse({ access_token: "access" }));
    const path = `/callback?code=code&state=${encodeURIComponent(initiated.data.connectionId)}`;

    expect(await (await request(path)).text()).toContain("Account Connected!");
    expect(await (await request(path)).text()).toContain("already used");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      credentials.listCredentials().filter((item) => item.type === "oauth-token-google")
    ).toHaveLength(1);
  });

  it("rejects an explicit provider scope downgrade instead of completing setup", async () => {
    createGoogleApp();
    const initiated = await initiateGoogle();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({ access_token: "reduced-access", scope: "openid" })
    );

    const html = await (
      await request(
        `/callback?code=reduced&state=${encodeURIComponent(initiated.data.connectionId)}`
      )
    ).text();

    expect(html).toContain('"errorCode":"oauth_insufficient_scope"');
    expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)).toMatchObject({
      status: "failed",
      failureCode: "oauth_insufficient_scope",
    });
    expect(
      credentials.listCredentials().filter((item) => item.type === "oauth-token-google")
    ).toHaveLength(0);
  });

  it("updates only an explicit reauthentication target and preserves its ID", async () => {
    const appCredential = createGoogleApp();
    const manifest = googleManifest();
    const target = credentials.createCredential("Existing Google", "oauth-token-google", {
      accessToken: "stale-access",
      refreshToken: "stale-refresh",
      provider: "google",
      clientId: "google-client",
      oauthKind: "direct",
      oauthIntegrationId: manifest.id,
      oauthManifestVersion: manifest.version,
      oauthManifestCredentialId: "oauth.direct",
      oauthAppCredentialId: appCredential.id,
    });
    const flow = createGoogleReauthenticationFlow(appCredential.id, target.id);
    const connections = await request("/connections");
    expect(await connections.json()).toMatchObject({
      data: [
        {
          id: target.id,
          needsReauthentication: true,
          reauthenticationTarget: {
            integrationId: manifest.id,
            manifestVersion: manifest.version,
            manifestCredentialId: "credential.google-oauth",
            oauthManifestCredentialId: "oauth.direct",
            credentialType: "google-oauth",
            targetCredentialId: appCredential.id,
            oauthCredentialId: target.id,
          },
        },
      ],
    });
    const initiateResponse = await request("/initiate", {
      method: "POST",
      body: { provider: "google", flowId: flow.id },
    });
    expect(initiateResponse.status).toBe(200);
    const initiated = (await initiateResponse.json()) as {
      data: { connectionId: string; flowId: string; oauthCredentialId?: string };
    };
    expect(initiated.data.oauthCredentialId).toBe(target.id);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({ access_token: "fresh-access", refresh_token: "fresh-refresh" })
    );

    await request(
      `/callback?code=reauth-code&state=${encodeURIComponent(initiated.data.connectionId)}`
    );

    const matching = credentials
      .listCredentials()
      .filter((credential) => credential.type === "oauth-token-google");
    expect(matching.map((credential) => credential.id)).toEqual([target.id]);
    expect(credentials.getCredentialData(target.id)?.data).toMatchObject({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
    });
    expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)).toMatchObject({
      targetCredentialId: appCredential.id,
      oauthCredentialId: target.id,
    });
  });

  it("rejects standalone direct reauthentication targets before creating a legacy flow", async () => {
    createGoogleApp();
    const target = credentials.createCredential("Existing Google", "oauth-token-google", {
      accessToken: "stale-access",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      provider: "google",
      clientId: "google-client",
    });

    const legacyConnections = (await (await request("/connections")).json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(legacyConnections.data).toContainEqual(
      expect.objectContaining({ id: target.id, needsReauthentication: true })
    );
    expect(
      legacyConnections.data.find((connection) => connection.id === target.id)
    ).not.toHaveProperty("reauthenticationTarget");

    const response = await request("/initiate", {
      method: "POST",
      body: { provider: "google", oauthCredentialId: target.id },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Direct OAuth reauthentication requires an active manifest setup flow.",
      code: "oauth_manifest_reauthentication_required",
    });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM integration_setup_flows").get()).toEqual({
      count: 0,
    });
  });

  it("creates a distinct token for a manifest flow whose credential-step target is the OAuth app", async () => {
    const appCredential = createGoogleApp();
    credentials.createCredential("Other Google app", "google-oauth", {
      clientId: "other-google-client",
      clientSecret: "other-google-secret",
    });
    const created = setupStore.createIntegrationSetupFlow({
      integrationId: "oauth.google",
      manifestVersion: "0.0.0",
      manifestCredentialId: "credential.google-oauth",
      targetCredentialId: appCredential.id,
      credentialType: "google-oauth",
      mode: "setup",
    });
    const journaled = setupStore.initializeIntegrationSetupStepJournal(
      created.id,
      created.revision,
      [
        { id: "setup.credential.google-oauth", kind: "credential" },
        { id: "setup.oauth.direct", kind: "oauth" },
      ]
    );
    const credentialStep = setupStore.advanceIntegrationSetupFlow(created.id, journaled.revision);
    const oauthStep = setupStore.advanceIntegrationSetupFlow(created.id, credentialStep.revision);
    expect(oauthStep).toMatchObject({
      status: "awaiting-oauth",
      currentStepId: "setup.oauth.direct",
      targetCredentialId: appCredential.id,
    });

    const initiateResponse = await request("/initiate", {
      method: "POST",
      body: { provider: "google", flowId: created.id },
    });
    expect(initiateResponse.status).toBe(200);
    const initiated = (await initiateResponse.json()) as {
      data: { connectionId: string; flowId: string };
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        tokenResponse({ access_token: "manifest-access", refresh_token: "manifest-refresh" })
      );
    await request(
      `/callback?code=manifest-code&state=${encodeURIComponent(initiated.data.connectionId)}`
    );

    expect(credentials.getCredentialData(appCredential.id)?.data).toEqual({
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    const token = credentials
      .listCredentials()
      .find((credential) => credential.type === "oauth-token-google");
    expect(token?.id).not.toBe(appCredential.id);
    const tokenRequest = new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string);
    expect(tokenRequest.get("client_id")).toBe("google-client");
    expect(tokenRequest.get("client_secret")).toBe("google-secret");
    expect(setupStore.getIntegrationSetupFlow(created.id)).toMatchObject({
      status: "completed",
      targetCredentialId: appCredential.id,
      oauthCredentialId: token!.id,
    });
    expect(
      setupStore.getIntegrationCredentialBinding({
        credentialId: token!.id,
        integrationId: "oauth.google",
        manifestCredentialId: "oauth.direct",
      })
    ).toMatchObject({ authStatus: "active" });
  });
});

describe("synthesized OAuth routes", () => {
  it("durably completes a synthesized flow and lists its binding state", async () => {
    const initiatedResponse = await request("/synthesized/initiate", {
      method: "POST",
      body: {
        credentialType: "quickbooks",
        providerName: "QuickBooks",
        clientId: "quickbooks-client",
        clientSecret: "quickbooks-secret",
        authUrl: "https://accounts.example.test/authorize",
        tokenUrl: "https://accounts.example.test/token",
        scopes: ["accounting.read"],
        extraTokenParams: { audience: "accounting" },
      },
    });
    expect(initiatedResponse.status).toBe(200);
    const initiated = (await initiatedResponse.json()) as {
      data: {
        connectionId: string;
        flowId: string;
        method: string;
        callbackOrigin: string;
      };
    };
    expect(initiated.data.method).toBe("synthesized");
    expect(initiated.data).toMatchObject({ callbackOrigin: "http://localhost:9147" });

    closeDb();
    network.pinned.mockResolvedValue(
      pinnedResponse({
        access_token: "quickbooks-access",
        refresh_token: "quickbooks-refresh",
        scope: "accounting.read",
      })
    );
    await request(
      `/callback?code=synth-code&state=${encodeURIComponent(initiated.data.connectionId)}`
    );

    const token = credentials
      .listCredentials()
      .find((credential) => credential.type === "quickbooks");
    expect(token).toBeDefined();
    expect(credentials.getCredentialData(token!.id)?.data).toMatchObject({
      oauthKind: "synthesized",
      provider: "quickbooks",
      tokenUrl: "https://accounts.example.test/token",
      clientSecret: "quickbooks-secret",
    });
    const connections = (await (await request("/connections")).json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(connections.data).toContainEqual(
      expect.objectContaining({
        id: token!.id,
        oauthKind: "synthesized",
        authStatus: "active",
      })
    );
  });
});

describe("callback safety and refresh compatibility", () => {
  it("escapes callback copy and serializes only safe correlation fields", () => {
    const html = callbackHtml(false, `bad </script><img src=x onerror=alert(1)>`, {
      flowId: "flow.safe",
      credentialId: `bad</script>`,
      connectionId: "connection-safe",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain(`"credentialId":"bad</script>"`);
    expect(html).toContain(`"flowId":"flow.safe"`);
    expect(html).toContain(`"connectionId":"connection-safe"`);
    expect(html).toContain("&lt;/script&gt;&lt;img");

    const base64UrlState = callbackHtml(true, "Connected", {
      flowId: "flow.safe",
      connectionId: "_base64url-state",
    });
    expect(base64UrlState).toContain(`"connectionId":"_base64url-state"`);

    const exactOrigin = callbackHtml(
      true,
      "Connected",
      { flowId: "flow.safe" },
      "https://app.example.test"
    );
    expect(exactOrigin).toContain('"https://app.example.test"');
    expect(exactOrigin).not.toMatch(/postMessage\([^)]*,\s*["']\*["']\)/);
    expect(html).not.toMatch(/postMessage\([^)]*,\s*["']\*["']\)/);
  });

  it("correlates provider-error callbacks to the original state and durable flow", async () => {
    createGoogleApp();
    const initiated = await initiateGoogle();

    const response = await request(
      `/callback?error=access_denied&state=${encodeURIComponent(initiated.data.connectionId)}`
    );
    const html = await response.text();

    expect(html).toContain(`"flowId":"${initiated.data.flowId}"`);
    expect(html).toContain(`"connectionId":"${initiated.data.connectionId}"`);
    expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)).toMatchObject({
      status: "failed",
      failureCode: "oauth_authorization_denied",
    });
  });

  it("keeps retryable provider callbacks resumable and accepts a fresh attempt", async () => {
    const app = createGoogleApp();
    const initiated = await initiateGoogle();

    const response = await request(
      `/callback?error=temporarily_unavailable&state=${encodeURIComponent(initiated.data.connectionId)}`
    );
    const html = await response.text();

    expect(html).toContain('"errorCode":"oauth_provider_retryable"');
    expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)).toMatchObject({
      status: "awaiting-oauth",
      authStatus: "unknown",
    });
    const retry = await request("/initiate", {
      method: "POST",
      body: { provider: "google", flowId: initiated.data.flowId, appCredentialId: app.id },
    });
    expect(retry.status).toBe(200);
  });

  it("distinguishes retryable token failures from app configuration failures", async () => {
    const app = createGoogleApp();
    const retryable = await initiateGoogle();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse({ error: "server_error" }, false, 503));

    const retryableHtml = await (
      await request(`/callback?code=retry&state=${encodeURIComponent(retryable.data.connectionId)}`)
    ).text();
    expect(retryableHtml).toContain('"errorCode":"oauth_provider_retryable"');
    expect(setupStore.getIntegrationSetupFlow(retryable.data.flowId)?.status).toBe(
      "awaiting-oauth"
    );

    const invalidClient = await initiateGoogle();
    fetchMock.mockResolvedValueOnce(tokenResponse({ error: "invalid_client" }, false, 401));
    const invalidClientHtml = await (
      await request(
        `/callback?code=invalid&state=${encodeURIComponent(invalidClient.data.connectionId)}`
      )
    ).text();
    expect(invalidClientHtml).toContain('"errorCode":"oauth_app_configuration_error"');
    expect(setupStore.getIntegrationSetupFlow(invalidClient.data.flowId)).toMatchObject({
      status: "failed",
      failureCode: "oauth_app_configuration_error",
    });
    expect(setupStore.listIntegrationCredentialBindingsForCredential(app.id)).toEqual([
      expect.objectContaining({
        authStatus: "reauthentication-required",
        failureCode: "oauth_app_configuration_error",
      }),
    ]);
  });

  it("returns safe reauthentication metadata for terminal forced refresh", async () => {
    const token = credentials.createCredential("Synth", "synth", {
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      provider: "synth",
      clientId: "client",
      tokenUrl: "https://synth.example.test/token",
      authUrl: "https://synth.example.test/auth",
      oauthKind: "synthesized",
    });
    network.pinned.mockResolvedValue(
      pinnedResponse({ error: "invalid_grant", error_description: "secret provider detail" }, 400)
    );

    const response = await request(`/refresh/${token.id}`, { method: "POST" });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "OAuth authorization is no longer valid. Reauthenticate this account.",
      code: "oauth_invalid_grant",
      needsReauthentication: true,
      credentialId: token.id,
    });
  });

  it("preserves data envelopes across successful listing, refresh, and disconnect routes", async () => {
    const providers = (await (await request("/providers")).json()) as Record<string, unknown>;
    const redirect = (await (await request("/synthesized/redirect-url")).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(providers)).toEqual(["data"]);
    expect(Object.keys(redirect)).toEqual(["data"]);

    const token = credentials.createCredential("Synth", "synth", {
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      provider: "synth",
      clientId: "client",
      tokenUrl: "https://synth.example.test/token",
      authUrl: "https://synth.example.test/auth",
      oauthKind: "synthesized",
    });
    network.pinned.mockResolvedValue(pinnedResponse({ access_token: "new", expires_in: 60 }));

    const refreshed = await request(`/refresh/${token.id}`, { method: "POST" });
    expect(await refreshed.json()).toMatchObject({
      data: { refreshed: true, authStatus: "active" },
    });
    const disconnected = await request(`/connections/${token.id}`, { method: "DELETE" });
    expect(await disconnected.json()).toEqual({
      data: { disconnected: true, method: "direct" },
    });
  });
});
