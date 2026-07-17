import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationManifest } from "@chvor/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adaptOAuthProviders } from "../../lib/integration-manifest-resolver.ts";
import { OAUTH_PROVIDERS } from "../../lib/provider-registry.ts";

const composio = vi.hoisted(() => ({
  initiate: vi.fn(),
  list: vi.fn(),
  disconnect: vi.fn(),
  verify: vi.fn(),
}));
const network = vi.hoisted(() => ({ resolve: vi.fn(), pinned: vi.fn() }));
const catalog = vi.hoisted(() => ({ getActive: vi.fn() }));
vi.mock("../../lib/composio-client.ts", () => ({
  initiateConnection: composio.initiate,
  listConnectedAccounts: composio.list,
  disconnectAccount: composio.disconnect,
  verifyConnectedAccount: composio.verify,
}));
vi.mock("../../lib/synthesized/network.ts", () => ({
  resolveSafeSynthesizedTarget: network.resolve,
  pinnedHttpsRequest: network.pinned,
}));
vi.mock("../../lib/integration-manifest-catalog.ts", () => ({
  getActiveIntegrationManifest: catalog.getActive,
}));

const dataDir = mkdtempSync(join(tmpdir(), "chvor-oauth-security-"));
process.env.CHVOR_DATA_DIR = dataDir;

