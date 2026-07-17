import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationManifestV2 } from "@chvor/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  integrationOAuthAccountScope,
  reusableIntegrationOAuthAccountBinding,
  validIntegrationCredentialFieldValue,
} from "../integration-setup-validation.ts";

const urlField = {
  id: "endpoint",
  label: "Endpoint",
  description: "Service endpoint.",
  sensitivity: "url" as const,
  required: true,
};
const pathField = {
  id: "vault-path",
  label: "Vault path",
  description: "Local vault path.",
  sensitivity: "path" as const,
  required: true,
};

describe("manifest credential value validation", () => {
  it.each([
    "https://api.example.test/v1",
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://127.12.34.56:8000/v1",
    "http://[::1]:8000/v1",
    "http://homeassistant.local:8123",
  ])("allows secure or local URL %s", (value) => {
    expect(validIntegrationCredentialFieldValue(urlField, value)).toBe(true);
  });

  it.each([
    "http://api.example.test/v1",
    "http://192.168.1.20:8123",
    "http://localhost.evil.test/v1",
    "http://127.attacker.test/v1",
    "http://user:secret@localhost:11434/v1",
    "http://localhost:11434/v1#fragment",
    "ftp://localhost/model",
    `http://localhost/${"x".repeat(1_024)}`,
    "http://localhost/unsafe\npath",
  ])("rejects insecure or unsafe URL %s", (value) => {
    expect(validIntegrationCredentialFieldValue(urlField, value)).toBe(false);
  });

  it.each([
    "/Users/me/Vault",
    "./relative/vault",
    ".\\relative\\vault",
    "C:\\Users\\me\\Vault",
    "D:/Models/cache",
  ])("allows supported path %s", (value) => {
    expect(validIntegrationCredentialFieldValue(pathField, value)).toBe(true);
  });

  it.each([
    "relative/vault",
    "C:relative\\vault",
    "\\\\server\\share",
    "/unsafe\npath",
    `/${"x".repeat(1_024)}`,
  ])("rejects unsafe or ambiguous path %s", (value) => {
    expect(validIntegrationCredentialFieldValue(pathField, value)).toBe(false);
  });
});

const dataDir = mkdtempSync(join(tmpdir(), "chvor-integration-setup-validation-"));
process.env.CHVOR_DATA_DIR = dataDir;
const manifestMocks = vi.hoisted(() => ({ getActive: vi.fn() }));
vi.mock("../integration-manifest-catalog.ts", () => ({
  getActiveIntegrationManifest: manifestMocks.getActive,
}));

let service: typeof import("../integration-setup-service.ts");
let setupStore: typeof import("../../db/integration-setup-store.ts");
let credentials: typeof import("../../db/credential-store.ts");
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;
let manifest: IntegrationManifestV2;

beforeAll(async () => {
  service = await import("../integration-setup-service.ts");
  setupStore = await import("../../db/integration-setup-store.ts");
  credentials = await import("../../db/credential-store.ts");
  ({ getDb, closeDb } = await import("../../db/database.ts"));
  const { OAUTH_PROVIDERS } = await import("../provider-registry.ts");
  const { adaptOAuthProviders } = await import("../integration-manifest-resolver.ts");
  const google = OAUTH_PROVIDERS.find((provider) => provider.id === "google")!;
  const base = adaptOAuthProviders({ oauthProviders: [google] }).manifests[0]!;
  if (base.schemaVersion !== 2) throw new Error("OAuth adapter did not emit a v2 manifest");
  const primary = base.oauth[0]!;
  const primaryStep = base.setup.find((step) => step.kind === "oauth")!;
  manifest = {
    ...base,
    oauth: [...base.oauth, { ...primary, id: "oauth.secondary" }],
    setup: [
      ...base.setup,
      { ...primaryStep, id: "setup.oauth-secondary", oauthId: "oauth.secondary" },
    ],
  };
});

beforeEach(() => {
  getDb().prepare("DELETE FROM integration_setup_flows").run();
  getDb().prepare("DELETE FROM integration_credential_bindings").run();
  getDb().prepare("DELETE FROM credentials").run();
  manifestMocks.getActive.mockImplementation((id: string) =>
    id === manifest.id ? manifest : null
  );
});

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

function pauseAtFirstOAuth() {
  const started = service.startIntegrationSetup({
    schemaVersion: 1,
    integrationId: manifest.id,
    manifestVersion: manifest.version,
    manifestCredentialId: manifest.credentials[0]!.id,
    credentialType: "google-oauth",
    mode: "setup",
  });
  return service.submitIntegrationSetupCredentials(started.id, {
    schemaVersion: 1,
    flowId: started.id,
    revision: started.revision,
    stepId: started.currentStepId!,
    data: { "client-id": "google-client", "client-secret": "google-secret" },
  });
}

