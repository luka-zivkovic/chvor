import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-integration-setup-"));
process.env.CHVOR_DATA_DIR = dataDir;

let store: typeof import("../integration-setup-store.ts");
let getDb: typeof import("../database.ts").getDb;
let closeDb: typeof import("../database.ts").closeDb;
let runMigrations: typeof import("../migrations.ts").runMigrations;
let migrateIntegrationSetupV36: typeof import("../migrations/integration-setup-v36.ts").migrateIntegrationSetupV36;
type CreateFlowInput = import("../integration-setup-store.ts").CreateIntegrationSetupFlowInput;

const FUTURE = () => new Date(Date.now() + 60 * 60 * 1_000).toISOString();
const STEPS = [
  { id: "enter-token", kind: "credential" as const },
  { id: "verify-token", kind: "diagnostic" as const },
];

function insertCredential(
  id: string,
  encryptedData = "0123456789abcdef",
  name = "Work account",
  type = "github"
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO credentials
         (id, name, type, encrypted_data, created_at, updated_at, test_status)
       VALUES (?, ?, ?, ?, ?, ?, 'untested')`
    )
    .run(id, name, type, encryptedData, now, now);
}

function createFlow(overrides: Partial<CreateFlowInput> = {}) {
  return store.createIntegrationSetupFlow({
    integrationId: "provider.github",
    manifestVersion: "1.0.0",
    manifestCredentialId: "account",
    credentialType: "github",
    mode: "setup",
    expiresAt: FUTURE(),
    ...overrides,
  });
}

function clearTables(): void {
  const db = getDb();
  db.prepare("DELETE FROM integration_setup_flows").run();
  db.prepare("DELETE FROM integration_credential_bindings").run();
  db.prepare("DELETE FROM credentials").run();
}

beforeAll(async () => {
  store = await import("../integration-setup-store.ts");
  ({ getDb, closeDb } = await import("../database.ts"));
  ({ runMigrations } = await import("../migrations.ts"));
  ({ migrateIntegrationSetupV36 } = await import("../migrations/integration-setup-v36.ts"));
});

beforeEach(() => clearTables());

afterEach(() => vi.useRealTimers());

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("integration setup migration v36", () => {
  it("rechecks the schema version after acquiring the migration write lock", () => {
    const path = join(dataDir, "concurrent-v36.db");
    const first = new Database(path);
    const second = new Database(path);
    try {
      first.exec(
        "CREATE TABLE credentials (id TEXT PRIMARY KEY, encrypted_data TEXT NOT NULL); PRAGMA user_version = 35"
      );
      first.pragma("foreign_keys = ON");
      second.pragma("foreign_keys = ON");

      migrateIntegrationSetupV36(first);
      expect(() => migrateIntegrationSetupV36(second)).not.toThrow();
      expect(second.pragma("user_version", { simple: true })).toBe(36);
    } finally {
      first.close();
      second.close();
    }
  });

  it("creates constrained setup, envelope, and binding tables on fresh databases", () => {
    const db = getDb();
    expect(db.pragma("user_version", { simple: true })).toBe(36);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND
         name IN ('integration_setup_flows', 'integration_setup_steps',
                  'integration_setup_secret_envelopes', 'integration_credential_bindings')
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "integration_credential_bindings",
      "integration_setup_flows",
      "integration_setup_secret_envelopes",
      "integration_setup_steps",
    ]);
    const flowColumns = db.pragma("table_info(integration_setup_flows)") as Array<{
      name: string;
    }>;
    expect(flowColumns.map(({ name }) => name)).toContain(
      "target_credential_encrypted_data_sha256"
    );
    expect(flowColumns.map(({ name }) => name)).not.toContain("target_credential_encrypted_data");
    expect(flowColumns.map(({ name }) => name)).toContain("credential_create_additional");
    expect(flowColumns.map(({ name }) => name)).toContain("start_request_sha256");
    expect(flowColumns.map(({ name }) => name)).toContain("oauth_credential_id");
    expect(flowColumns.map(({ name }) => name)).toContain("oauth_create_additional");
    const flowForeignKeys = db.pragma("foreign_key_list(integration_setup_flows)") as Array<{
      from: string;
    }>;
    expect(flowForeignKeys.map(({ from }) => from)).not.toContain("target_credential_id");
    expect(flowForeignKeys.map(({ from }) => from)).not.toContain("oauth_credential_id");
    expect(flowForeignKeys.map(({ from }) => from)).not.toContain("oauth_create_additional");
    expect(() =>
      db
        .prepare(
          `INSERT INTO integration_setup_flows
             (id, integration_id, manifest_id, manifest_version, credential_type, mode,
              status, auth_status, created_at, updated_at, expires_at)
           VALUES ('bad', 'provider.github', 'provider.github', '1.0.0', 'github',
             'unsafe', 'awaiting-input', 'unknown', ?, ?, ?)`
        )
        .run(new Date().toISOString(), new Date().toISOString(), FUTURE())
    ).toThrow(/CHECK constraint/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO integration_setup_flows
             (id, integration_id, manifest_id, manifest_version, credential_type, mode,
              status, auth_status, oauth_credential_id, oauth_create_additional,
              created_at, updated_at, expires_at)
           VALUES ('bad-oauth-choice', 'provider.github', 'provider.github', '1.0.0', 'github',
             'setup', 'awaiting-input', 'unknown', 'oauth-target', 1, ?, ?, ?)`
        )
        .run(new Date().toISOString(), new Date().toISOString(), FUTURE())
    ).toThrow(/CHECK constraint/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO integration_setup_flows
             (id, integration_id, manifest_id, manifest_version, credential_type, mode,
              status, auth_status, oauth_create_additional, created_at, updated_at, expires_at)
           VALUES ('bad-marker', 'provider.github', 'provider.github', '1.0.0', 'github',
             'setup', 'awaiting-input', 'unknown', 2, ?, ?, ?)`
        )
        .run(new Date().toISOString(), new Date().toISOString(), FUTURE())
    ).toThrow(/CHECK constraint/);
  });

  it("upgrades v35 transactionally, is idempotent, and preserves credential bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "chvor-v35-v36-"));
    const db = new Database(join(dir, "migration.db"));
    const encrypted = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    try {
      db.pragma("foreign_keys = ON");
      db.exec(`
        CREATE TABLE credentials (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
          encrypted_data TEXT NOT NULL
        )
      `);
      db.prepare(
        "INSERT INTO credentials (id, name, type, encrypted_data) VALUES (?, ?, ?, ?)"
      ).run("legacy-id", "Legacy", "legacy-type", encrypted);
      const before = db
        .prepare(
          "SELECT id, type, typeof(encrypted_data) AS storage, hex(encrypted_data) AS bytes FROM credentials"
        )
        .get();
      db.pragma("user_version = 35");
      runMigrations(db, false);
      expect(db.pragma("user_version", { simple: true })).toBe(36);
      expect(
        db
          .prepare(
            "SELECT id, type, typeof(encrypted_data) AS storage, hex(encrypted_data) AS bytes FROM credentials"
          )
          .get()
      ).toEqual(before);
      expect(() => runMigrations(db, false)).not.toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("integration setup flow store", () => {
  it("durably stores private credential submission guards without exposing ciphertext", () => {
    const encryptedData = "0123456789abcdef";
    const encryptedDataSha256 = createHash("sha256").update(encryptedData).digest("hex");
    const startRequestSha256 = "a".repeat(64);
    expect(() =>
      createFlow({
        targetCredentialId: "credential-target",
        targetCredentialEncryptedDataSha256: encryptedData,
      })
    ).toThrow(/SHA-256 digest/);
    const created = createFlow({
      id: "idempotent-flow",
      startRequestSha256,
      targetCredentialId: "credential-target",
      targetCredentialEncryptedDataSha256: encryptedDataSha256,
    });

    expect(JSON.stringify(created)).not.toContain(encryptedData);
    expect(store.getIntegrationSetupStartRequestSha256(created.id)).toBe(startRequestSha256);
    expect(store.getIntegrationSetupCredentialSubmissionGuard(created.id)).toEqual({
      targetCredentialId: "credential-target",
      targetCredentialEncryptedDataSha256: encryptedDataSha256,
      credentialCreateAdditional: false,
    });
    const rawGuard = getDb()
      .prepare(
        `SELECT target_credential_encrypted_data_sha256
           FROM integration_setup_flows WHERE id = ?`
      )
      .get(created.id);
    expect(rawGuard).toEqual({ target_credential_encrypted_data_sha256: encryptedDataSha256 });
    expect(JSON.stringify(rawGuard)).not.toContain(encryptedData);

    closeDb();
    expect(store.getIntegrationSetupStartRequestSha256(created.id)).toBe(startRequestSha256);
    expect(store.getIntegrationSetupCredentialSubmissionGuard(created.id)).toEqual({
      targetCredentialId: "credential-target",
      targetCredentialEncryptedDataSha256: encryptedDataSha256,
      credentialCreateAdditional: false,
    });
    expect(() =>
      getDb()
        .prepare(
          `UPDATE integration_setup_flows
              SET start_request_sha256 = ?, revision = revision + 1
            WHERE id = ?`
        )
        .run("b".repeat(64), created.id)
    ).toThrow(/identity fields are immutable/);

    const approved = store.transitionIntegrationSetupFlow(created.id, created.revision, {
      targetCredentialId: null,
      targetCredentialEncryptedDataSha256: null,
      credentialCreateAdditional: true,
    });
    expect(store.getIntegrationSetupCredentialSubmissionGuard(approved.id)).toEqual({
      credentialCreateAdditional: true,
    });
    expect(
      getDb()
        .prepare(
          `SELECT target_credential_encrypted_data_sha256, credential_create_additional
             FROM integration_setup_flows WHERE id = ?`
        )
        .get(created.id)
    ).toEqual({ target_credential_encrypted_data_sha256: null, credential_create_additional: 1 });
  });

  it("persists the OAuth create-additional marker with safe create defaults", () => {
    const defaulted = createFlow();
    const selected = createFlow({ oauthCreateAdditional: true });

    expect(defaulted.oauthCreateAdditional).toBe(false);
    expect(selected.oauthCreateAdditional).toBe(true);
    expect(
      getDb()
        .prepare("SELECT oauth_create_additional FROM integration_setup_flows WHERE id = ?")
        .get(selected.id)
    ).toEqual({ oauth_create_additional: 1 });
  });

  it("rejects mutually exclusive OAuth target and create-additional selections", () => {
    expect(() =>
      createFlow({ oauthCredentialId: "oauth-target", oauthCreateAdditional: true })
    ).toThrow(TypeError);

    const targeted = createFlow({ oauthCredentialId: "oauth-target" });
    expect(() =>
      store.transitionIntegrationSetupFlow(targeted.id, targeted.revision, {
        oauthCreateAdditional: true,
      })
    ).toThrow(store.IntegrationSetupIllegalTransitionError);
    expect(store.getIntegrationSetupFlow(targeted.id)).toEqual(targeted);

    const additional = createFlow({ oauthCreateAdditional: true });
    expect(() =>
      store.transitionIntegrationSetupFlow(additional.id, additional.revision, {
        oauthCredentialId: "oauth-target",
      })
    ).toThrow(store.IntegrationSetupIllegalTransitionError);
    expect(store.getIntegrationSetupFlow(additional.id)).toEqual(additional);
  });

  it("CAS-persists, resumes, preserves, and clears the OAuth create-additional decision", () => {
    const created = createFlow();
    const confirmation = store.transitionIntegrationSetupFlow(created.id, created.revision, {
      status: "awaiting-confirmation",
      oauthCreateAdditional: true,
    });
    expect(confirmation).toMatchObject({
      status: "awaiting-confirmation",
      oauthCreateAdditional: true,
      revision: created.revision + 1,
    });

    expect(() =>
      store.transitionIntegrationSetupFlow(created.id, created.revision, {
        oauthCreateAdditional: false,
      })
    ).toThrow(store.IntegrationSetupRevisionConflictError);
    expect(store.getIntegrationSetupFlow(created.id)?.oauthCreateAdditional).toBe(true);

    closeDb();
    const resumed = store.getIntegrationSetupFlow(created.id);
    expect(resumed).toEqual(confirmation);

    const awaitingOauth = store.transitionIntegrationSetupFlow(created.id, resumed!.revision, {
      status: "awaiting-oauth",
    });
    expect(awaitingOauth).toMatchObject({
      status: "awaiting-oauth",
      oauthCreateAdditional: true,
    });

    const cleared = store.transitionIntegrationSetupFlow(created.id, awaitingOauth.revision, {
      oauthCreateAdditional: false,
    });
    expect(cleared.oauthCreateAdditional).toBe(false);
    closeDb();
    expect(store.getIntegrationSetupFlow(created.id)).toEqual(cleared);
  });

  it("persists safe credential history and permits discovery to continue into OAuth", () => {
    const created = createFlow({
      targetCredentialId: "manifest-credential-history",
      oauthCredentialId: "oauth-credential-history",
    });
    expect(created).toMatchObject({
      targetCredentialId: "manifest-credential-history",
      oauthCredentialId: "oauth-credential-history",
    });

    const discovering = store.transitionIntegrationSetupFlow(created.id, created.revision, {
      status: "discovering",
      oauthCredentialId: "oauth-credential-replacement",
    });
    const awaitingOauth = store.transitionIntegrationSetupFlow(created.id, discovering.revision, {
      status: "awaiting-oauth",
    });

    expect(awaitingOauth).toMatchObject({
      status: "awaiting-oauth",
      targetCredentialId: "manifest-credential-history",
      oauthCredentialId: "oauth-credential-replacement",
      revision: created.revision + 2,
    });
  });

  it("journals steps and resumes the same strict public snapshot after close/reopen", () => {
    const created = createFlow();
    const journaled = store.initializeIntegrationSetupStepJournal(created.id, 1, STEPS);
    const active = store.advanceIntegrationSetupFlow(created.id, journaled.revision);
    expect(active).toMatchObject({
      schemaVersion: 1,
      status: "awaiting-input",
      currentStepId: "enter-token",
      revision: 3,
    });
    expect(active.steps[0]).toMatchObject({
      id: "enter-token",
      status: "active",
      attempts: 1,
    });
    closeDb();
    expect(store.getIntegrationSetupFlow(created.id)).toEqual(active);
    expect(store.listIntegrationSetupFlows({ integrationId: "provider.github" })).toEqual([active]);
  });

  it("rejects illegal transitions and stale revision races atomically", () => {
    const flow = createFlow();
    const journaled = store.initializeIntegrationSetupStepJournal(flow.id, flow.revision, STEPS);
    const active = store.advanceIntegrationSetupFlow(flow.id, journaled.revision);
    const completedStep = store.transitionIntegrationSetupFlow(flow.id, active.revision, {
      step: { id: "enter-token", status: "completed" },
    });
    expect(() =>
      store.transitionIntegrationSetupFlow(flow.id, completedStep.revision, {
        step: { id: "enter-token", status: "active" },
      })
    ).toThrow(/terminal|illegal|transition/i);
    expect(() =>
      store.transitionIntegrationSetupFlow(flow.id, active.revision, {
        status: "discovering",
      })
    ).toThrow(store.IntegrationSetupRevisionConflictError);
    expect(store.getIntegrationSetupFlow(flow.id)?.revision).toBe(completedStep.revision);
  });

  it("keeps flow and step timestamps monotonic when the wall clock rolls back", () => {
    const persistedTime = "2035-01-01T12:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(persistedTime);
    insertCredential("rollback-candidate");
    const created = createFlow({ expiresAt: "2035-01-01T13:00:00.000Z" });

    vi.setSystemTime("2035-01-01T11:00:00.000Z");
    const journaled = store.initializeIntegrationSetupStepJournal(
      created.id,
      created.revision,
      STEPS
    );
    const active = store.advanceIntegrationSetupFlow(created.id, journaled.revision);
    const withCandidate = store.setIntegrationSetupDuplicateCandidates(
      created.id,
      active.revision,
      ["rollback-candidate"]
    );
    const cleared = store.clearIntegrationSetupDuplicateCandidates(
      created.id,
      withCandidate.revision
    );
    const discovering = store.transitionIntegrationSetupFlow(created.id, cleared.revision, {
      status: "discovering",
    });
    const cancelled = store.cancelIntegrationSetupFlow(created.id, discovering.revision);

    expect([
      created.updatedAt,
      journaled.updatedAt,
      active.updatedAt,
      withCandidate.updatedAt,
      cleared.updatedAt,
      discovering.updatedAt,
      cancelled.updatedAt,
    ]).toEqual(Array(7).fill(persistedTime));
    expect(cancelled.revision).toBe(created.revision + 6);
    expect(
      getDb()
        .prepare(
          `SELECT created_at, updated_at, started_at, completed_at
             FROM integration_setup_steps WHERE flow_id = ? ORDER BY position`
        )
        .all(created.id)
    ).toEqual([
      {
        created_at: persistedTime,
        updated_at: persistedTime,
        started_at: persistedTime,
        completed_at: persistedTime,
      },
      {
        created_at: persistedTime,
        updated_at: persistedTime,
        started_at: null,
        completed_at: null,
      },
    ]);
    expect(() =>
      store.transitionIntegrationSetupFlow(created.id, discovering.revision, {
        status: "failed",
      })
    ).toThrow(store.IntegrationSetupRevisionConflictError);
    expect(store.getIntegrationSetupFlow(created.id)?.revision).toBe(cancelled.revision);
  });

  it("clamps an explicit expiry transition when the wall clock is behind the flow", () => {
    const persistedTime = "2035-02-01T12:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(persistedTime);
    const created = createFlow({ expiresAt: "2035-02-01T13:00:00.000Z" });

    vi.setSystemTime("2035-02-01T11:00:00.000Z");
    const expired = store.expireIntegrationSetupFlow(
      created.id,
      created.revision,
      "2035-02-01T14:00:00.000Z"
    );

    expect(expired).toMatchObject({
      status: "expired",
      revision: created.revision + 1,
      updatedAt: persistedTime,
    });
    expect(
      getDb()
        .prepare("SELECT updated_at, completed_at FROM integration_setup_flows WHERE id = ?")
        .get(created.id)
    ).toEqual({ updated_at: persistedTime, completed_at: persistedTime });
  });

  it("materializes elapsed flows and consistently reports the persisted expiry", () => {
    const flow = createFlow({ expiresAt: new Date(Date.now() + 500).toISOString() });
    const journaled = store.initializeIntegrationSetupStepJournal(flow.id, flow.revision, STEPS);
    const active = store.advanceIntegrationSetupFlow(flow.id, journaled.revision);
    const cutoff = new Date(Date.now() + 2_000).toISOString();
    expect(store.expireIntegrationSetupFlows(cutoff)).toBe(1);
    const expired = store.getIntegrationSetupFlow(flow.id);
    expect(expired).toMatchObject({
      status: "expired",
      failureCode: "flow_expired",
      revision: active.revision + 1,
    });
    const expiredMutations = [
      () => store.initializeIntegrationSetupStepJournal(flow.id, expired!.revision, []),
      () => store.transitionIntegrationSetupFlow(flow.id, expired!.revision, { status: "failed" }),
      () => store.advanceIntegrationSetupFlow(flow.id, expired!.revision),
      () => store.setIntegrationSetupDuplicateCandidates(flow.id, expired!.revision, []),
      () => store.cancelIntegrationSetupFlow(flow.id, expired!.revision),
      () => store.expireIntegrationSetupFlow(flow.id, expired!.revision, cutoff),
      () =>
        store.putIntegrationSetupSecretEnvelope({
          flowId: flow.id,
          purpose: "pkce",
          payload: "must-not-persist",
        }),
    ];
    for (const mutate of expiredMutations) {
      expect(mutate).toThrow(store.IntegrationSetupFlowExpiredError);
    }
    expect(store.getIntegrationSetupFlow(flow.id)?.revision).toBe(expired!.revision);
  });

  it("cancels active work without leaving an active journal step", () => {
    const flow = createFlow();
    const journaled = store.initializeIntegrationSetupStepJournal(flow.id, flow.revision, STEPS);
    const active = store.advanceIntegrationSetupFlow(flow.id, journaled.revision);
    const cancelled = store.cancelIntegrationSetupFlow(flow.id, active.revision);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.currentStepId).toBeUndefined();
    expect(cancelled.steps[0]).toMatchObject({
      status: "failed",
      failureCode: "flow_cancelled",
    });
  });

  it("persists duplicate candidate IDs only and returns bounded joined summaries", () => {
    insertCredential("credential-one");
    const flow = createFlow();
    const updated = store.setIntegrationSetupDuplicateCandidates(flow.id, flow.revision, [
      "credential-one",
    ]);
    expect(updated.duplicateCandidates).toEqual([
      {
        id: "credential-one",
        name: "Work account",
        type: "github",
        allowedDecisions: ["reuse-existing", "replace-existing"],
      },
    ]);
    const row = getDb()
      .prepare("SELECT duplicate_candidate_ids FROM integration_setup_flows WHERE id = ?")
      .get(flow.id) as { duplicate_candidate_ids: string };
    expect(row.duplicate_candidate_ids).toBe('["credential-one"]');
    expect(row.duplicate_candidate_ids).not.toContain("Work account");
  });

  it("only allows replacing an OAuth duplicate whose binding is not active", () => {
    insertCredential("oauth-expired", "encrypted-oauth", "Expired OAuth", "oauth-token-google");
    store.upsertIntegrationCredentialBinding({
      credentialId: "oauth-expired",
      integrationId: "oauth.google",
      manifestVersion: "1.0.0",
      manifestCredentialId: "oauth.direct",
      authMethod: "oauth2",
      authStatus: "expired",
    });
    const flow = createFlow({
      integrationId: "oauth.google",
      manifestCredentialId: "credential.google-oauth",
      credentialType: "oauth-token-google",
    });
    const journaled = store.initializeIntegrationSetupStepJournal(flow.id, flow.revision, [
      { id: "setup.oauth", kind: "oauth" },
    ]);
    const active = store.advanceIntegrationSetupFlow(flow.id, journaled.revision);
    const paused = store.setIntegrationSetupDuplicateCandidates(active.id, active.revision, [
      "oauth-expired",
    ]);

    expect(paused.duplicateCandidates).toEqual([
      {
        id: "oauth-expired",
        name: "Expired OAuth",
        type: "oauth-token-google",
        allowedDecisions: ["replace-existing"],
      },
    ]);
  });

  it("sanitizes raw legacy names only when materializing duplicate summaries", () => {
    const oversized = ` \u0000\n${"x".repeat(300)}`;
    const controlsOnly = "\u0000\n\u007f";
    insertCredential("legacy-oversized", undefined, oversized);
    insertCredential("legacy-controls", undefined, controlsOnly);
    const flow = createFlow();

    const updated = store.setIntegrationSetupDuplicateCandidates(flow.id, flow.revision, [
      "legacy-oversized",
      "legacy-controls",
    ]);
    expect(updated.duplicateCandidates.map(({ name }) => name)).toEqual([
      "x".repeat(200),
      "Saved credential",
    ]);
    expect(
      getDb().prepare("SELECT name FROM credentials WHERE id = ?").get("legacy-oversized")
    ).toEqual({ name: oversized });
    expect(
      getDb().prepare("SELECT name FROM credentials WHERE id = ?").get("legacy-controls")
    ).toEqual({ name: controlsOnly });
  });

  it("keeps flows readable and cancellable after a duplicate candidate is deleted", () => {
    insertCredential("credential-deleted");
    const flow = createFlow();
    const withCandidate = store.setIntegrationSetupDuplicateCandidates(flow.id, flow.revision, [
      "credential-deleted",
    ]);

    getDb().prepare("DELETE FROM credentials WHERE id = ?").run("credential-deleted");

    expect(store.getIntegrationSetupFlow(flow.id)?.duplicateCandidates).toEqual([]);
    expect(
      store.listIntegrationSetupFlows().find((candidate) => candidate.id === flow.id)
        ?.duplicateCandidates
    ).toEqual([]);
    expect(store.cancelIntegrationSetupFlow(flow.id, withCandidate.revision).status).toBe(
      "cancelled"
    );
  });

  it("clears persisted duplicate IDs after every joined candidate was deleted", () => {
    insertCredential("credential-deleted");
    const flow = createFlow();
    const withCandidate = store.setIntegrationSetupDuplicateCandidates(flow.id, flow.revision, [
      "credential-deleted",
    ]);
    getDb().prepare("DELETE FROM credentials WHERE id = ?").run("credential-deleted");

    expect(store.getIntegrationSetupFlow(flow.id)?.duplicateCandidates).toEqual([]);
    const cleared = store.clearIntegrationSetupDuplicateCandidates(flow.id, withCandidate.revision);

    expect(cleared).toMatchObject({
      duplicateCandidates: [],
      revision: withCandidate.revision + 1,
    });
    expect(
      getDb()
        .prepare("SELECT duplicate_candidate_ids FROM integration_setup_flows WHERE id = ?")
        .get(flow.id)
    ).toEqual({ duplicate_candidate_ids: "[]" });
  });
});

describe("integration setup secret envelopes", () => {
  it("keeps plaintext out of flow rows and supports encrypted hash lookup and deletion", () => {
    const flow = createFlow();
    const plaintext = "verifier-super-secret";
    const state = "oauth-state-123";
    const metadata = store.putIntegrationSetupSecretEnvelope({
      flowId: flow.id,
      purpose: "pkce",
      payload: plaintext,
      state,
    });
    expect(metadata).not.toHaveProperty("payload");
    expect(metadata).not.toHaveProperty("stateHash");
    const raw = getDb()
      .prepare(
        "SELECT encrypted_payload, state_sha256 FROM integration_setup_secret_envelopes WHERE id = ?"
      )
      .get(metadata.id) as { encrypted_payload: string; state_sha256: string };
    expect(raw.encrypted_payload).not.toContain(plaintext);
    expect(raw.state_sha256).toBe(createHash("sha256").update(state).digest("hex"));
    const flowRow = getDb()
      .prepare("SELECT * FROM integration_setup_flows WHERE id = ?")
      .get(flow.id) as Record<string, unknown>;
    expect(JSON.stringify(flowRow)).not.toContain(plaintext);
    expect(store.getIntegrationSetupFlow(flow.id)).not.toHaveProperty("encryptedPayload");
    expect(store.lookupIntegrationSetupSecretEnvelopeByState(state)).toMatchObject({
      id: metadata.id,
      payload: plaintext,
      purpose: "pkce",
    });
    expect(store.deleteIntegrationSetupSecretEnvelope(metadata.id)).toBe(true);
    expect(store.readIntegrationSetupSecretEnvelope(metadata.id)).toBeNull();
  });

  it("atomically consumes the exact state and purpose only once", () => {
    const flow = createFlow();
    store.putIntegrationSetupSecretEnvelope({
      flowId: flow.id,
      purpose: "pkce",
      payload: "one-time-payload",
      state: "one-time-state",
    });

    expect(
      store.consumeIntegrationSetupSecretEnvelopeByState("one-time-state", "staged-oauth")
    ).toBeNull();
    expect(store.lookupIntegrationSetupSecretEnvelopeByState("one-time-state")).not.toBeNull();
    expect(
      store.consumeIntegrationSetupSecretEnvelopeByState("one-time-state", "pkce")
    ).toMatchObject({ payload: "one-time-payload", purpose: "pkce" });
    expect(store.consumeIntegrationSetupSecretEnvelopeByState("one-time-state", "pkce")).toBeNull();
  });

  it("keeps active restart state but purges envelopes on every terminal transition", () => {
    const active = createFlow();
    const restartEnvelope = store.putIntegrationSetupSecretEnvelope({
      flowId: active.id,
      purpose: "staged-oauth",
      payload: "restart-safe",
    });
    const discovering = store.transitionIntegrationSetupFlow(active.id, active.revision, {
      status: "discovering",
    });
    expect(store.readIntegrationSetupSecretEnvelope(restartEnvelope.id)).toMatchObject({
      payload: "restart-safe",
    });
    expect(() =>
      store.transitionIntegrationSetupFlow(active.id, active.revision, { status: "failed" })
    ).toThrow(store.IntegrationSetupRevisionConflictError);
    expect(store.readIntegrationSetupSecretEnvelope(restartEnvelope.id)).not.toBeNull();

    for (const status of ["completed", "failed", "cancelled", "expired"] as const) {
      const flow = createFlow();
      const envelope = store.putIntegrationSetupSecretEnvelope({
        flowId: flow.id,
        purpose: "pkce",
        payload: `terminal-${status}`,
      });
      store.transitionIntegrationSetupFlow(flow.id, flow.revision, { status });
      expect(store.readIntegrationSetupSecretEnvelope(envelope.id)).toBeNull();
    }

    const advancing = createFlow();
    const journaled = store.initializeIntegrationSetupStepJournal(
      advancing.id,
      advancing.revision,
      []
    );
    const advancingEnvelope = store.putIntegrationSetupSecretEnvelope({
      flowId: advancing.id,
      purpose: "staged-credential",
      payload: "advance-completion",
    });
    expect(store.advanceIntegrationSetupFlow(advancing.id, journaled.revision).status).toBe(
      "completed"
    );
    expect(store.readIntegrationSetupSecretEnvelope(advancingEnvelope.id)).toBeNull();

    expect(discovering.status).toBe("discovering");
  });

  it("purges envelopes during indexed flow expiry cleanup", () => {
    const flow = createFlow({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const envelope = store.putIntegrationSetupSecretEnvelope({
      flowId: flow.id,
      purpose: "pkce",
      payload: "expired-cleanup",
    });

    expect(store.expireIntegrationSetupFlows(new Date(Date.now() + 120_000).toISOString())).toBe(1);
    expect(store.readIntegrationSetupSecretEnvelope(envelope.id)).toBeNull();
  });

  it("purges an indexed envelope expiry while its owning flow remains active", () => {
    const now = Date.now();
    const flow = createFlow({ expiresAt: new Date(now + 120_000).toISOString() });
    const envelope = store.putIntegrationSetupSecretEnvelope({
      flowId: flow.id,
      purpose: "pkce",
      payload: "short-lived-envelope",
      expiresAt: new Date(now + 30_000).toISOString(),
    });

    expect(store.expireIntegrationSetupFlows(new Date(now + 60_000).toISOString())).toBe(0);
    expect(store.getIntegrationSetupFlow(flow.id)?.status).toBe("awaiting-input");
    expect(store.readIntegrationSetupSecretEnvelope(envelope.id)).toBeNull();
  });
});

describe("integration account fingerprints", () => {
  it("preserves case in opaque OAuth account identifiers", () => {
    expect(store.hashIntegrationAccountFingerprint("provider.github", "UserA")).not.toBe(
      store.hashIntegrationAccountFingerprint("provider.github", "usera")
    );
    expect(store.hashIntegrationAccountFingerprint("provider.github", " UserA ")).toBe(
      store.hashIntegrationAccountFingerprint("provider.github", "UserA")
    );
  });
});

describe("integration credential bindings", () => {
  it("lazily adopts an existing credential without changing its encrypted bytes", () => {
    const encrypted = "legacy-ciphertext-byte-for-byte";
    insertCredential("credential-existing", encrypted);
    const binding = store.upsertIntegrationCredentialBinding({
      credentialId: "credential-existing",
      integrationId: "provider.github",
      manifestVersion: "1.0.0",
      manifestCredentialId: "account",
      authMethod: "api-key",
      accountFingerprintSource: "OctoCat@example.com",
      accountLabel: "OctoCat",
    });
    expect(binding).toMatchObject({
      credentialId: "credential-existing",
      authStatus: "unknown",
      accountLabel: "OctoCat",
    });
    expect(binding.accountFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (
        getDb()
          .prepare("SELECT encrypted_data FROM credentials WHERE id = ?")
          .get("credential-existing") as { encrypted_data: string }
      ).encrypted_data
    ).toBe(encrypted);
  });

  it("cascades bindings but keeps safe flow history when a credential is deleted", () => {
    insertCredential("credential-history");
    const flow = createFlow({
      targetCredentialId: "credential-history",
      oauthCredentialId: "credential-history",
    });
    const key = {
      credentialId: "credential-history",
      integrationId: "provider.github",
      manifestCredentialId: "account",
    };
    store.upsertIntegrationCredentialBinding({
      ...key,
      manifestVersion: "1.0.0",
      authMethod: "api-key",
      authStatus: "active",
    });

    getDb().prepare("DELETE FROM credentials WHERE id = ?").run("credential-history");

    expect(store.getIntegrationCredentialBinding(key)).toBeNull();
    expect(store.getIntegrationSetupFlow(flow.id)).toMatchObject({
      targetCredentialId: "credential-history",
      oauthCredentialId: "credential-history",
    });
  });

  it("lists deterministic metadata-only bindings for all blocking auth states", () => {
    const encrypted = "credential-value-that-must-never-be-listed";
    insertCredential("credential-blocked", encrypted);
    const cases = [
      { integrationId: "provider.alpha", authStatus: "expired" },
      { integrationId: "provider.bravo", authStatus: "revoked" },
      { integrationId: "provider.charlie", authStatus: "reauthentication-required" },
      { integrationId: "provider.delta", authStatus: "failed" },
    ] as const;
    for (const binding of [...cases].reverse()) {
      store.upsertIntegrationCredentialBinding({
        credentialId: "credential-blocked",
        integrationId: binding.integrationId,
        manifestVersion: "1.0.0",
        manifestCredentialId: "account",
        authMethod: "oauth2",
        authStatus: binding.authStatus,
      });
    }

    const bindings = store.listIntegrationCredentialBindingsForCredential("credential-blocked");
    expect(
      bindings.map(({ integrationId, authStatus }) => ({ integrationId, authStatus }))
    ).toEqual(cases);
    expect(JSON.stringify(bindings)).not.toContain(encrypted);
    expect(bindings.every(({ credentialId }) => credentialId === "credential-blocked")).toBe(true);
  });

  it("persists safe auth transitions, expiry, scopes, and clears failures on recovery", () => {
    insertCredential("credential-auth");
    const key = {
      credentialId: "credential-auth",
      integrationId: "provider.github",
      manifestCredentialId: "account",
    };
    store.upsertIntegrationCredentialBinding({
      ...key,
      manifestVersion: "1.0.0",
      authMethod: "oauth2",
      authStatus: "active",
      scopes: ["repo", "read:user"],
    });
    const expired = store.updateIntegrationCredentialAuthState(key, {
      authStatus: "expired",
      failureCode: "token_expired",
      tokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(expired).toMatchObject({
      authStatus: "expired",
      failureCode: "token_expired",
      scopes: ["repo", "read:user"],
    });
    const required = store.updateIntegrationCredentialBindingAuthState(key, {
      authStatus: "reauthentication-required",
      failureCode: "refresh_revoked",
    });
    expect(required.authStatus).toBe("reauthentication-required");
    const recovered = store.updateIntegrationCredentialAuthState(key, {
      authStatus: "active",
      failureCode: null,
      tokenExpiresAt: null,
    });
    expect(recovered).not.toHaveProperty("failureCode");
    expect(recovered).not.toHaveProperty("tokenExpiresAt");
    expect(store.readIntegrationCredentialBinding(key)).toEqual(recovered);
  });

  it("keeps binding update and auth-check timestamps monotonic after clock rollback", () => {
    const persistedTime = "2035-03-01T12:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(persistedTime);
    insertCredential("credential-clock-rollback");
    const key = {
      credentialId: "credential-clock-rollback",
      integrationId: "provider.github",
      manifestCredentialId: "account",
    };
    const created = store.upsertIntegrationCredentialBinding({
      ...key,
      manifestVersion: "1.0.0",
      authMethod: "oauth2",
      authStatus: "active",
    });

    vi.setSystemTime("2035-03-01T11:00:00.000Z");
    const checked = store.updateIntegrationCredentialAuthState(key, {
      authStatus: "expired",
      failureCode: "token_expired",
    });
    const upserted = store.upsertIntegrationCredentialBinding({
      ...key,
      manifestVersion: "1.1.0",
      authMethod: "oauth2",
      authStatus: "reauthentication-required",
      failureCode: "refresh_revoked",
      authCheckedAt: "2035-03-01T10:00:00.000Z",
    });
    const nullCheckedAt = store.upsertIntegrationCredentialBinding({
      ...key,
      manifestVersion: "1.2.0",
      authMethod: "oauth2",
      authStatus: "active",
      authCheckedAt: null,
    });

    expect(created).not.toHaveProperty("authCheckedAt");
    expect(checked).toMatchObject({
      authStatus: "expired",
      updatedAt: persistedTime,
      authCheckedAt: persistedTime,
    });
    expect(upserted).toMatchObject({
      manifestVersion: "1.1.0",
      authStatus: "reauthentication-required",
      updatedAt: persistedTime,
      authCheckedAt: persistedTime,
    });
    expect(nullCheckedAt).toMatchObject({
      manifestVersion: "1.2.0",
      authStatus: "active",
      updatedAt: persistedTime,
      authCheckedAt: persistedTime,
    });
  });
});