let oauth: (typeof import("../oauth.ts"))["default"];
let credentials: typeof import("../../db/credential-store.ts");
let setupStore: typeof import("../../db/integration-setup-store.ts");
let setupService: typeof import("../../lib/integration-setup-service.ts");
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function request(path: string, body?: unknown): Promise<Response> {
  return oauth.fetch(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

function createGoogleApp(name = "Google app", clientId = "google-client") {
  return credentials.createCredential(name, "google-oauth", {
    clientId,
    clientSecret: `${clientId}-secret`,
  });
}

function createManifestGoogleFlow(
  targetCredentialId: string,
  options: { oauthCredentialId?: string; oauthCreateAdditional?: boolean } = {}
) {
  const manifest = googleManifest();
  const created = setupStore.createIntegrationSetupFlow({
    integrationId: manifest.id,
    manifestVersion: manifest.version,
    manifestCredentialId: "credential.google-oauth",
    targetCredentialId,
    credentialType: "google-oauth",
    mode: options.oauthCredentialId ? "reauthenticate" : "setup",
  });
  const journaled = setupStore.initializeIntegrationSetupStepJournal(created.id, created.revision, [
    { id: "setup.oauth.direct", kind: "oauth" },
  ]);
  let flow = setupStore.advanceIntegrationSetupFlow(created.id, journaled.revision);
  if (options.oauthCredentialId || options.oauthCreateAdditional) {
    flow = setupStore.transitionIntegrationSetupFlow(flow.id, flow.revision, {
      ...(options.oauthCredentialId ? { oauthCredentialId: options.oauthCredentialId } : {}),
      ...(options.oauthCreateAdditional ? { oauthCreateAdditional: true } : {}),
    });
  }
  return flow;
}

function bindGoogleAccount(
  credentialId: string,
  options: { accountFingerprintSource?: string; accountLabel?: string } = {}
) {
  const manifest = googleManifest();
  return setupStore.upsertIntegrationCredentialBinding({
    credentialId,
    integrationId: manifest.id,
    manifestVersion: manifest.version,
    manifestCredentialId: "oauth.direct",
    authMethod: "oauth2",
    authStatus: "active",
    scopes: manifest.oauth[0]!.scopes,
    ...options,
  });
}

function googleManifest(): IntegrationManifest {
  const google = OAUTH_PROVIDERS.find((provider) => provider.id === "google");
  if (!google) throw new Error("Google OAuth provider fixture missing");
  const manifest = adaptOAuthProviders({ oauthProviders: [google] }).manifests.find(
    (item) => item.id === "oauth.google"
  );
  if (!manifest) throw new Error("Google OAuth manifest fixture missing");
  return manifest;
}

function createManifestOAuthFlow(manifest: IntegrationManifest, targetCredentialId: string) {
  const oauthStep = manifest.setup.find((step) => step.kind === "oauth");
  if (!oauthStep) throw new Error("OAuth setup fixture missing");
  const created = setupStore.createIntegrationSetupFlow({
    integrationId: manifest.id,
    manifestVersion: manifest.version,
    manifestCredentialId: "credential.google-oauth",
    targetCredentialId,
    credentialType: "google-oauth",
    mode: "setup",
  });
  const journaled = setupStore.initializeIntegrationSetupStepJournal(created.id, created.revision, [
    { id: oauthStep.id, kind: "oauth" },
  ]);
  return setupStore.advanceIntegrationSetupFlow(created.id, journaled.revision);
}

async function initiateGoogle(body: Record<string, unknown> = {}) {
  const response = await request("/initiate", { provider: "google", ...body });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    data: {
      redirectUrl: string;
      connectionId: string;
      flowId: string;
      callbackOrigin: string;
      oauthCredentialId?: string;
    };
  };
}

function pausedGoogleOAuthFlow() {
  const manifest = googleManifest();
  const account = credentials.createCredential("Existing Google account", "oauth-token-google", {
    accessToken: "existing-access",
    refreshToken: "existing-refresh",
    provider: "google",
    clientId: "google-client",
    oauthKind: "direct",
  });
  setupStore.upsertIntegrationCredentialBinding({
    credentialId: account.id,
    integrationId: manifest.id,
    manifestVersion: manifest.version,
    manifestCredentialId: "oauth.direct",
    authMethod: "oauth2",
    authStatus: "active",
    scopes: manifest.oauth[0]!.scopes,
    accountFingerprintSource: "account_id:account-1",
  });
  const started = setupService.startIntegrationSetup({
    schemaVersion: 1,
    integrationId: manifest.id,
    manifestVersion: manifest.version,
    manifestCredentialId: "credential.google-oauth",
    credentialType: "google-oauth",
    mode: "setup",
  });
  const paused = setupService.submitIntegrationSetupCredentials(started.id, {
    schemaVersion: 1,
    flowId: started.id,
    revision: started.revision,
    stepId: started.currentStepId!,
    data: { "client-id": "google-client", "client-secret": "google-client-secret" },
  });
  expect(paused).toMatchObject({
    status: "awaiting-confirmation",
    targetCredentialId: expect.any(String),
    duplicateCandidates: [expect.objectContaining({ id: account.id })],
  });
  return { account, paused };
}

beforeAll(async () => {
  ({ default: oauth } = await import("../oauth.ts"));
  credentials = await import("../../db/credential-store.ts");
  setupStore = await import("../../db/integration-setup-store.ts");
  setupService = await import("../../lib/integration-setup-service.ts");
  ({ getDb, closeDb } = await import("../../db/database.ts"));
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM integration_setup_flows").run();
  db.prepare("DELETE FROM credentials").run();
  composio.initiate.mockReset();
  composio.list.mockReset().mockResolvedValue([]);
  composio.disconnect.mockReset();
  composio.verify.mockReset().mockResolvedValue(false);
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

describe("OAuth flow lifecycle security", () => {
  it("never exchanges or persists tokens for terminal setup flows", async () => {
    createGoogleApp();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    for (const status of ["cancelled", "failed", "expired"] as const) {
      const initiated = await initiateGoogle();
      const flow = setupStore.getIntegrationSetupFlow(initiated.data.flowId)!;
      setupStore.transitionIntegrationSetupFlow(flow.id, flow.revision, {
        status,
        ...(status === "failed"
          ? { authStatus: "failed" as const, failureCode: "oauth_exchange_failed" }
          : {}),
      });

      const callback = await request(
        `/callback?code=must-not-exchange&state=${encodeURIComponent(initiated.data.connectionId)}`
      );
      expect(await callback.text()).toContain("expired or was already used");
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      credentials.listCredentials().filter((item) => item.type === "oauth-token-google")
    ).toHaveLength(0);
  });

  it("consumes state but rolls back token writes when cancellation happens during exchange", async () => {
    createGoogleApp();
    const initiated = await initiateGoogle();
    let resolveExchange!: (response: Response) => void;
    const exchange = new Promise<Response>((resolve) => {
      resolveExchange = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(exchange);

    const callbackPromise = request(
      `/callback?code=racing-code&state=${encodeURIComponent(initiated.data.connectionId)}`
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const active = setupStore.getIntegrationSetupFlow(initiated.data.flowId)!;
    setupStore.cancelIntegrationSetupFlow(active.id, active.revision);
    resolveExchange(tokenResponse({ access_token: "must-not-persist" }));

    const html = await (await callbackPromise).text();
    expect(html).toContain('"errorCode":"oauth_flow_inactive"');
    expect(setupStore.getIntegrationSetupFlow(active.id)?.status).toBe("cancelled");
    expect(
      credentials.listCredentials().filter((item) => item.type === "oauth-token-google")
    ).toHaveLength(0);
    expect(
      await (
        await request(
          `/callback?code=second-code&state=${encodeURIComponent(initiated.data.connectionId)}`
        )
      ).text()
    ).toContain("already used");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a callback when its manifest became inactive before token exchange", async () => {
    const app = createGoogleApp();
    const flow = createManifestGoogleFlow(app.id);
    const initiated = await initiateGoogle({ flowId: flow.id });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    catalog.getActive.mockReturnValue(null);

    const html = await (
      await request(
        `/callback?code=retired-manifest&state=${encodeURIComponent(initiated.data.connectionId)}`
      )
    ).text();

    expect(html).toContain('"errorCode":"oauth_manifest_changed"');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setupStore.getIntegrationSetupFlow(flow.id)?.status).toBe("awaiting-oauth");
    expect(
      credentials.listCredentials().filter((item) => item.type === "oauth-token-google")
    ).toHaveLength(0);
  });

  it("rejects a callback when its manifest becomes inactive during token exchange", async () => {
    const app = createGoogleApp();
    const flow = createManifestGoogleFlow(app.id);
    const initiated = await initiateGoogle({ flowId: flow.id });
    let resolveExchange!: (response: Response) => void;
    const exchange = new Promise<Response>((resolve) => {
      resolveExchange = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(exchange);

    const callbackPromise = request(
      `/callback?code=retiring-manifest&state=${encodeURIComponent(initiated.data.connectionId)}`
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    catalog.getActive.mockReturnValue(null);
    resolveExchange(tokenResponse({ access_token: "must-not-persist" }));

    const html = await (await callbackPromise).text();
    expect(html).toContain('"errorCode":"oauth_manifest_changed"');
    expect(setupStore.getIntegrationSetupFlow(flow.id)?.status).toBe("awaiting-oauth");
    expect(
      credentials.listCredentials().filter((item) => item.type === "oauth-token-google")
    ).toHaveLength(0);
  });

  it.each(["changed", "deleted"] as const)(
    "rejects callbacks when the OAuth app credential was %s after initiation",
    async (mutation) => {
      const app = createGoogleApp();
      const flow = createManifestGoogleFlow(app.id);
      const initiated = await initiateGoogle({ flowId: flow.id });
      const fetchMock = vi.spyOn(globalThis, "fetch");

      if (mutation === "changed") {
        credentials.updateCredential(app.id, undefined, { clientSecret: "rotated-secret" });
      } else {
        credentials.deleteCredential(app.id);
      }

      const html = await (
        await request(
          `/callback?code=must-not-exchange&state=${encodeURIComponent(initiated.data.connectionId)}`
        )
      ).text();

      expect(html).toContain('"errorCode":"oauth_credential_changed"');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(setupStore.getIntegrationSetupFlow(flow.id)?.status).toBe("awaiting-oauth");
      expect(
        credentials.listCredentials().filter((item) => item.type === "oauth-token-google")
      ).toHaveLength(0);
    }
  );

  it("does not overwrite a reauthentication target changed during token exchange", async () => {
    const app = createGoogleApp();
    const account = credentials.createCredential("Google account", "oauth-token-google", {
      accessToken: "original-access",
      refreshToken: "original-refresh",
      provider: "google",
      clientId: "google-client",
      oauthKind: "direct",
    });
    bindGoogleAccount(account.id);
    const flow = createManifestGoogleFlow(app.id, { oauthCredentialId: account.id });
    const initiated = await initiateGoogle({ flowId: flow.id });
    let resolveExchange!: (response: Response) => void;
    const exchange = new Promise<Response>((resolve) => {
      resolveExchange = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(exchange);

    const callbackPromise = request(
      `/callback?code=stale-code&state=${encodeURIComponent(initiated.data.connectionId)}`
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    credentials.updateCredential(account.id, undefined, {
      accessToken: "winning-access",
      refreshToken: "winning-refresh",
    });
    resolveExchange(
      tokenResponse({ access_token: "stale-access", refresh_token: "stale-refresh" })
    );

    const html = await (await callbackPromise).text();
    expect(html).toContain('"errorCode":"oauth_credential_changed"');
    expect(credentials.getCredentialData(account.id)?.data).toMatchObject({
      accessToken: "winning-access",
      refreshToken: "winning-refresh",
    });
    expect(setupStore.getIntegrationSetupFlow(flow.id)?.status).toBe("awaiting-oauth");
  });

  it("allows only the first of two overlapping reauthentication callbacks to win", async () => {
    const app = createGoogleApp();
    const account = credentials.createCredential("Google account", "oauth-token-google", {
      accessToken: "original-access",
      refreshToken: "original-refresh",
      provider: "google",
      clientId: "google-client",
      oauthKind: "direct",
    });
    bindGoogleAccount(account.id);
    const firstFlow = createManifestGoogleFlow(app.id, { oauthCredentialId: account.id });
    const secondFlow = createManifestGoogleFlow(app.id, { oauthCredentialId: account.id });
    const first = await initiateGoogle({ flowId: firstFlow.id });
    const second = await initiateGoogle({ flowId: secondFlow.id });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(tokenResponse({ access_token: "first-access" }))
      .mockResolvedValueOnce(tokenResponse({ access_token: "second-access" }));

    const firstHtml = await (
      await request(`/callback?code=first&state=${encodeURIComponent(first.data.connectionId)}`)
    ).text();
    const secondHtml = await (
      await request(`/callback?code=second&state=${encodeURIComponent(second.data.connectionId)}`)
    ).text();

    expect(firstHtml).toContain("Account Connected!");
    expect(secondHtml).toContain('"errorCode":"oauth_credential_changed"');
    expect(credentials.getCredentialData(account.id)?.data.accessToken).toBe("first-access");
    expect(setupStore.getIntegrationSetupFlow(secondFlow.id)?.status).toBe("awaiting-oauth");
  });
});

describe("OAuth initiation hardening", () => {
  it("blocks an app credential that becomes unusable before the provider exchange", async () => {
    const app = createGoogleApp();
    const manifest = googleManifest();
    const binding = setupStore.upsertIntegrationCredentialBinding({
      credentialId: app.id,
      integrationId: manifest.id,
      manifestVersion: manifest.version,
      manifestCredentialId: "credential.google-oauth",
      authMethod: "credential",
      authStatus: "active",
    });
    const initiated = await initiateGoogle({ appCredentialId: app.id });
    setupStore.updateIntegrationCredentialAuthState(binding, {
      authStatus: "reauthentication-required",
      failureCode: "reauthentication_required",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const html = await (
      await request(
        `/callback?code=blocked&state=${encodeURIComponent(initiated.data.connectionId)}`
      )
    ).text();

    expect(html).toContain('"errorCode":"oauth_app_credential_unavailable"');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)).toMatchObject({
      status: "failed",
      failureCode: "oauth_app_credential_unavailable",
    });
  });

  it("requires explicit app selection when multiple app credentials exist", async () => {
    const first = createGoogleApp("First", "first-client");
    const second = createGoogleApp("Second", "second-client");

    const ambiguous = await request("/initiate", { provider: "google" });
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({
      code: "oauth_app_credential_selection_required",
      needsAppCredentialSelection: true,
      candidateCredentialIds: expect.arrayContaining([first.id, second.id]),
    });

    const explicit = await initiateGoogle({ appCredentialId: second.id });
    expect(new URL(explicit.data.redirectUrl).searchParams.get("client_id")).toBe("second-client");
    expect(setupStore.getIntegrationSetupFlow(explicit.data.flowId)).toMatchObject({
      targetCredentialId: second.id,
    });
  });

  it("rejects case-insensitive reserved synthesized protocol parameters", async () => {
    const base = {
      credentialType: "demo-oauth",
      providerName: "Demo",
      clientId: "client",
      authUrl: "https://accounts.example.test/authorize",
      tokenUrl: "https://accounts.example.test/token",
      scopes: ["read"],
    };

    const auth = await request("/synthesized/initiate", {
      ...base,
      extraAuthParams: { Code_Challenge: "attacker" },
    });
    const token = await request("/synthesized/initiate", {
      ...base,
      extraTokenParams: { Redirect_URI: "https://attacker.test" },
    });

    expect(auth.status).toBe(400);
    expect(token.status).toBe(400);
    expect(JSON.stringify(await auth.json())).toMatch(/reserved/i);
    expect(JSON.stringify(await token.json())).toMatch(/reserved/i);
  });

  it("rejects provider, broker, and synthesized metadata that do not match the active manifest", async () => {
    const app = createGoogleApp();
    const directFlow = createManifestGoogleFlow(app.id);
    const otherDirect = OAUTH_PROVIDERS.find(
      (provider) => provider.method === "direct" && provider.id !== "google"
    );
    if (!otherDirect?.setupCredentialType) throw new Error("Direct OAuth fixture missing");
    credentials.createCredential("Other OAuth app", otherDirect.setupCredentialType, {
      clientId: "other-client",
      clientSecret: "other-secret",
    });

    const wrongDirect = await request("/initiate", {
      provider: otherDirect.id,
      flowId: directFlow.id,
    });
    expect(wrongDirect.status).toBe(400);

    const wrongSynthesized = await request("/synthesized/initiate", {
      flowId: directFlow.id,
      credentialType: "oauth-token-google",
      providerName: "Google lookalike",
      clientId: "google-client",
      clientSecret: "google-client-secret",
      authUrl: "https://attacker.example.test/authorize",
      tokenUrl: "https://attacker.example.test/token",
      scopes: googleManifest().oauth[0].scopes,
    });
    expect(wrongSynthesized.status).toBe(400);

    const manifest = googleManifest();
    const googleOauth = manifest.oauth[0];
    if (googleOauth.mode !== "direct") throw new Error("Google OAuth fixture is not direct");
    const undeclaredParameters = await request("/synthesized/initiate", {
      flowId: directFlow.id,
      credentialType: "oauth-token-google",
      providerName: "Google",
      clientId: "google-client",
      clientSecret: "google-client-secret",
      authUrl: googleOauth.authorizationUrl,
      tokenUrl: googleOauth.tokenUrl,
      scopes: googleOauth.scopes,
      extraAuthParams: { access_type: "online" },
    });
    expect(undeclaredParameters.status).toBe(400);

    const broker = OAUTH_PROVIDERS.find((provider) => provider.method === "composio");
    if (!broker) throw new Error("Broker OAuth fixture missing");
    credentials.createCredential("Composio", "composio", { apiKey: "broker-key" });
    const wrongBroker = await request("/initiate", {
      provider: broker.id,
      flowId: directFlow.id,
    });
    expect(wrongBroker.status).toBe(400);
    expect(composio.initiate).not.toHaveBeenCalled();

    expect(
      getDb()
        .prepare(
          "SELECT count(*) AS count FROM integration_setup_secret_envelopes WHERE flow_id = ? AND purpose = 'pkce'"
        )
        .get(directFlow.id)
    ).toEqual({ count: 0 });
  });

  it("rejects unjournaled and cross-integration OAuth account retargeting", async () => {
    const app = createGoogleApp();
    const rogue = credentials.createCredential("Other integration account", "oauth-token-google", {
      accessToken: "must-not-overwrite",
      provider: "google",
      clientId: "google-client",
    });
    setupStore.upsertIntegrationCredentialBinding({
      credentialId: rogue.id,
      integrationId: "oauth.other",
      manifestVersion: googleManifest().version,
      manifestCredentialId: "oauth.direct",
      authMethod: "oauth2",
      authStatus: "active",
    });
    const unbound = createManifestGoogleFlow(app.id);
    expect(
      (
        await request("/initiate", {
          provider: "google",
          flowId: unbound.id,
          oauthCredentialId: rogue.id,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request("/initiate", {
          provider: "google",
          flowId: unbound.id,
          targetCredentialId: rogue.id,
        })
      ).status
    ).toBe(400);

    const forged = createManifestGoogleFlow(app.id, { oauthCredentialId: rogue.id });
    expect((await request("/initiate", { provider: "google", flowId: forged.id })).status).toBe(
      400
    );
    expect(credentials.getCredentialData(rogue.id)?.data.accessToken).toBe("must-not-overwrite");
  });

  it("rejects synthesized initiation until manifests declare its mode and output type", async () => {
    const app = createGoogleApp();
    const directManifest = googleManifest();
    const directFlow = createManifestOAuthFlow(directManifest, app.id);
    const direct = directManifest.oauth[0];
    if (!direct || direct.mode !== "direct") throw new Error("Direct fixture missing");
    const requestBody = {
      providerName: "Google",
      clientId: "google-client",
      clientSecret: "google-client-secret",
      authUrl: direct.authorizationUrl,
      tokenUrl: direct.tokenUrl,
      scopes: direct.scopes,
      extraAuthParams: Object.fromEntries(
        (direct.authorizationParams ?? []).map(({ name, value }) => [name, value])
      ),
      extraTokenParams: Object.fromEntries(
        (direct.tokenParams ?? []).map(({ name, value }) => [name, value])
      ),
    };
    expect(
      (
        await request("/synthesized/initiate", {
          ...requestBody,
          flowId: directFlow.id,
          credentialType: "google-oauth",
        })
      ).status
    ).toBe(400);

    expect(
      getDb()
        .prepare(
          "SELECT count(*) AS count FROM integration_setup_secret_envelopes WHERE flow_id = ?"
        )
        .get(directFlow.id)
    ).toEqual({ count: 0 });
  });
});
describe("OAuth account identity", () => {
  it("pauses a manifest flow before PKCE using only scoped account metadata", async () => {
    const app = createGoogleApp();
    const existing = credentials.createCredential("Existing Google", "oauth-token-google", {
      accessToken: "existing-access-secret",
      provider: "google",
      clientId: "google-client",
    });
    bindGoogleAccount(existing.id, { accountLabel: "Existing work account" });
    const wrongIntegration = credentials.createCredential(
      "Wrong integration",
      "oauth-token-google",
      { accessToken: "wrong-integration-secret" }
    );
    const wrongDeclaration = credentials.createCredential(
      "Wrong declaration",
      "oauth-token-google",
      { accessToken: "wrong-declaration-secret" }
    );
    const wrongType = credentials.createCredential("Wrong type", "quickbooks", {
      accessToken: "wrong-type-secret",
    });
    const manifest = googleManifest();
    setupStore.upsertIntegrationCredentialBinding({
      credentialId: wrongIntegration.id,
      integrationId: "oauth.other",
      manifestVersion: manifest.version,
      manifestCredentialId: "oauth.direct",
      authMethod: "oauth2",
      authStatus: "active",
    });
    setupStore.upsertIntegrationCredentialBinding({
      credentialId: wrongDeclaration.id,
      integrationId: manifest.id,
      manifestVersion: manifest.version,
      manifestCredentialId: "oauth.synthesized",
      authMethod: "oauth2",
      authStatus: "active",
    });
    setupStore.upsertIntegrationCredentialBinding({
      credentialId: wrongType.id,
      integrationId: manifest.id,
      manifestVersion: manifest.version,
      manifestCredentialId: "oauth.direct",
      authMethod: "oauth2",
      authStatus: "active",
    });
    const flow = createManifestGoogleFlow(app.id);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    closeDb();
    const response = await request("/initiate", { provider: "google", flowId: flow.id });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      code: "oauth_account_decision_required",
      flowId: flow.id,
      duplicateCandidates: [
        {
          id: existing.id,
          name: "Existing Google",
          type: "oauth-token-google",
          accountLabel: "Existing work account",
          allowedDecisions: ["reuse-existing", "replace-existing"],
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("existing-access-secret");
    expect(JSON.stringify(payload)).not.toMatch(/wrong-(integration|declaration|type)-secret/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      getDb()
        .prepare(
          "SELECT count(*) AS count FROM integration_setup_secret_envelopes WHERE flow_id = ? AND purpose = 'pkce'"
        )
        .get(flow.id)
    ).toEqual({ count: 0 });
    const paused = setupStore.getIntegrationSetupFlow(flow.id)!;
    expect(paused).toMatchObject({
      status: "awaiting-confirmation",
      targetCredentialId: app.id,
      oauthCreateAdditional: false,
      duplicateCandidates: [expect.objectContaining({ id: existing.id })],
    });
  });
  it("rejects a post-exchange duplicate race without persisting exchanged tokens", async () => {
    const app = createGoogleApp();
    const flow = createManifestGoogleFlow(app.id);
    const initiated = await initiateGoogle({ flowId: flow.id });
    const raced = credentials.createCredential("Raced Google", "oauth-token-google", {
      accessToken: "winning-access-secret",
      provider: "google",
      clientId: "google-client",
    });
    bindGoogleAccount(raced.id, {
      accountFingerprintSource: "account_id:provider-account-42",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({
        access_token: "discarded-race-secret",
        account_id: "provider-account-42",
      })
    );
    const callbackPath = `/callback?code=race&state=${encodeURIComponent(initiated.data.connectionId)}`;
    const html = await (await request(callbackPath)).text();
    expect(html).toContain('"errorCode":"oauth_duplicate_account"');
    expect(html).toContain(`"duplicateCandidateIds":["${raced.id}"]`);
    expect(html).not.toContain("discarded-race-secret");
    const awaitingConfirmation = setupStore.getIntegrationSetupFlow(flow.id)!;
    expect(awaitingConfirmation).toMatchObject({
      status: "awaiting-confirmation",
      targetCredentialId: app.id,
      oauthCreateAdditional: false,
      duplicateCandidates: [expect.objectContaining({ id: raced.id })],
    });
    expect(
      credentials.listCredentials().filter((item) => item.type === "oauth-token-google")
    ).toHaveLength(1);
    expect(await (await request(callbackPath)).text()).toContain("already used");
    expect(fetchMock).toHaveBeenCalledOnce();

    const retry = setupService.confirmIntegrationSetupDuplicate(flow.id, {
      schemaVersion: 1,
      flowId: flow.id,
      revision: awaitingConfirmation.revision,
      decision: "create-additional",
    });
    expect(retry).toMatchObject({
      status: "awaiting-oauth",
      targetCredentialId: app.id,
      oauthCreateAdditional: true,
      duplicateCandidates: [],
    });
    const retryInitiated = await initiateGoogle({ flowId: retry.id });
    fetchMock.mockResolvedValueOnce(
      tokenResponse({
        access_token: "approved-duplicate-secret",
        account_id: "provider-account-42",
      })
    );
    const retryHtml = await (
      await request(
        `/callback?code=approved-duplicate&state=${encodeURIComponent(retryInitiated.data.connectionId)}`
      )
    ).text();
    expect(retryHtml).toContain("Account Connected!");
    expect(retryHtml).not.toContain('"errorCode":"oauth_duplicate_account"');
    const oauthCredentials = credentials
      .listCredentials()
      .filter((item) => item.type === "oauth-token-google");
    expect(oauthCredentials).toHaveLength(2);
    const additional = oauthCredentials.find((item) => item.id !== raced.id)!;
    expect(credentials.getCredentialData(additional.id)?.data.accessToken).toBe(
      "approved-duplicate-secret"
    );
    expect(setupStore.getIntegrationSetupFlow(flow.id)).toMatchObject({
      status: "completed",
      oauthCredentialId: additional.id,
      oauthCreateAdditional: false,
      duplicateCandidates: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
describe("OAuth account duplicate decisions", () => {
  it("reuses an active account by advancing OAuth without changing the app target", async () => {
    const { account, paused } = pausedGoogleOAuthFlow();
    const targetCredentialId = paused.targetCredentialId;
    const blockedInitiation = await request("/initiate", {
      provider: "google",
      flowId: paused.id,
    });
    expect(blockedInitiation.status).toBe(409);
    expect(await blockedInitiation.json()).toMatchObject({
      code: "oauth_account_decision_required",
      flowId: paused.id,
      duplicateCandidates: [expect.objectContaining({ id: account.id })],
    });

    const reused = setupService.confirmIntegrationSetupDuplicate(paused.id, {
      schemaVersion: 1,
      flowId: paused.id,
      revision: paused.revision,
      decision: "reuse-existing",
      credentialId: account.id,
    });

    expect(reused).toMatchObject({
      targetCredentialId,
      oauthCredentialId: account.id,
      authStatus: "active",
      duplicateCandidates: [],
    });
    expect(reused.steps.find((step) => step.kind === "oauth")?.status).toBe("completed");
    expect(credentials.getCredentialData(account.id)?.data.accessToken).toBe("existing-access");
  });
  it("replaces the exact selected account on callback and preserves both IDs across restart", async () => {
    const { account, paused } = pausedGoogleOAuthFlow();
    const targetCredentialId = paused.targetCredentialId!;
    const replace = setupService.confirmIntegrationSetupDuplicate(paused.id, {
      schemaVersion: 1,
      flowId: paused.id,
      revision: paused.revision,
      decision: "replace-existing",
      credentialId: account.id,
    });
    expect(replace).toMatchObject({
      status: "awaiting-oauth",
      targetCredentialId,
      oauthCredentialId: account.id,
    });

    closeDb();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const mismatched = await initiateGoogle({ flowId: replace.id });
    fetchMock.mockResolvedValueOnce(
      tokenResponse({ access_token: "wrong-account-access", account_id: "account-2" })
    );
    const mismatchHtml = await (
      await request(
        `/callback?code=mismatch&state=${encodeURIComponent(mismatched.data.connectionId)}`
      )
    ).text();
    expect(mismatchHtml).toContain('"errorCode":"oauth_account_mismatch"');
    expect(credentials.getCredentialData(account.id)?.data.accessToken).toBe("existing-access");
    expect(setupStore.getIntegrationSetupFlow(replace.id)?.status).toBe("awaiting-oauth");

    const unidentified = await initiateGoogle({ flowId: replace.id });
    fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: "unverifiable-access" }));
    const unidentifiedHtml = await (
      await request(
        `/callback?code=unidentified&state=${encodeURIComponent(unidentified.data.connectionId)}`
      )
    ).text();
    expect(unidentifiedHtml).toContain('"errorCode":"oauth_account_mismatch"');
    expect(credentials.getCredentialData(account.id)?.data.accessToken).toBe("existing-access");

    const initiated = await initiateGoogle({ flowId: replace.id });
    expect(initiated.data.oauthCredentialId).toBe(account.id);
    fetchMock.mockResolvedValueOnce(
      tokenResponse({ access_token: "replacement-access", account_id: "account-1" })
    );
    const html = await (
      await request(
        `/callback?code=replace&state=${encodeURIComponent(initiated.data.connectionId)}`
      )
    ).text();

    expect(html).toContain(`"credentialId":"${account.id}"`);
    expect(credentials.getCredentialData(account.id)?.data.accessToken).toBe("replacement-access");
    expect(
      credentials.listCredentials().filter((item) => item.type === "oauth-token-google")
    ).toHaveLength(1);
    expect(setupStore.getIntegrationSetupFlow(replace.id)).toMatchObject({
      status: "discovering",
      targetCredentialId,
      oauthCredentialId: account.id,
      oauthCreateAdditional: false,
      duplicateCandidates: [],
    });
  });
  it("creates an additional account after restart without re-pausing or overwriting the app target", async () => {
    const { account, paused } = pausedGoogleOAuthFlow();
    const targetCredentialId = paused.targetCredentialId!;
    const additional = setupService.confirmIntegrationSetupDuplicate(paused.id, {
      schemaVersion: 1,
      flowId: paused.id,
      revision: paused.revision,
      decision: "create-additional",
    });
    expect(additional).toMatchObject({
      status: "awaiting-oauth",
      targetCredentialId,
      oauthCreateAdditional: true,
      duplicateCandidates: [],
    });
    expect(additional.oauthCredentialId).toBeUndefined();

    closeDb();
    const initiated = await initiateGoogle({ flowId: additional.id });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      tokenResponse({ access_token: "additional-access", account_id: "account-2" })
    );
    await request(
      `/callback?code=additional&state=${encodeURIComponent(initiated.data.connectionId)}`
    );

    const tokens = credentials
      .listCredentials()
      .filter((item) => item.type === "oauth-token-google");
    expect(tokens).toHaveLength(2);
    const created = tokens.find((item) => item.id !== account.id)!;
    expect(credentials.getCredentialData(created.id)?.data.accessToken).toBe("additional-access");
    const existingBinding = setupStore.getIntegrationCredentialBinding({
      credentialId: account.id,
      integrationId: "oauth.google",
      manifestCredentialId: "oauth.direct",
    });
    const createdBinding = setupStore.getIntegrationCredentialBinding({
      credentialId: created.id,
      integrationId: "oauth.google",
      manifestCredentialId: "oauth.direct",
    });
    expect(createdBinding?.accountFingerprint).not.toBe(existingBinding?.accountFingerprint);
    expect(setupStore.getIntegrationSetupFlow(additional.id)).toMatchObject({
      status: "discovering",
      targetCredentialId,
      oauthCredentialId: created.id,
      oauthCreateAdditional: false,
      duplicateCandidates: [],
    });
  });
});
