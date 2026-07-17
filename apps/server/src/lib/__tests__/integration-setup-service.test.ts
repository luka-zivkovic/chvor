import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationManifest, IntegrationSetupStartRequest } from "@chvor/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OAUTH_PROVIDERS } from "../provider-registry.ts";
import { adaptOAuthProviders } from "../integration-manifest-resolver.ts";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-integration-setup-service-"));
process.env.CHVOR_DATA_DIR = dataDir;
const manifestMocks = vi.hoisted(() => ({ getActive: vi.fn() }));
vi.mock("../integration-manifest-catalog.ts", () => ({
  getActiveIntegrationManifest: manifestMocks.getActive,
}));
let service: typeof import("../integration-setup-service.ts");
let setupStore: typeof import("../../db/integration-setup-store.ts");
let credentialStore: typeof import("../../db/credential-store.ts");
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;

const manifest: IntegrationManifest = {
  schemaVersion: 1,
  id: "provider.github",
  version: "1.2.3",
  name: "GitHub",
  description: "GitHub integration fixture.",
  ownership: { kind: "first-party", name: "Chvor" },
  source: { kind: "built-in", package: "@chvor/server/provider-registry/integration" },
  mcpServers: [],
  tools: [],
  credentials: [
    {
      id: "credential.github",
      name: "GitHub credentials",
      description: "Credentials used by GitHub.",
      fields: [
        {
          id: "token",
          label: "Token",
          description: "Personal access token.",
          sensitivity: "secret",
          required: true,
        },
        {
          id: "username",
          label: "Username",
          description: "Optional account label.",
          sensitivity: "text",
          required: false,
        },
      ],
    },
  ],
  oauth: [],
  capabilities: [],
  requestedAccess: { network: [], filesystem: [], process: [], environment: [] },
  setup: [
    {
      id: "setup.credentials",
      kind: "credential",
      title: "Enter credentials",
      credentialId: "credential.github",
    },
    {
      id: "setup.discovery",
      kind: "diagnostic",
      title: "Validate credential",
      checkId: "check.token",
    },
  ],
  diagnostics: [
    {
      id: "check.token",
      kind: "credential",
      name: "Check token",
      description: "Check that the selected credential contains a token.",
      credentialField: { credentialId: "credential.github", fieldId: "token" },
    },
  ],
  quality: { tier: "experimental", evidence: [] },
};

function startRequest(
  overrides: Partial<IntegrationSetupStartRequest> = {}
): IntegrationSetupStartRequest {
  return {
    schemaVersion: 1,
    integrationId: manifest.id,
    manifestVersion: manifest.version,
    manifestCredentialId: "credential.github",
    credentialType: "github",
    mode: "setup",
    ...overrides,
  };
}

function clearTables(): void {
  const db = getDb();
  db.prepare("DELETE FROM integration_setup_flows").run();
  db.prepare("DELETE FROM integration_credential_bindings").run();
  db.prepare("DELETE FROM credentials").run();
}

function credentialCount(): number {
  return (getDb().prepare("SELECT count(*) AS count FROM credentials").get() as { count: number })
    .count;
}

function encryptedCredential(id: string): string {
  return (
    getDb().prepare("SELECT encrypted_data FROM credentials WHERE id = ?").get(id) as {
      encrypted_data: string;
    }
  ).encrypted_data;
}

function useManifest(value: IntegrationManifest): void {
  manifestMocks.getActive.mockImplementation((id: string) => (id === value.id ? value : null));
}

function googleManifest(): IntegrationManifest {
  const google = OAUTH_PROVIDERS.find((provider) => provider.id === "google");
  if (!google) throw new Error("Google fixture missing");
  const result = adaptOAuthProviders({ oauthProviders: [google] });
  const adapted = result.manifests.find((item) => item.id === "oauth.google");
  if (!adapted) throw new Error("Google manifest adaptation failed");
  return adapted;
}

beforeAll(async () => {
  service = await import("../integration-setup-service.ts");
  setupStore = await import("../../db/integration-setup-store.ts");
  credentialStore = await import("../../db/credential-store.ts");
  ({ getDb, closeDb } = await import("../../db/database.ts"));
});

