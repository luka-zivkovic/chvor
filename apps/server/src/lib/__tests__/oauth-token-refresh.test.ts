import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ resolve: vi.fn(), pinned: vi.fn() }));
vi.mock("../synthesized/network.ts", () => ({
  resolveSafeSynthesizedTarget: network.resolve,
  pinnedHttpsRequest: network.pinned,
}));

const dataDir = mkdtempSync(join(tmpdir(), "chvor-oauth-refresh-"));
process.env.CHVOR_DATA_DIR = dataDir;

let refresh: typeof import("../oauth-token-refresh.ts");
let authGate: typeof import("../integration-auth-gate.ts");
let credentials: typeof import("../../db/credential-store.ts");
let leaseStore: typeof import("../../db/oauth-refresh-lease-store.ts");
let setupStore: typeof import("../../db/integration-setup-store.ts");
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;

function response(body: unknown, ok: boolean, status: number): Response {
  return new Response(JSON.stringify(body), { status: ok ? status : Math.max(status, 400) });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createSynthesizedCredential() {
  return credentials.createCredential("Demo OAuth", "demo-oauth", {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    provider: "demo-oauth",
    clientId: "client-id",
    clientSecret: "client-secret",
    tokenUrl: "https://demo.test/token",
    authUrl: "https://demo.test/authorize",
    scopes: "read write",
    oauthKind: "synthesized",
    oauthIntegrationId: "oauth.demo-oauth",
    oauthManifestVersion: "0.0.0",
    oauthManifestCredentialId: "oauth.synthesized",
  });
}

function createDirectGoogleCredentials() {
  const app = credentials.createCredential("Google app", "google-oauth", {
    clientId: "google-client",
    clientSecret: "google-secret",
  });
  const token = credentials.createCredential("Google OAuth", "oauth-token-google", {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
    provider: "google",
    clientId: "google-client",
    oauthKind: "direct",
    oauthIntegrationId: "oauth.google",
    oauthManifestVersion: "0.0.0",
    oauthManifestCredentialId: "oauth.direct",
    oauthAppCredentialId: app.id,
  });
  return { app, token };
}

function bindingFor(id: string) {
  return setupStore.getIntegrationCredentialBinding({
    credentialId: id,
    integrationId: "oauth.demo-oauth",
    manifestCredentialId: "oauth.synthesized",
  });
}

function directBindingFor(id: string) {
  return setupStore.getIntegrationCredentialBinding({
    credentialId: id,
    integrationId: "oauth.google",
    manifestCredentialId: "oauth.direct",
  });
}

beforeAll(async () => {
  refresh = await import("../oauth-token-refresh.ts");
  authGate = await import("../integration-auth-gate.ts");
  credentials = await import("../../db/credential-store.ts");
  leaseStore = await import("../../db/oauth-refresh-lease-store.ts");
  setupStore = await import("../../db/integration-setup-store.ts");
  ({ getDb, closeDb } = await import("../../db/database.ts"));
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM integration_setup_flows").run();
  db.prepare("DELETE FROM credentials").run();
  network.resolve.mockReset().mockImplementation(async (url: string) => ({
    url: new URL(url),
    resolvedIp: "93.184.216.34",
    hostname: new URL(url).hostname,
  }));
  network.pinned.mockReset();
});

afterEach(() => vi.restoreAllMocks());

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("refreshOAuthCredential", () => {
  it("serializes concurrent refresh requests for the same credential", async () => {
    const credential = createSynthesizedCredential();
    const pending = deferred<ReturnType<typeof pinnedResponse>>();
    network.pinned.mockReturnValue(pending.promise);

    const first = refresh.refreshOAuthCredential(credential.id, { force: true });
    const second = refresh.refreshOAuthCredential(credential.id, { force: true });
    await vi.waitFor(() => expect(network.pinned).toHaveBeenCalledTimes(1));
    pending.resolve(pinnedResponse({ access_token: "single-flight-access" }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ outcome: "refreshed" }),
      expect.objectContaining({ outcome: "refreshed" }),
    ]);
    expect(network.pinned).toHaveBeenCalledTimes(1);
  });

  it("observes a contended remote rotation without dispatching another token request", async () => {
    const credential = createSynthesizedCredential();
    const held = leaseStore.acquireOAuthRefreshLease(credential.id);
    if (held.outcome !== "acquired") throw new Error("expected remote refresh lease");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const refreshing = refresh.refreshOAuthCredential(credential.id, { force: true });

    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(network.resolve).not.toHaveBeenCalled();
      expect(network.pinned).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      credentials.updateCredential(credential.id, undefined, {
        accessToken: "remote-access",
        refreshToken: "remote-refresh",
        expiresAt,
      });
      setupStore.updateIntegrationCredentialAuthState(bindingFor(credential.id)!, {
        authStatus: "active",
        failureCode: null,
        tokenExpiresAt: expiresAt,
      });
      expect(leaseStore.releaseOAuthRefreshLease(held.leaseId)).toBe(true);

      await expect(refreshing).resolves.toEqual({
        credentialId: credential.id,
        outcome: "refreshed",
        expiresAt,
      });
      expect(network.resolve).not.toHaveBeenCalled();
      expect(network.pinned).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      leaseStore.releaseOAuthRefreshLease(held.leaseId);
    }
  });

  it("does not mistake an unrelated ciphertext edit for a remote refresh", async () => {
    const credential = createSynthesizedCredential();
    const held = leaseStore.acquireOAuthRefreshLease(credential.id);
    if (held.outcome !== "acquired") throw new Error("expected remote refresh lease");
    network.pinned.mockResolvedValue(
      pinnedResponse({ access_token: "locally-refreshed", expires_in: 3600 })
    );
    const refreshing = refresh.refreshOAuthCredential(credential.id, { force: true });

    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      credentials.updateCredential(credential.id, undefined, { note: "metadata-only-change" });
      expect(leaseStore.releaseOAuthRefreshLease(held.leaseId)).toBe(true);

      await expect(refreshing).resolves.toMatchObject({
        credentialId: credential.id,
        outcome: "refreshed",
      });
      expect(network.pinned).toHaveBeenCalledOnce();
      expect(credentials.getCredentialData(credential.id)?.data).toMatchObject({
        accessToken: "locally-refreshed",
        note: "metadata-only-change",
      });
    } finally {
      leaseStore.releaseOAuthRefreshLease(held.leaseId);
    }
  });

  it("persists rotated tokens but requires repair after an explicit scope downgrade", async () => {
    const credential = createSynthesizedCredential();
    network.pinned.mockResolvedValue(
      pinnedResponse({
        access_token: "reduced-access",
        refresh_token: "rotated-refresh",
        scope: "read",
        expires_in: 3600,
      })
    );

    await expect(
      refresh.refreshOAuthCredential(credential.id, { force: true })
    ).resolves.toMatchObject({
      credentialId: credential.id,
      outcome: "failed",
      terminal: true,
      failureCode: "oauth_insufficient_scope",
    });
    expect(credentials.getCredentialData(credential.id)?.data).toMatchObject({
      accessToken: "reduced-access",
      refreshToken: "rotated-refresh",
      scope: "read",
    });
    expect(bindingFor(credential.id)).toMatchObject({
      authStatus: "reauthentication-required",
      failureCode: "oauth_insufficient_scope",
      scopes: ["read"],
    });
  });

  it("does not let a stale invalid_grant mark a newer refresh success terminal", async () => {
    const credential = createSynthesizedCredential();
    const pending = deferred<ReturnType<typeof pinnedResponse>>();
    network.pinned.mockReturnValue(pending.promise);

    const staleRefresh = refresh.refreshOAuthCredential(credential.id, { force: true });
    await vi.waitFor(() => expect(network.pinned).toHaveBeenCalledTimes(1));
    credentials.updateCredential(credential.id, undefined, {
      accessToken: "newer-access",
      refreshToken: "newer-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    setupStore.updateIntegrationCredentialAuthState(bindingFor(credential.id)!, {
      authStatus: "active",
      failureCode: null,
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    pending.resolve(pinnedResponse({ error: "invalid_grant" }, 400));

    await expect(staleRefresh).resolves.toMatchObject({ outcome: "refreshed" });
    expect(credentials.getCredentialData(credential.id)?.data).toMatchObject({
      accessToken: "newer-access",
      refreshToken: "newer-refresh",
    });
    expect(bindingFor(credential.id)).toMatchObject({ authStatus: "active" });
    expect(bindingFor(credential.id)?.failureCode).toBeUndefined();
  });

  it("does not let a stale runtime expiry gate overwrite a newer refresh success", () => {
    const credential = createSynthesizedCredential();
    const stale = credentials.getCredentialData(credential.id)!;
    const staleBinding = setupStore.upsertIntegrationCredentialBinding({
      credentialId: credential.id,
      integrationId: "oauth.demo-oauth",
      manifestCredentialId: "oauth.synthesized",
      manifestVersion: "0.0.0",
      authMethod: "oauth2",
      authStatus: "active",
      tokenExpiresAt: stale.data.expiresAt,
    });
    const refreshedExpiry = new Date(Date.now() + 3_600_000).toISOString();

    credentials.updateCredential(credential.id, undefined, {
      accessToken: "newer-access",
      refreshToken: "newer-refresh",
      expiresAt: refreshedExpiry,
    });
    setupStore.updateIntegrationCredentialAuthState(staleBinding, {
      authStatus: "active",
      failureCode: null,
      tokenExpiresAt: refreshedExpiry,
    });

    expect(
      authGate.markCredentialBindingElapsedIfCurrent(
        credential.id,
        stale.cred.encryptedData,
        staleBinding,
        true
      )
    ).toMatchObject({ authStatus: "active", tokenExpiresAt: refreshedExpiry });
    expect(bindingFor(credential.id)).toMatchObject({
      authStatus: "active",
      tokenExpiresAt: refreshedExpiry,
    });
  });

  it("lets a later refresh success recover when a concurrent terminal result lands first", async () => {
    const credential = createSynthesizedCredential();
    const pending = deferred<ReturnType<typeof pinnedResponse>>();
    network.pinned.mockReturnValue(pending.promise);

    const successfulRefresh = refresh.refreshOAuthCredential(credential.id, { force: true });
    await vi.waitFor(() => expect(network.pinned).toHaveBeenCalledTimes(1));
    setupStore.updateIntegrationCredentialAuthState(bindingFor(credential.id)!, {
      authStatus: "reauthentication-required",
      failureCode: "oauth_invalid_grant",
    });
    pending.resolve(
      pinnedResponse({ access_token: "winning-access", refresh_token: "winning-refresh" })
    );

    await expect(successfulRefresh).resolves.toMatchObject({ outcome: "refreshed" });
    expect(credentials.getCredentialData(credential.id)?.data).toMatchObject({
      accessToken: "winning-access",
      refreshToken: "winning-refresh",
    });
    expect(bindingFor(credential.id)).toMatchObject({ authStatus: "active" });
    expect(bindingFor(credential.id)?.failureCode).toBeUndefined();
  });

  it("marks an elapsed OAuth token without a refresh token as requiring reauthentication", async () => {
    const credential = credentials.createCredential("Expired OAuth", "oauth-token-demo", {
      accessToken: "expired-access",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      provider: "demo",
      clientId: "client-id",
    });

    await expect(refresh.refreshOAuthCredential(credential.id)).resolves.toMatchObject({
      outcome: "failed",
      terminal: true,
      failureCode: "oauth_refresh_unavailable",
    });
    const [binding] = setupStore.listIntegrationCredentialBindingsForCredential(credential.id);
    expect(binding).toMatchObject({
      authStatus: "reauthentication-required",
      failureCode: "oauth_refresh_unavailable",
    });
  });

  it("marks invalid_grant as requiring reauthentication with a safe failure code", async () => {
    const credential = createSynthesizedCredential();
    network.pinned.mockResolvedValue(
      pinnedResponse({ error: "invalid_grant", error_description: "refresh revoked" }, 400)
    );

    const result = await refresh.refreshOAuthCredential(credential.id, { force: true });

    expect(result).toMatchObject({
      outcome: "failed",
      terminal: true,
      failureCode: "oauth_invalid_grant",
    });
    expect(bindingFor(credential.id)).toMatchObject({
      authStatus: "reauthentication-required",
      failureCode: "oauth_invalid_grant",
    });
  });

  it("durably marks invalid_client for repair and skips later automatic retries", async () => {
    const { token } = createDirectGoogleCredentials();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ error: "invalid_client" }, false, 401));

    await expect(refresh.refreshOAuthCredential(token.id, { force: true })).resolves.toMatchObject({
      outcome: "failed",
      terminal: true,
      failureCode: "oauth_invalid_client",
    });
    expect(directBindingFor(token.id)).toMatchObject({
      authStatus: "reauthentication-required",
      failureCode: "oauth_invalid_client",
    });

    await expect(refresh.refreshOAuthCredential(token.id)).resolves.toMatchObject({
      outcome: "failed",
      terminal: true,
      failureCode: "oauth_invalid_client",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not mark transient provider failures as requiring reauthentication", async () => {
    const credential = createSynthesizedCredential();
    network.pinned.mockResolvedValue(pinnedResponse({ error: "temporarily_unavailable" }, 503));

    const result = await refresh.refreshOAuthCredential(credential.id, { force: true });

    expect(result).toMatchObject({ outcome: "failed", terminal: false });
    expect(bindingFor(credential.id)?.authStatus).toBe("expired");
    expect(bindingFor(credential.id)?.failureCode).toBeUndefined();
  });

  it("keeps network refresh failures retryable", async () => {
    const credential = createSynthesizedCredential();
    network.pinned.mockRejectedValue(new Error("socket reset"));

    await expect(
      refresh.refreshOAuthCredential(credential.id, { force: true })
    ).resolves.toMatchObject({
      outcome: "failed",
      terminal: false,
      failureCode: "oauth_refresh_failed",
    });
    expect(bindingFor(credential.id)?.authStatus).toBe("expired");
    expect(bindingFor(credential.id)?.failureCode).toBeUndefined();
  });

  it("reactivates a revoked binding, clears stale failure/expiry, and rotates tokens", async () => {
    const credential = createSynthesizedCredential();
    refresh.ensureOAuthCredentialBinding(
      credential.id,
      credential.type,
      credentials.getCredentialData(credential.id)!.data
    );
    setupStore.updateIntegrationCredentialAuthState(bindingFor(credential.id)!, {
      authStatus: "reauthentication-required",
      failureCode: "oauth_invalid_grant",
    });
    network.pinned.mockResolvedValue(
      pinnedResponse({ access_token: "new-access", refresh_token: "new-refresh" })
    );

    const result = await refresh.refreshOAuthCredential(credential.id, { force: true });

    expect(result).toEqual({ credentialId: credential.id, outcome: "refreshed" });
    expect(credentials.getCredentialData(credential.id)?.data).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    expect(credentials.getCredentialData(credential.id)?.data.expiresAt).toBeUndefined();
    expect(bindingFor(credential.id)).toMatchObject({ authStatus: "active" });
    expect(bindingFor(credential.id)?.failureCode).toBeUndefined();
    expect(bindingFor(credential.id)?.tokenExpiresAt).toBeUndefined();
  });

  it("refreshes direct credentials with the separate provider client secret", async () => {
    credentials.createCredential("Wrong Google app", "google-oauth", {
      clientId: "wrong-client",
      clientSecret: "wrong-secret",
    });
    const app = credentials.createCredential("Google app", "google-oauth", {
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    const token = credentials.createCredential("Google OAuth", "oauth-token-google", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      provider: "google",
      clientId: "google-client",
      oauthKind: "direct",
      oauthIntegrationId: "oauth.google",
      oauthManifestVersion: "0.0.0",
      oauthManifestCredentialId: "oauth.direct",
      oauthAppCredentialId: app.id,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ access_token: "new-access", expires_in: 3600 }, true, 200));

    expect(await refresh.refreshOAuthCredential(token.id, { force: true })).toMatchObject({
      outcome: "refreshed",
    });
    const sent = new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string);
    expect(sent.get("client_secret")).toBe("google-secret");
    expect(sent.get("client_secret")).not.toBe("wrong-secret");
    expect(credentials.getCredentialData(token.id)?.data.accessToken).toBe("new-access");
  });

  it("does not commit direct refresh tokens after the app credential changes", async () => {
    const { app, token } = createDirectGoogleCredentials();
    const pending = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);

    const refreshing = refresh.refreshOAuthCredential(token.id, { force: true });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    credentials.updateCredential(app.id, undefined, { clientSecret: "rotated-secret" });
    pending.resolve(response({ access_token: "stale-new-access" }, true, 200));

    await expect(refreshing).resolves.toEqual({
      credentialId: token.id,
      outcome: "failed",
      terminal: false,
      failureCode: "oauth_app_credential_changed",
    });
    expect(credentials.getCredentialData(token.id)?.data.accessToken).toBe("old-access");
    expect(directBindingFor(token.id)?.authStatus).toBe("expired");
  });

  it("rechecks the direct app auth gate after the provider response", async () => {
    const { app, token } = createDirectGoogleCredentials();
    const appBinding = setupStore.upsertIntegrationCredentialBinding({
      credentialId: app.id,
      integrationId: "oauth.google",
      manifestVersion: "0.0.0",
      manifestCredentialId: "credential.google-oauth",
      authMethod: "credential",
      authStatus: "active",
    });
    const pending = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);

    const refreshing = refresh.refreshOAuthCredential(token.id, { force: true });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    setupStore.updateIntegrationCredentialAuthState(appBinding, {
      authStatus: "reauthentication-required",
      failureCode: "reauthentication_required",
    });
    pending.resolve(response({ access_token: "blocked-new-access" }, true, 200));

    await expect(refreshing).resolves.toEqual({
      credentialId: token.id,
      outcome: "failed",
      terminal: false,
      failureCode: "oauth_app_credential_changed",
    });
    expect(credentials.getCredentialData(token.id)?.data.accessToken).toBe("old-access");
  });

  it("does not commit direct refresh tokens after the app credential is deleted", async () => {
    const { app, token } = createDirectGoogleCredentials();
    const pending = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);

    const refreshing = refresh.refreshOAuthCredential(token.id, { force: true });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    credentials.deleteCredential(app.id);
    pending.resolve(response({ access_token: "stale-new-access" }, true, 200));

    await expect(refreshing).resolves.toEqual({
      credentialId: token.id,
      outcome: "failed",
      terminal: false,
      failureCode: "oauth_app_credential_changed",
    });
    expect(credentials.getCredentialData(token.id)?.data.accessToken).toBe("old-access");
    expect(directBindingFor(token.id)?.authStatus).toBe("expired");
  });

  it("does not mark a direct account terminal from a stale invalid_client app snapshot", async () => {
    const { app, token } = createDirectGoogleCredentials();
    const pending = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);

    const refreshing = refresh.refreshOAuthCredential(token.id, { force: true });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    credentials.updateCredential(app.id, undefined, { clientSecret: "rotated-secret" });
    pending.resolve(response({ error: "invalid_client" }, false, 401));

    await expect(refreshing).resolves.toEqual({
      credentialId: token.id,
      outcome: "failed",
      terminal: false,
      failureCode: "oauth_app_credential_changed",
    });
    expect(directBindingFor(token.id)).toMatchObject({ authStatus: "expired" });
    expect(directBindingFor(token.id)?.failureCode).toBeUndefined();
  });

  it("uniquely matches legacy direct app credentials by client ID and persists the exact ID", async () => {
    credentials.createCredential("Other Google app", "google-oauth", {
      clientId: "other-client",
      clientSecret: "other-secret",
    });
    const matchingApp = credentials.createCredential("Matching Google app", "google-oauth", {
      clientId: "legacy-client",
      clientSecret: "legacy-secret",
    });
    const token = credentials.createCredential("Legacy Google OAuth", "oauth-token-google", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      provider: "google",
      clientId: "legacy-client",
      oauthKind: "direct",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ access_token: "new-access" }, true, 200));

    expect(await refresh.refreshOAuthCredential(token.id, { force: true })).toMatchObject({
      outcome: "refreshed",
    });
    const sent = new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string);
    expect(sent.get("client_secret")).toBe("legacy-secret");
    expect(credentials.getCredentialData(token.id)?.data.oauthAppCredentialId).toBe(matchingApp.id);
  });

  it("skips ambiguous legacy app credentials instead of selecting an arbitrary secret", async () => {
    credentials.createCredential("First Google app", "google-oauth", {
      clientId: "shared-client",
      clientSecret: "first-secret",
    });
    credentials.createCredential("Second Google app", "google-oauth", {
      clientId: "shared-client",
      clientSecret: "second-secret",
    });
    const token = credentials.createCredential("Legacy Google OAuth", "oauth-token-google", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      provider: "google",
      clientId: "shared-client",
      oauthKind: "direct",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    expect(await refresh.refreshOAuthCredential(token.id, { force: true })).toEqual({
      credentialId: token.id,
      outcome: "skipped",
      failureCode: "oauth_app_credential_unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips unsafe synthesized token metadata without making a network request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const unsafeUrls = [
      "https://localhost/token",
      "https://127.0.0.1/token",
      "https://192.168.1.10/token",
      "http://public.example.test/token",
      "not-a-url",
    ];

    for (const [index, tokenUrl] of unsafeUrls.entries()) {
      const credential = credentials.createCredential(`Unsafe ${index}`, `unsafe-${index}`, {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        provider: `unsafe-${index}`,
        clientId: "client-id",
        tokenUrl,
        authUrl: "https://public.example.test/authorize",
        oauthKind: "synthesized",
      });

      expect(await refresh.refreshOAuthCredential(credential.id, { force: true })).toEqual({
        credentialId: credential.id,
        outcome: "skipped",
        failureCode: "oauth_provider_unknown",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(network.resolve).not.toHaveBeenCalled();
  });

  it("does not replace synthesized metadata when its provider id matches a built-in", () => {
    expect(
      refresh.getOAuthProviderConfigForCredential({
        provider: "google",
        oauthKind: "synthesized",
        tokenUrl: "https://custom.example.test/token",
        authUrl: "https://custom.example.test/authorize",
      })
    ).toMatchObject({
      id: "google",
      tokenUrl: "https://custom.example.test/token",
      authUrl: "https://custom.example.test/authorize",
    });
  });

  it("preserves legacy endpoint-metadata routing without oauthKind for built-in slugs", async () => {
    const credential = credentials.createCredential(
      "Legacy custom Google OAuth",
      "oauth-token-google",
      {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        provider: "google",
        clientId: "custom-client",
        clientSecret: "custom-secret",
        tokenUrl: "https://custom.example.test/token",
        authUrl: "https://custom.example.test/authorize",
      }
    );
    const fetchMock = vi.spyOn(globalThis, "fetch");
    network.pinned.mockResolvedValue(pinnedResponse({ access_token: "custom-access" }));

    await expect(
      refresh.refreshOAuthCredential(credential.id, { force: true })
    ).resolves.toMatchObject({ outcome: "refreshed" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(network.pinned).toHaveBeenCalledTimes(1);
    expect(network.resolve.mock.calls[0][0]).toBe("https://custom.example.test/token");
    expect(credentials.getCredentialData(credential.id)?.data.accessToken).toBe("custom-access");
  });
});

describe("runOAuthTokenRefreshCycle", () => {
  it("includes synthesized credentials and skips unrelated bearer credentials", async () => {
    const oauthCredential = createSynthesizedCredential();
    credentials.createCredential("Other", "custom", { accessToken: "not-oauth" });
    network.pinned.mockResolvedValue(
      pinnedResponse({ access_token: "new-access", expires_in: 60 })
    );

    const results = await refresh.runOAuthTokenRefreshCycle();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ credentialId: oauthCredential.id, outcome: "refreshed" });
  });
});