describe("OAuth account duplicate scope", () => {
  it("materializes expiry before replaying an idempotent active start", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-13T10:00:00.000Z"));
      const request = {
        schemaVersion: 1 as const,
        idempotencyKey: "setup-start:expired-replay",
        integrationId: manifest.id,
        manifestVersion: manifest.version,
        manifestCredentialId: manifest.credentials[0]!.id,
        credentialType: "google-oauth",
        mode: "setup" as const,
      };
      const started = service.startIntegrationSetup(request);
      vi.setSystemTime(new Date(Date.parse(started.expiresAt) + 1));

      const replayed = service.startIntegrationSetup(request);

      expect(replayed).toMatchObject({
        id: started.id,
        status: "expired",
        failureCode: "flow_expired",
      });
      expect(replayed.revision).toBe(started.revision + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers only the active declaration's exact output credential type", () => {
    const createAccount = (name: string, type = "oauth-token-google") =>
      credentials.createCredential(name, type, { accessToken: `${name}-secret` });
    const valid = createAccount("Valid");
    const secondary = createAccount("Secondary");
    const synthesized = createAccount("Synthesized");
    const wrongType = createAccount("Wrong type", "oauth-token-reddit");
    const bind = (credentialId: string, manifestCredentialId: string) =>
      setupStore.upsertIntegrationCredentialBinding({
        credentialId,
        integrationId: manifest.id,
        manifestVersion: manifest.version,
        manifestCredentialId,
        authMethod: "oauth2",
        authStatus: "active",
        scopes:
          manifest.oauth.find((declaration) => declaration.id === manifestCredentialId)?.scopes ??
          [],
      });
    bind(valid.id, manifest.oauth[0]!.id);
    bind(secondary.id, "oauth.secondary");
    bind(synthesized.id, "oauth.synthesized");
    bind(wrongType.id, manifest.oauth[0]!.id);

    const started = service.startIntegrationSetup({
      schemaVersion: 1,
      integrationId: manifest.id,
      manifestVersion: manifest.version,
      manifestCredentialId: manifest.credentials[0]!.id,
      credentialType: "google-oauth",
      mode: "setup",
    });
    const paused = service.submitIntegrationSetupCredentials(started.id, {
      schemaVersion: 1,
      flowId: started.id,
      revision: started.revision,
      stepId: started.currentStepId!,
      data: { "client-id": "google-client", "client-secret": "google-secret" },
    });

    expect(paused).toMatchObject({
      status: "awaiting-confirmation",
      duplicateCandidates: [{ id: valid.id }],
    });
    expect(() =>
      service.confirmIntegrationSetupDuplicate(paused.id, {
        schemaVersion: 1,
        flowId: paused.id,
        revision: paused.revision,
        decision: "reuse-existing",
        credentialId: secondary.id,
      })
    ).toThrow(service.IntegrationSetupRequestError);
    expect(() =>
      service.startIntegrationSetup({
        schemaVersion: 1,
        integrationId: manifest.id,
        manifestVersion: manifest.version,
        manifestCredentialId: manifest.credentials[0]!.id,
        credentialType: "google-oauth",
        mode: "reauthenticate",
        targetCredentialId: paused.targetCredentialId!,
        oauthCredentialId: secondary.id,
      })
    ).toThrow(service.IntegrationSetupCredentialNotFoundError);
  });

  it("resolves provider, manifest version, and required scopes from the exact declaration", () => {
    const primary = manifest.oauth[0]!;
    const primaryStep = manifest.setup.find(
      (step) => step.kind === "oauth" && step.oauthId === primary.id
    )!;
    expect(integrationOAuthAccountScope(manifest, primaryStep.id)).toEqual({
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      manifestOAuthId: primary.id,
      provider: primary.provider,
      credentialType: `oauth-token-${primary.provider}`,
      scopes: primary.scopes,
    });
    expect(
      integrationOAuthAccountScope(
        {
          ...manifest,
          oauth: manifest.oauth.map((declaration) =>
            declaration.id === primary.id ? { ...declaration, provider: "reddit" } : declaration
          ),
        },
        primaryStep.id
      )
    ).toBeNull();
  });

  it.each([
    ["old manifest version", { manifestVersion: "0.0.1" }],
    ["missing required scope", { scopes: ["openid"] }],
    ["elapsed token expiry", { tokenExpiresAt: "2020-01-01T00:00:00.000Z" }],
  ])("rejects reuse for %s", (_label, override) => {
    const primary = manifest.oauth[0]!;
    const primaryStep = manifest.setup.find(
      (step) => step.kind === "oauth" && step.oauthId === primary.id
    )!;
    const scope = integrationOAuthAccountScope(manifest, primaryStep.id)!;
    expect(
      reusableIntegrationOAuthAccountBinding(scope, {
        manifestId: scope.manifestId,
        manifestVersion: scope.manifestVersion,
        manifestCredentialId: scope.manifestOAuthId,
        authMethod: "oauth2",
        authStatus: "active",
        scopes: scope.scopes,
        ...override,
      })
    ).toBe(false);
  });

  it.each([
    ["old manifest version", { manifestVersion: "0.0.1" }],
    ["missing current scopes", { scopes: ["openid"] }],
    ["elapsed token expiry", { tokenExpiresAt: "2020-01-01T00:00:00.000Z" }],
  ])("keeps %s available for replacement but reconciles it as non-reusable", (_label, stale) => {
    const declaration = manifest.oauth[0]!;
    const account = credentials.createCredential("Stale Google account", "oauth-token-google", {
      accessToken: "stale-secret",
      provider: declaration.provider,
    });
    setupStore.upsertIntegrationCredentialBinding({
      credentialId: account.id,
      integrationId: manifest.id,
      manifestVersion: manifest.version,
      manifestCredentialId: declaration.id,
      authMethod: "oauth2",
      authStatus: "active",
      scopes: declaration.scopes,
      ...stale,
    });

    const paused = pauseAtFirstOAuth();
    expect(paused).toMatchObject({
      status: "awaiting-confirmation",
      duplicateCandidates: [{ id: account.id, allowedDecisions: ["replace-existing"] }],
    });
    expect(
      setupStore.getIntegrationCredentialBinding({
        credentialId: account.id,
        integrationId: manifest.id,
        manifestCredentialId: declaration.id,
      })
    ).toMatchObject({
      authStatus: "reauthentication-required",
      failureCode: "reauthentication_required",
    });

    const reauthentication = service.startIntegrationSetup({
      schemaVersion: 1,
      integrationId: manifest.id,
      manifestVersion: manifest.version,
      manifestCredentialId: manifest.credentials[0]!.id,
      credentialType: "google-oauth",
      mode: "reauthenticate",
      targetCredentialId: paused.targetCredentialId!,
      oauthCredentialId: account.id,
    });
    expect(reauthentication.oauthCredentialId).toBe(account.id);

    const replacement = service.confirmIntegrationSetupDuplicate(paused.id, {
      schemaVersion: 1,
      flowId: paused.id,
      revision: paused.revision,
      decision: "replace-existing",
      credentialId: account.id,
    });
    expect(replacement).toMatchObject({
      status: "awaiting-oauth",
      oauthCredentialId: account.id,
      duplicateCandidates: [],
    });
  });

  it("revalidates expiry at confirmation and returns replace-only repair state", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-13T10:00:00.000Z"));
      const declaration = manifest.oauth[0]!;
      const account = credentials.createCredential(
        "Expiring Google account",
        "oauth-token-google",
        {
          accessToken: "expiring-secret",
          provider: declaration.provider,
        }
      );
      setupStore.upsertIntegrationCredentialBinding({
        credentialId: account.id,
        integrationId: manifest.id,
        manifestVersion: manifest.version,
        manifestCredentialId: declaration.id,
        authMethod: "oauth2",
        authStatus: "active",
        tokenExpiresAt: "2026-07-13T10:01:00.000Z",
        scopes: declaration.scopes,
      });
      const paused = pauseAtFirstOAuth();
      expect(paused.duplicateCandidates[0]).toMatchObject({
        id: account.id,
        allowedDecisions: ["reuse-existing", "replace-existing"],
      });

      vi.setSystemTime(new Date("2026-07-13T10:02:00.000Z"));
      const repaired = service.confirmIntegrationSetupDuplicate(paused.id, {
        schemaVersion: 1,
        flowId: paused.id,
        revision: paused.revision,
        decision: "reuse-existing",
        credentialId: account.id,
      });
      expect(repaired).toMatchObject({
        status: "awaiting-confirmation",
        revision: paused.revision,
        duplicateCandidates: [{ id: account.id, allowedDecisions: ["replace-existing"] }],
      });
      expect(
        setupStore.getIntegrationCredentialBinding({
          credentialId: account.id,
          integrationId: manifest.id,
          manifestCredentialId: declaration.id,
        })
      ).toMatchObject({ authStatus: "reauthentication-required" });
    } finally {
      vi.useRealTimers();
    }
  });
});