beforeEach(() => {
  clearTables();
  manifestMocks.getActive.mockReset();
  useManifest(manifest);
});

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("manifest-authoritative setup journals", () => {
  it("validates active version, declaration, derived type, and targets", () => {
    expect(service.deriveIntegrationCredentialType("credential.github")).toBe("github");
    expect(service.deriveIntegrationCredentialType("service.token")).toBe("service.token");
    expect(() => service.startIntegrationSetup(startRequest({ manifestVersion: "9.9.9" }))).toThrow(
      service.IntegrationSetupRequestError
    );
    expect(() =>
      service.startIntegrationSetup(startRequest({ manifestCredentialId: "credential.missing" }))
    ).toThrow(service.IntegrationSetupRequestError);
    expect(() =>
      service.startIntegrationSetup(startRequest({ credentialType: "client-supplied" }))
    ).toThrow(service.IntegrationSetupRequestError);
    expect(() => service.startIntegrationSetup(startRequest({ mode: "reconfigure" }))).toThrow(
      service.IntegrationSetupRequestError
    );
    expect(() =>
      service.startIntegrationSetup(
        startRequest({ mode: "setup", targetCredentialId: "unconfirmed-target" })
      )
    ).toThrow(service.IntegrationSetupRequestError);
    expect(() =>
      service.startIntegrationSetup(
        startRequest({ mode: "setup", oauthCredentialId: "unconfirmed-oauth-target" })
      )
    ).toThrow(service.IntegrationSetupRequestError);
    expect(() =>
      service.startIntegrationSetup(
        startRequest({ mode: "reauthenticate", targetCredentialId: "missing" })
      )
    ).toThrow(service.IntegrationSetupCredentialNotFoundError);
    manifestMocks.getActive.mockReturnValue(null);
    expect(() => service.startIntegrationSetup(startRequest())).toThrow(
      service.IntegrationSetupManifestNotFoundError
    );
    expect(setupStore.listIntegrationSetupFlows()).toEqual([]);
  });
  it("persists restart-safe state without process-local flow data", () => {
    const started = service.startIntegrationSetup(startRequest());
    expect(started).toMatchObject({
      integrationId: manifest.id,
      manifestCredentialId: "credential.github",
      currentStepId: "setup.credentials",
      status: "awaiting-input",
    });
    closeDb();
    expect(service.getIntegrationSetup(started.id)).toEqual(started);
    expect(service.listIntegrationSetups()).toEqual([started]);
  });
  it("fails closed for stale active flows while retaining terminal history", () => {
    const active = service.startIntegrationSetup(startRequest());
    const terminal = service.startIntegrationSetup(startRequest());
    const cancelled = service.cancelIntegrationSetup(terminal.id, {
      schemaVersion: 1,
      flowId: terminal.id,
      revision: terminal.revision,
    });
    useManifest({ ...manifest, version: "1.2.3+sha256.changed-content" });
    expect(() => service.getIntegrationSetup(active.id)).toThrow(
      service.IntegrationSetupRequestError
    );
    expect(service.getIntegrationSetup(cancelled.id)).toEqual(cancelled);
    expect(service.listIntegrationSetups()).toEqual([cancelled]);
  });
  it("does not expose a nonterminal flow after its manifest leaves the active catalog", () => {
    const active = service.startIntegrationSetup(startRequest());
    manifestMocks.getActive.mockReturnValue(null);
    expect(() => service.getIntegrationSetup(active.id)).toThrow(
      service.IntegrationSetupManifestNotFoundError
    );
    expect(service.listIntegrationSetups()).toEqual([]);
  });
  it("scopes a two-credential manifest to the selected dependency chain", () => {
    const twoCredential: IntegrationManifest = {
      ...manifest,
      credentials: [
        ...manifest.credentials,
        {
          id: "credential.gitlab",
          name: "GitLab credentials",
          description: "Unrelated GitLab credentials.",
          fields: [
            {
              id: "token",
              label: "Token",
              description: "GitLab token.",
              sensitivity: "secret",
              required: true,
            },
          ],
        },
      ],
      setup: [
        ...manifest.setup,
        {
          id: "setup.gitlab",
          kind: "credential",
          title: "Enter GitLab credentials",
          credentialId: "credential.gitlab",
        },
        {
          id: "setup.gitlab-check",
          kind: "diagnostic",
          title: "Validate GitLab",
          checkId: "check.gitlab-token",
        },
      ],
      diagnostics: [
        ...manifest.diagnostics,
        {
          id: "check.gitlab-token",
          kind: "credential",
          name: "Check GitLab token",
          description: "Validate the unrelated token.",
          credentialField: { credentialId: "credential.gitlab", fieldId: "token" },
        },
      ],
    };
    useManifest(twoCredential);
    const started = service.startIntegrationSetup(startRequest());
    expect(started.steps.map((step) => step.id)).toEqual(["setup.credentials", "setup.discovery"]);
  });

  it("requires explicit acknowledgement for instruction-only and instruction-first flows", () => {
    const instruction = {
      id: "setup.instructions",
      kind: "instruction" as const,
      title: "Read this first",
      instructions: "Follow the provider setup instructions.",
    };
    const instructionOnly = { ...manifest, setup: [instruction], diagnostics: [] };
    useManifest(instructionOnly);
    const awaiting = service.startIntegrationSetup(startRequest());
    expect(awaiting).toMatchObject({
      status: "awaiting-input",
      currentStepId: "setup.instructions",
    });
    const completed = service.acknowledgeIntegrationSetupInstruction(awaiting.id, {
      schemaVersion: 1,
      flowId: awaiting.id,
      revision: awaiting.revision,
      stepId: "setup.instructions",
    });
    expect(completed).toMatchObject({ status: "completed" });

    clearTables();
    const instructionFirst = { ...manifest, setup: [instruction, ...manifest.setup] };
    useManifest(instructionFirst);
    const first = service.startIntegrationSetup(startRequest());
    const actionable = service.acknowledgeIntegrationSetupInstruction(first.id, {
      schemaVersion: 1,
      flowId: first.id,
      revision: first.revision,
      stepId: "setup.instructions",
    });
    expect(actionable).toMatchObject({
      status: "awaiting-input",
      currentStepId: "setup.credentials",
    });
    expect(() =>
      service.acknowledgeIntegrationSetupInstruction(first.id, {
        schemaVersion: 1,
        flowId: first.id,
        revision: first.revision,
        stepId: "setup.instructions",
      })
    ).toThrow(setupStore.IntegrationSetupRevisionConflictError);
  });
  it("throws a stable expired-flow error after expiry has already been materialized", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-13T10:00:00.000Z"));
      const started = service.startIntegrationSetup(startRequest());
      vi.setSystemTime(new Date("2026-07-13T10:31:00.000Z"));
      expect(() => service.getIntegrationSetup(started.id)).toThrow(
        setupStore.IntegrationSetupFlowExpiredError
      );
      expect(service.listIntegrationSetups()).toContainEqual(
        expect.objectContaining({ id: started.id, status: "expired" })
      );
      expect(() => service.getIntegrationSetup(started.id)).toThrow(
        setupStore.IntegrationSetupFlowExpiredError
      );
      expect(() =>
        service.cancelIntegrationSetup(started.id, {
          schemaVersion: 1,
          flowId: started.id,
          revision: started.revision + 1,
        })
      ).toThrow(setupStore.IntegrationSetupFlowExpiredError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("duplicate decisions and credential persistence", () => {
  it("pauses from safe metadata before writing and reuses exactly once", () => {
    const secret = "duplicate-secret";
    const existing = credentialStore.createCredential("Existing account", "github", {
      token: secret,
    });
    const ciphertext = encryptedCredential(existing.id);
    const paused = service.startIntegrationSetup(startRequest());
    expect(paused).toMatchObject({
      status: "awaiting-confirmation",
      duplicateCandidates: [
        {
          id: existing.id,
          name: "Existing account",
          type: "github",
          allowedDecisions: ["reuse-existing", "replace-existing"],
        },
      ],
    });
    expect(credentialCount()).toBe(1);
    expect(JSON.stringify(paused)).not.toContain(secret);

    const request = {
      schemaVersion: 1 as const,
      flowId: paused.id,
      revision: paused.revision,
      decision: "reuse-existing" as const,
      credentialId: existing.id,
    };
    const reused = service.confirmIntegrationSetupDuplicate(paused.id, request);
    expect(reused).toMatchObject({
      status: "completed",
      authStatus: "active",
      targetCredentialId: existing.id,
      duplicateCandidates: [],
    });
    expect(encryptedCredential(existing.id)).toBe(ciphertext);
    expect(() => service.confirmIntegrationSetupDuplicate(paused.id, request)).toThrow(
      setupStore.IntegrationSetupRevisionConflictError
    );
  });
  it.each([
    { decision: "replace-existing" as const, expectedStatus: "awaiting-input" },
    { decision: "create-additional" as const, expectedStatus: "awaiting-input" },
    { decision: "cancel" as const, expectedStatus: "cancelled" },
  ])("applies $decision with strict candidate membership and stale CAS", (example) => {
    const existing = credentialStore.createCredential("Existing", "github", { token: "keep" });
    const paused = service.startIntegrationSetup(startRequest());
    const request = {
      schemaVersion: 1 as const,
      flowId: paused.id,
      revision: paused.revision,
      decision: example.decision,
      ...(example.decision === "replace-existing" ? { credentialId: existing.id } : {}),
    };
    const decided = service.confirmIntegrationSetupDuplicate(paused.id, request);
    expect(decided.status).toBe(example.expectedStatus);
    if (example.decision === "replace-existing") {
      expect(decided.targetCredentialId).toBe(existing.id);
    }
    if (example.decision === "create-additional") {
      expect(decided.targetCredentialId).toBeUndefined();
      expect(credentialCount()).toBe(1);
    }
    expect(() => service.confirmIntegrationSetupDuplicate(paused.id, request)).toThrow(
      setupStore.IntegrationSetupRevisionConflictError
    );
  });
  it("clears deleted duplicate IDs from the durable journal when confirmation is exited", () => {
    const existing = credentialStore.createCredential("Deleted candidate", "github", {
      token: "keep",
    });
    const paused = service.startIntegrationSetup(startRequest());
    getDb().prepare("DELETE FROM credentials WHERE id = ?").run(existing.id);
    expect(service.getIntegrationSetup(paused.id).duplicateCandidates).toEqual([]);

    const decided = service.confirmIntegrationSetupDuplicate(paused.id, {
      schemaVersion: 1,
      flowId: paused.id,
      revision: paused.revision,
      decision: "create-additional",
    });

    expect(decided).toMatchObject({ status: "awaiting-input", duplicateCandidates: [] });
    expect(
      getDb()
        .prepare("SELECT duplicate_candidate_ids FROM integration_setup_flows WHERE id = ?")
        .get(paused.id)
    ).toEqual({ duplicate_candidate_ids: "[]" });
  });
  it("rejects outsiders and fails reuse safely when the exact target lacks required shape", () => {
    const candidate = credentialStore.createCredential("Missing token", "github", {
      username: "octocat",
    });
    const outsider = credentialStore.createCredential("Outsider", "other", { token: "other" });
    const paused = service.startIntegrationSetup(startRequest());
    expect(() =>
      service.confirmIntegrationSetupDuplicate(paused.id, {
        schemaVersion: 1,
        flowId: paused.id,
        revision: paused.revision,
        decision: "reuse-existing",
        credentialId: outsider.id,
      })
    ).toThrow(service.IntegrationSetupRequestError);
    const failed = service.confirmIntegrationSetupDuplicate(paused.id, {
      schemaVersion: 1,
      flowId: paused.id,
      revision: paused.revision,
      decision: "reuse-existing",
      credentialId: candidate.id,
    });
    expect(failed).toMatchObject({
      status: "failed",
      authStatus: "failed",
      failureCode: "credential_field_missing",
    });
  });

  it("updates in place, preserves omitted/blank secrets, and derives a non-secret fingerprint", () => {
    const existing = credentialStore.createCredential("Existing", "github", {
      token: "preserve-on-blank",
      username: "before",
    });
    const started = service.startIntegrationSetup(
      startRequest({ mode: "reconfigure", targetCredentialId: existing.id })
    );
    const updated = service.submitIntegrationSetupCredentials(started.id, {
      schemaVersion: 1,
      flowId: started.id,
      revision: started.revision,
      stepId: "setup.credentials",
      data: { token: "", username: "octocat" },
    });
    expect(updated).toMatchObject({
      status: "completed",
      authStatus: "active",
      targetCredentialId: existing.id,
    });
    expect(credentialStore.getCredentialData(existing.id)?.data).toEqual({
      token: "preserve-on-blank",
      username: "octocat",
    });
    const binding = setupStore.getIntegrationCredentialBinding({
      credentialId: existing.id,
      integrationId: manifest.id,
      manifestCredentialId: "credential.github",
    });
    expect(binding).toMatchObject({
      authStatus: "active",
      accountLabel: "octocat",
      accountFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(binding)).not.toContain("preserve-on-blank");
  });
  it("prevents two valid reconfiguration flows from overwriting the same credential", () => {
    const existing = credentialStore.createCredential("Existing", "github", {
      token: "original",
      username: "before",
    });
    const first = service.startIntegrationSetup(
      startRequest({ mode: "reconfigure", targetCredentialId: existing.id })
    );
    const second = service.startIntegrationSetup(
      startRequest({ mode: "reconfigure", targetCredentialId: existing.id })
    );
    const encryptedData = encryptedCredential(existing.id);
    const encryptedDataSha256 = createHash("sha256").update(encryptedData).digest("hex");
    expect(setupStore.getIntegrationSetupCredentialSubmissionGuard(first.id)).toEqual(
      setupStore.getIntegrationSetupCredentialSubmissionGuard(second.id)
    );
    expect(setupStore.getIntegrationSetupCredentialSubmissionGuard(first.id)).toEqual({
      targetCredentialId: existing.id,
      targetCredentialEncryptedDataSha256: encryptedDataSha256,
      credentialCreateAdditional: false,
    });
    const durableGuards = getDb()
      .prepare(
        `SELECT target_credential_encrypted_data_sha256
           FROM integration_setup_flows WHERE id IN (?, ?) ORDER BY id`
      )
      .all(first.id, second.id);
    expect(durableGuards).toEqual([
      { target_credential_encrypted_data_sha256: encryptedDataSha256 },
      { target_credential_encrypted_data_sha256: encryptedDataSha256 },
    ]);
    expect(JSON.stringify(durableGuards)).not.toContain(encryptedData);
    service.submitIntegrationSetupCredentials(first.id, {
      schemaVersion: 1,
      flowId: first.id,
      revision: first.revision,
      stepId: "setup.credentials",
      data: { token: "first-wins", username: "first" },
    });
    closeDb();
    const resumed = service.getIntegrationSetup(second.id);
    expect(() =>
      service.submitIntegrationSetupCredentials(second.id, {
        schemaVersion: 1,
        flowId: resumed.id,
        revision: resumed.revision,
        stepId: "setup.credentials",
        data: { token: "stale-second", username: "second" },
      })
    ).toThrow(service.IntegrationSetupCredentialChangedError);
    expect(credentialStore.getCredentialData(existing.id)?.data).toEqual({
      token: "first-wins",
      username: "first",
    });
    expect(service.getIntegrationSetup(second.id)).toEqual(resumed);
  });
  it("replays an exact durable start key and rejects different metadata", () => {
    const target = credentialStore.createCredential("Idempotent", "github", { token: "before" });
    const request = startRequest({
      idempotencyKey: "setup-start:strict-mode",
      mode: "reconfigure",
      targetCredentialId: target.id,
    });
    const started = service.startIntegrationSetup(request);
    const completed = service.submitIntegrationSetupCredentials(started.id, {
      schemaVersion: 1,
      flowId: started.id,
      revision: started.revision,
      stepId: "setup.credentials",
      data: { token: "after" },
    });
    closeDb();
    manifestMocks.getActive.mockReturnValue(null);
    expect(service.startIntegrationSetup(request)).toEqual(completed);
    expect(started.id).toBe(request.idempotencyKey);
    expect(setupStore.listIntegrationSetupFlows()).toHaveLength(1);
    expect(() => service.startIntegrationSetup({ ...request, mode: "reauthenticate" })).toThrow(
      service.IntegrationSetupRequestError
    );
    expect(setupStore.listIntegrationSetupFlows()).toHaveLength(1);
  });
  it("rechecks concurrent creates and requires a durable create-additional approval", () => {
    const first = service.startIntegrationSetup(startRequest());
    const second = service.startIntegrationSetup(startRequest());
    const submission = (flow: typeof first, token: string) => ({
      schemaVersion: 1 as const,
      flowId: flow.id,
      revision: flow.revision,
      stepId: "setup.credentials",
      data: { token, username: token },
    });

    const completed = service.submitIntegrationSetupCredentials(
      first.id,
      submission(first, "first")
    );
    const paused = service.submitIntegrationSetupCredentials(
      second.id,
      submission(second, "second")
    );
    expect(completed.status).toBe("completed");
    expect(paused).toMatchObject({
      status: "awaiting-confirmation",
      duplicateCandidates: [{ id: completed.targetCredentialId }],
    });
    expect(credentialCount()).toBe(1);
    const approved = service.confirmIntegrationSetupDuplicate(paused.id, {
      schemaVersion: 1,
      flowId: paused.id,
      revision: paused.revision,
      decision: "create-additional",
    });
    expect(setupStore.getIntegrationSetupCredentialSubmissionGuard(approved.id)).toEqual({
      credentialCreateAdditional: true,
    });
    closeDb();
    const resumed = service.getIntegrationSetup(approved.id);
    const created = service.submitIntegrationSetupCredentials(
      resumed.id,
      submission(resumed, "second")
    );
    expect(created).toMatchObject({ status: "completed", authStatus: "active" });
    expect(created.targetCredentialId).not.toBe(completed.targetCredentialId);
    expect(credentialCount()).toBe(2);
    expect(setupStore.getIntegrationSetupCredentialSubmissionGuard(created.id)).toMatchObject({
      targetCredentialId: created.targetCredentialId,
      credentialCreateAdditional: false,
    });
  });
  it("enforces URL/body/CAS before writes and keeps raw secrets out of flow rows", () => {
    const started = service.startIntegrationSetup(startRequest());
    const secret = "request-only-secret";
    const submission = {
      schemaVersion: 1 as const,
      flowId: started.id,
      revision: started.revision,
      stepId: "setup.credentials",
      data: { token: secret, username: "octocat" },
    };
    expect(() => service.submitIntegrationSetupCredentials("different-flow", submission)).toThrow(
      service.IntegrationSetupRequestError
    );
    expect(credentialCount()).toBe(0);
    const completed = service.submitIntegrationSetupCredentials(started.id, submission);
    expect(completed).toMatchObject({ status: "completed", authStatus: "active" });
    expect(credentialStore.getCredentialData(completed.targetCredentialId!)?.data).toEqual({
      token: secret,
      username: "octocat",
    });
    expect(JSON.stringify(completed)).not.toContain(secret);
    const durableRows = getDb()
      .prepare(
        `SELECT f.*, s.step_id, s.failure_code AS step_failure_code
           FROM integration_setup_flows f
           LEFT JOIN integration_setup_steps s ON s.flow_id = f.id
          WHERE f.id = ?`
      )
      .all(completed.id);
    expect(JSON.stringify(durableRows)).not.toContain(secret);
    expect(() => service.submitIntegrationSetupCredentials(started.id, submission)).toThrow(
      setupStore.IntegrationSetupRevisionConflictError
    );
  });
});

describe("real OAuth chains and server-derived diagnostics", () => {
  it("stores adapted Google fields under camelCase keys and legally reaches OAuth", () => {
    const google = googleManifest();
    useManifest(google);
    const credential = google.credentials.find((item) => item.id === "credential.google-oauth")!;
    expect(credential.fields).toMatchObject([
      { id: "client-id", storageKey: "clientId" },
      { id: "client-secret", storageKey: "clientSecret" },
    ]);
    const started = service.startIntegrationSetup({
      schemaVersion: 1,
      integrationId: google.id,
      manifestVersion: google.version,
      manifestCredentialId: credential.id,
      credentialType: "google-oauth",
      mode: "setup",
    });
    const awaitingOauth = service.submitIntegrationSetupCredentials(started.id, {
      schemaVersion: 1,
      flowId: started.id,
      revision: started.revision,
      stepId: started.currentStepId!,
      data: { "client-id": "google-client", "client-secret": "google-secret" },
    });
    expect(awaitingOauth).toMatchObject({
      status: "awaiting-oauth",
      targetCredentialId: expect.any(String),
    });
    expect(awaitingOauth.steps.filter((step) => step.kind === "diagnostic").slice(0, 2)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "completed" })])
    );
    expect(credentialStore.getCredentialData(awaitingOauth.targetCredentialId!)?.data).toEqual({
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    expect(
      credentialStore.getCredentialData(awaitingOauth.targetCredentialId!)?.data
    ).not.toHaveProperty("client-id");
    const token = credentialStore.createCredential("Google account", "oauth-token-google", {
      accessToken: "oauth-secret",
    });
    let workerFlow = setupStore.transitionIntegrationSetupFlow(
      awaitingOauth.id,
      awaitingOauth.revision,
      { oauthCredentialId: token.id, authStatus: "active", failureCode: null }
    );
    workerFlow = setupStore.advanceIntegrationSetupFlow(workerFlow.id, workerFlow.revision);
    expect(workerFlow).toMatchObject({
      status: "discovering",
      targetCredentialId: awaitingOauth.targetCredentialId,
      oauthCredentialId: token.id,
    });
    const completed = service.submitIntegrationSetupDiscovery(workerFlow.id, {
      schemaVersion: 1,
      flowId: workerFlow.id,
      revision: workerFlow.revision,
      stepId: workerFlow.currentStepId!,
    });
    expect(completed).toMatchObject({
      status: "completed",
      authStatus: "active",
      targetCredentialId: awaitingOauth.targetCredentialId,
      oauthCredentialId: token.id,
    });
    expect(JSON.stringify(completed)).not.toContain("oauth-secret");
  });
  it("rejects client-forged auth/discovery assertions and validates the active tool reference", () => {
    const google = googleManifest();
    useManifest(google);
    const started = service.startIntegrationSetup({
      schemaVersion: 1,
      integrationId: google.id,
      manifestVersion: google.version,
      manifestCredentialId: "credential.google-oauth",
      credentialType: "google-oauth",
      mode: "setup",
    });
    const awaitingOauth = service.submitIntegrationSetupCredentials(started.id, {
      schemaVersion: 1,
      flowId: started.id,
      revision: started.revision,
      stepId: started.currentStepId!,
      data: { "client-id": "id", "client-secret": "secret" },
    });
    expect(() =>
      service.submitIntegrationSetupDiscovery(awaitingOauth.id, {
        schemaVersion: 1,
        flowId: awaitingOauth.id,
        revision: awaitingOauth.revision,
        stepId: awaitingOauth.currentStepId,
        authStatus: "active",
        duplicateCandidates: [],
      })
    ).toThrow();
  });
  it("preserves distinct app and OAuth account IDs through reauthentication", () => {
    const google = googleManifest();
    useManifest(google);
    const app = credentialStore.createCredential("Google app", "google-oauth", {
      clientId: "google-client",
      clientSecret: "preserve-secret",
    });
    const account = credentialStore.createCredential("Google account", "oauth-token-google", {
      accessToken: "preserve-token",
    });
    setupStore.upsertIntegrationCredentialBinding({
      credentialId: account.id,
      integrationId: google.id,
      manifestVersion: google.version,
      manifestCredentialId: "oauth.direct",
      authMethod: "oauth2",
      authStatus: "reauthentication-required",
      failureCode: "reauthentication_required",
    });
    const started = service.startIntegrationSetup({
      schemaVersion: 1,
      integrationId: google.id,
      manifestVersion: google.version,
      manifestCredentialId: "credential.google-oauth",
      credentialType: "google-oauth",
      mode: "reauthenticate",
      targetCredentialId: app.id,
      oauthCredentialId: account.id,
    });
    expect(started).toMatchObject({
      targetCredentialId: app.id,
      oauthCredentialId: account.id,
      authStatus: "reauthentication-required",
    });
    const awaitingOauth = service.submitIntegrationSetupCredentials(started.id, {
      schemaVersion: 1,
      flowId: started.id,
      revision: started.revision,
      stepId: started.currentStepId!,
      data: { "client-id": "", "client-secret": "" },
    });
    expect(awaitingOauth).toMatchObject({
      status: "awaiting-oauth",
      targetCredentialId: app.id,
      oauthCredentialId: account.id,
      authStatus: "reauthentication-required",
    });
    expect(credentialStore.getCredentialData(app.id)?.data).toEqual({
      clientId: "google-client",
      clientSecret: "preserve-secret",
    });
    expect(credentialStore.getCredentialData(account.id)?.data.accessToken).toBe("preserve-token");
  });
  it.each([
    ["reuse-existing", "completed", false] as const,
    ["replace-existing", "awaiting-oauth", false] as const,
    ["create-additional", "awaiting-oauth", true] as const,
  ])(
    "applies %s to the OAuth account without replacing the manifest credential target",
    (decision, expectedStatus, expectedCreateAdditional) => {
      const google = googleManifest();
      useManifest(google);
      const existingAccount = credentialStore.createCredential(
        "Existing Google account",
        "oauth-token-google",
        {
          accessToken: "existing-oauth-secret",
          refreshToken: "existing-refresh-secret",
          clientId: "new-google-client",
        }
      );
      setupStore.upsertIntegrationCredentialBinding({
        credentialId: existingAccount.id,
        integrationId: google.id,
        manifestVersion: google.version,
        manifestCredentialId: "oauth.direct",
        authMethod: "oauth2",
        authStatus: "active",
        scopes: google.oauth[0]!.scopes,
        accountFingerprintSource: "account_id:existing",
      });
      const started = service.startIntegrationSetup({
        schemaVersion: 1,
        integrationId: google.id,
        manifestVersion: google.version,
        manifestCredentialId: "credential.google-oauth",
        credentialType: "google-oauth",
        mode: "setup",
      });
      const paused = service.submitIntegrationSetupCredentials(started.id, {
        schemaVersion: 1,
        flowId: started.id,
        revision: started.revision,
        stepId: started.currentStepId!,
        data: { "client-id": "new-google-client", "client-secret": "new-app-secret" },
      });
      expect(paused).toMatchObject({
        status: "awaiting-confirmation",
        targetCredentialId: expect.any(String),
        oauthCreateAdditional: false,
        duplicateCandidates: [expect.objectContaining({ id: existingAccount.id })],
      });
      expect(paused.steps.find((step) => step.status === "active")?.kind).toBe("oauth");
      const appCredentialId = paused.targetCredentialId!;
      const confirmed = service.confirmIntegrationSetupDuplicate(paused.id, {
        schemaVersion: 1,
        flowId: paused.id,
        revision: paused.revision,
        decision,
        ...(decision === "create-additional" ? {} : { credentialId: existingAccount.id }),
      });
      expect(confirmed).toMatchObject({
        status: expectedStatus,
        targetCredentialId: appCredentialId,
        oauthCreateAdditional: expectedCreateAdditional,
        duplicateCandidates: [],
      });
      if (decision === "create-additional") {
        expect(confirmed.oauthCredentialId).toBeUndefined();
        closeDb();
        expect(service.getIntegrationSetup(confirmed.id)).toEqual(confirmed);
      } else {
        expect(confirmed.oauthCredentialId).toBe(existingAccount.id);
      }
      expect(credentialStore.getCredentialData(appCredentialId)?.data).toEqual({
        clientId: "new-google-client",
        clientSecret: "new-app-secret",
      });
      expect(credentialStore.getCredentialData(existingAccount.id)?.data).toEqual({
        accessToken: "existing-oauth-secret",
        refreshToken: "existing-refresh-secret",
        clientId: "new-google-client",
      });
      expect(JSON.stringify(confirmed)).not.toMatch(/new-app-secret|existing-oauth-secret/);
    }
  );
  it("enforces OAuth candidate membership and optimistic revision on confirmation", () => {
    const google = googleManifest();
    useManifest(google);
    const candidate = credentialStore.createCredential("Google account", "oauth-token-google", {
      accessToken: "candidate-secret",
    });
    const unrelated = credentialStore.createCredential("Other account", "oauth-token-google", {
      accessToken: "other-secret",
    });
    setupStore.upsertIntegrationCredentialBinding({
      credentialId: candidate.id,
      integrationId: google.id,
      manifestVersion: google.version,
      manifestCredentialId: "oauth.direct",
      authMethod: "oauth2",
      authStatus: "active",
      scopes: google.oauth[0]!.scopes,
    });
    const started = service.startIntegrationSetup({
      schemaVersion: 1,
      integrationId: google.id,
      manifestVersion: google.version,
      manifestCredentialId: "credential.google-oauth",
      credentialType: "google-oauth",
      mode: "setup",
    });
    const paused = service.submitIntegrationSetupCredentials(started.id, {
      schemaVersion: 1,
      flowId: started.id,
      revision: started.revision,
      stepId: started.currentStepId!,
      data: { "client-id": "client", "client-secret": "secret" },
    });
    expect(() =>
      service.confirmIntegrationSetupDuplicate(paused.id, {
        schemaVersion: 1,
        flowId: paused.id,
        revision: paused.revision,
        decision: "replace-existing",
        credentialId: unrelated.id,
      })
    ).toThrow(service.IntegrationSetupRequestError);
    const created = service.confirmIntegrationSetupDuplicate(paused.id, {
      schemaVersion: 1,
      flowId: paused.id,
      revision: paused.revision,
      decision: "create-additional",
    });
    expect(() =>
      service.confirmIntegrationSetupDuplicate(paused.id, {
        schemaVersion: 1,
        flowId: paused.id,
        revision: paused.revision,
        decision: "create-additional",
      })
    ).toThrow(setupStore.IntegrationSetupRevisionConflictError);
    expect(created.targetCredentialId).toBe(paused.targetCredentialId);
  });
});
describe("terminal lifecycle", () => {
  it("moves generic reauthentication from required to active without changing its ID", () => {
    const target = credentialStore.createCredential("Reconnect", "github", {
      token: "preserve-on-blank",
      username: "octocat",
    });
    const started = service.startIntegrationSetup(
      startRequest({ mode: "reauthenticate", targetCredentialId: target.id })
    );
    expect(started).toMatchObject({
      targetCredentialId: target.id,
      authStatus: "reauthentication-required",
      failureCode: "reauthentication_required",
    });
    const active = service.submitIntegrationSetupCredentials(started.id, {
      schemaVersion: 1,
      flowId: started.id,
      revision: started.revision,
      stepId: started.currentStepId!,
      data: { token: "" },
    });
    expect(active).toMatchObject({
      status: "completed",
      targetCredentialId: target.id,
      authStatus: "active",
    });
    expect(active).not.toHaveProperty("failureCode");
    expect(credentialStore.getCredentialData(target.id)?.data.token).toBe("preserve-on-blank");
  });
  it("cancels with optimistic revision and never accepts another action", () => {
    const started = service.startIntegrationSetup(startRequest());
    const cancelled = service.cancelIntegrationSetup(started.id, {
      schemaVersion: 1,
      flowId: started.id,
      revision: started.revision,
    });
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(() =>
      service.cancelIntegrationSetup(started.id, {
        schemaVersion: 1,
        flowId: started.id,
        revision: started.revision,
      })
    ).toThrow(setupStore.IntegrationSetupRevisionConflictError);
  });
});
