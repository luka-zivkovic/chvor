import { describe, expect, it } from "vitest";
import {
  INTEGRATION_SETUP_LIMITS,
  INTEGRATION_SETUP_SCHEMA_VERSION,
  integrationAuthStatusSchema,
  integrationSetupCredentialSubmissionRequestSchema,
  integrationSetupDiscoveryRequestSchema,
  integrationSetupDuplicateDecisionRequestSchema,
  integrationSetupDuplicateDecisionSchema,
  integrationSetupFlowResponseSchema,
  integrationSetupFlowSnapshotSchema,
  integrationSetupInstructionAcknowledgementRequestSchema,
  integrationSetupModeSchema,
  integrationSetupStartRequestSchema,
  integrationSetupStatusSchema,
  integrationSetupStepKindSchema,
  integrationSetupStepProgressSchema,
  integrationSetupStepStatusSchema,
} from "../src/index.js";

const timestamps = {
  createdAt: "2026-07-13T10:00:00.000Z",
  firstStartedAt: "2026-07-13T10:00:01.000Z",
  firstCompletedAt: "2026-07-13T10:00:02.000Z",
  currentStartedAt: "2026-07-13T10:00:03.000Z",
  updatedAt: "2026-07-13T10:00:04.000Z",
  expiresAt: "2026-07-13T11:00:00.000Z",
};

function flowFixture() {
  return {
    schemaVersion: 1 as const,
    id: "setup-flow:01",
    integrationId: "github.integration",
    manifestVersion: "1.2.3",
    manifestCredentialId: "github.auth",
    currentStepId: "setup.credentials",
    targetCredentialId: "credential:existing",
    oauthCreateAdditional: false,
    credentialType: "github-oauth",
    mode: "reconfigure" as const,
    status: "awaiting-input" as const,
    authStatus: "unknown" as const,
    steps: [
      {
        id: "setup.instructions",
        kind: "instruction" as const,
        status: "completed" as const,
        attempts: 1,
        startedAt: timestamps.firstStartedAt,
        completedAt: timestamps.firstCompletedAt,
      },
      {
        id: "setup.credentials",
        kind: "credential" as const,
        status: "active" as const,
        attempts: 1,
        startedAt: timestamps.currentStartedAt,
      },
      {
        id: "setup.oauth",
        kind: "oauth" as const,
        status: "pending" as const,
        attempts: 0,
      },
      {
        id: "setup.diagnostic",
        kind: "diagnostic" as const,
        status: "pending" as const,
        attempts: 0,
      },
    ],
    duplicateCandidates: [
      {
        id: "credential:existing",
        name: "GitHub work",
        type: "github-oauth",
        accountLabel: "octocat@example.com",
        allowedDecisions: ["reuse-existing", "replace-existing"],
      },
    ],
    revision: 2,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    expiresAt: timestamps.expiresAt,
  };
}

describe("integration setup v1 contract", () => {
  it("parses a strict, JSON-safe resumable flow snapshot", () => {
    const parsed = integrationSetupFlowSnapshotSchema.parse(flowFixture());

    expect(parsed.schemaVersion).toBe(INTEGRATION_SETUP_SCHEMA_VERSION);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    expect(parsed.steps.map((step) => step.kind)).toEqual([
      "instruction",
      "credential",
      "oauth",
      "diagnostic",
    ]);
    expect(Object.keys(parsed.duplicateCandidates[0]!)).toEqual([
      "id",
      "name",
      "type",
      "accountLabel",
      "allowedDecisions",
    ]);
  });

  it("additively carries a distinct OAuth credential target", () => {
    expect(integrationSetupFlowSnapshotSchema.safeParse(flowFixture()).success).toBe(true);
    expect(
      integrationSetupFlowSnapshotSchema.parse({
        ...flowFixture(),
        oauthCredentialId: "credential:oauth-account",
      }).oauthCredentialId
    ).toBe("credential:oauth-account");

    const legacyStart = {
      schemaVersion: 1 as const,
      integrationId: "github.integration",
      manifestVersion: "1.2.3",
      manifestCredentialId: "github.auth",
      credentialType: "github-oauth",
      mode: "setup" as const,
    };
    expect(integrationSetupStartRequestSchema.safeParse(legacyStart).success).toBe(true);
    expect(
      integrationSetupStartRequestSchema.parse({
        ...legacyStart,
        oauthCredentialId: "credential:oauth-account",
      }).oauthCredentialId
    ).toBe("credential:oauth-account");
  });

  it("accepts only bounded safe start idempotency keys", () => {
    const start = {
      schemaVersion: 1 as const,
      idempotencyKey: "setup-start:550e8400-e29b-41d4-a716-446655440000",
      integrationId: "github.integration",
      manifestVersion: "1.2.3",
      manifestCredentialId: "github.auth",
      credentialType: "github-oauth",
      mode: "setup" as const,
    };
    expect(integrationSetupStartRequestSchema.parse(start).idempotencyKey).toBe(
      start.idempotencyKey
    );
    for (const idempotencyKey of ["unsafe key", "x".repeat(INTEGRATION_SETUP_LIMITS.id + 1)]) {
      expect(
        integrationSetupStartRequestSchema.safeParse({ ...start, idempotencyKey }).success
      ).toBe(false);
    }
  });

  it("strictly defaults and validates the durable OAuth create-additional marker", () => {
    const withoutMarker = { ...flowFixture() };
    delete (withoutMarker as Partial<typeof withoutMarker>).oauthCreateAdditional;

    expect(integrationSetupFlowSnapshotSchema.parse(withoutMarker).oauthCreateAdditional).toBe(
      false
    );
    expect(
      integrationSetupFlowSnapshotSchema.parse({
        ...flowFixture(),
        oauthCreateAdditional: true,
      }).oauthCreateAdditional
    ).toBe(true);
    for (const value of [0, 1, "true", null, { value: true }]) {
      expect(
        integrationSetupFlowSnapshotSchema.safeParse({
          ...flowFixture(),
          oauthCreateAdditional: value,
        }).success,
        `marker ${JSON.stringify(value)}`
      ).toBe(false);
    }
  });

  it.each(["setup", "reconfigure", "reauthenticate"] as const)("accepts setup mode %s", (mode) => {
    expect(integrationSetupModeSchema.parse(mode)).toBe(mode);
    expect(integrationSetupFlowSnapshotSchema.safeParse({ ...flowFixture(), mode }).success).toBe(
      true
    );
  });

  it.each([
    "awaiting-input",
    "awaiting-oauth",
    "awaiting-confirmation",
    "discovering",
    "completed",
    "failed",
    "cancelled",
    "expired",
  ] as const)("accepts flow status %s", (status) => {
    expect(integrationSetupStatusSchema.parse(status)).toBe(status);
    expect(integrationSetupFlowSnapshotSchema.safeParse({ ...flowFixture(), status }).success).toBe(
      true
    );
  });

  it.each([
    "unknown",
    "active",
    "expired",
    "revoked",
    "reauthentication-required",
    "failed",
  ] as const)("accepts auth status %s", (authStatus) => {
    expect(integrationAuthStatusSchema.parse(authStatus)).toBe(authStatus);
    expect(
      integrationSetupFlowSnapshotSchema.safeParse({ ...flowFixture(), authStatus }).success
    ).toBe(true);
  });

  it.each(["instruction", "credential", "oauth", "diagnostic"] as const)(
    "accepts C01 setup step kind %s",
    (kind) => {
      expect(integrationSetupStepKindSchema.parse(kind)).toBe(kind);
    }
  );

  it.each(["pending", "active", "completed", "failed"] as const)(
    "accepts step progress status %s",
    (status) => {
      expect(integrationSetupStepStatusSchema.parse(status)).toBe(status);
      expect(
        integrationSetupStepProgressSchema.safeParse({
          id: "setup.step",
          kind: "instruction",
          status,
          attempts: 0,
        }).success
      ).toBe(true);
    }
  );

  it("rejects unsupported enum values", () => {
    expect(integrationSetupModeSchema.safeParse("repair").success).toBe(false);
    expect(integrationSetupStatusSchema.safeParse("running").success).toBe(false);
    expect(integrationAuthStatusSchema.safeParse("healthy").success).toBe(false);
    expect(integrationSetupStepKindSchema.safeParse("discovery").success).toBe(false);
    expect(integrationSetupStepStatusSchema.safeParse("cancelled").success).toBe(false);
    expect(integrationSetupDuplicateDecisionSchema.safeParse("overwrite").success).toBe(false);
  });

  it("rejects unknown fields at every persisted snapshot boundary", () => {
    const root = { ...flowFixture(), metadata: { source: "unsafe" } };
    expect(integrationSetupFlowSnapshotSchema.safeParse(root).success).toBe(false);

    const step = flowFixture();
    step.steps[0] = { ...step.steps[0]!, metadata: "unsafe" } as (typeof step.steps)[number];
    expect(integrationSetupFlowSnapshotSchema.safeParse(step).success).toBe(false);

    const candidate = flowFixture();
    candidate.duplicateCandidates[0] = {
      ...candidate.duplicateCandidates[0]!,
      testStatus: "success",
    } as (typeof candidate.duplicateCandidates)[number];
    expect(integrationSetupFlowSnapshotSchema.safeParse(candidate).success).toBe(false);
  });

  it("explicitly rejects likely secret-bearing persisted snapshot fields", () => {
    for (const field of [
      "accessToken",
      "refreshToken",
      "clientSecret",
      "codeVerifier",
      "password",
      "encryptedData",
      "data",
      "apiKey",
      "authorizationCode",
    ]) {
      expect(
        integrationSetupFlowSnapshotSchema.safeParse({
          ...flowFixture(),
          [field]: "must-not-persist",
        }).success,
        `root field ${field}`
      ).toBe(false);

      const nestedStep = flowFixture();
      nestedStep.steps[0] = {
        ...nestedStep.steps[0]!,
        [field]: "must-not-persist",
      } as (typeof nestedStep.steps)[number];
      expect(
        integrationSetupFlowSnapshotSchema.safeParse(nestedStep).success,
        `step field ${field}`
      ).toBe(false);

      const nestedCandidate = flowFixture();
      nestedCandidate.duplicateCandidates[0] = {
        ...nestedCandidate.duplicateCandidates[0]!,
        [field]: "must-not-persist",
      } as (typeof nestedCandidate.duplicateCandidates)[number];
      expect(
        integrationSetupFlowSnapshotSchema.safeParse(nestedCandidate).success,
        `candidate field ${field}`
      ).toBe(false);
    }
  });

  it("enforces identifier, collection, attempt, revision, and failure-code bounds", () => {
    expect(
      integrationSetupFlowSnapshotSchema.safeParse({
        ...flowFixture(),
        id: "x".repeat(INTEGRATION_SETUP_LIMITS.id + 1),
      }).success
    ).toBe(false);
    expect(
      integrationSetupFlowSnapshotSchema.safeParse({
        ...flowFixture(),
        revision: INTEGRATION_SETUP_LIMITS.revision + 1,
      }).success
    ).toBe(false);
    expect(
      integrationSetupFlowSnapshotSchema.safeParse({ ...flowFixture(), revision: 0 }).success
    ).toBe(false);

    const attempts = flowFixture();
    attempts.steps[0] = {
      ...attempts.steps[0]!,
      attempts: INTEGRATION_SETUP_LIMITS.attempts + 1,
    };
    expect(integrationSetupFlowSnapshotSchema.safeParse(attempts).success).toBe(false);

    const tooManySteps = flowFixture();
    tooManySteps.currentStepId = undefined as never;
    tooManySteps.steps = Array.from({ length: INTEGRATION_SETUP_LIMITS.steps + 1 }, (_, index) => ({
      id: `setup.step-${index}`,
      kind: "instruction" as const,
      status: "pending" as const,
      attempts: 0,
    }));
    expect(integrationSetupFlowSnapshotSchema.safeParse(tooManySteps).success).toBe(false);

    const tooManyCandidates = flowFixture();
    tooManyCandidates.duplicateCandidates = Array.from(
      { length: INTEGRATION_SETUP_LIMITS.duplicateCandidates + 1 },
      (_, index) => ({
        id: `credential:${index}`,
        name: `Credential ${index}`,
        type: "github-oauth",
        accountLabel: `account-${index}`,
      })
    );
    expect(integrationSetupFlowSnapshotSchema.safeParse(tooManyCandidates).success).toBe(false);

    expect(
      integrationSetupFlowSnapshotSchema.safeParse({
        ...flowFixture(),
        failureCode: "Provider returned an access token",
      }).success
    ).toBe(false);
    expect(
      integrationSetupFlowSnapshotSchema.safeParse({
        ...flowFixture(),
        failureCode: "x".repeat(INTEGRATION_SETUP_LIMITS.failureCode + 1),
      }).success
    ).toBe(false);
    expect(
      integrationSetupFlowSnapshotSchema.safeParse({
        ...flowFixture(),
        failureCode: "oauth_access_denied",
      }).success
    ).toBe(true);
  });

  it("enforces step and duplicate-candidate references and uniqueness", () => {
    expect(
      integrationSetupFlowSnapshotSchema.safeParse({
        ...flowFixture(),
        currentStepId: "setup.missing",
      }).success
    ).toBe(false);

    const duplicateSteps = flowFixture();
    duplicateSteps.steps[2] = { ...duplicateSteps.steps[2]!, id: "setup.instructions" };
    expect(integrationSetupFlowSnapshotSchema.safeParse(duplicateSteps).success).toBe(false);

    const multipleActive = flowFixture();
    multipleActive.steps[2] = {
      ...multipleActive.steps[2]!,
      status: "active",
      startedAt: timestamps.currentStartedAt,
    };
    expect(integrationSetupFlowSnapshotSchema.safeParse(multipleActive).success).toBe(false);

    const wrongActiveReference = flowFixture();
    wrongActiveReference.currentStepId = "setup.oauth";
    expect(integrationSetupFlowSnapshotSchema.safeParse(wrongActiveReference).success).toBe(false);

    const duplicateCandidates = flowFixture();
    duplicateCandidates.duplicateCandidates.push({
      ...duplicateCandidates.duplicateCandidates[0]!,
      name: "same id",
    });
    expect(integrationSetupFlowSnapshotSchema.safeParse(duplicateCandidates).success).toBe(false);
  });

  it("requires ISO timestamps and chronological flow and step timestamps", () => {
    expect(
      integrationSetupFlowSnapshotSchema.safeParse({
        ...flowFixture(),
        updatedAt: "not-a-timestamp",
      }).success
    ).toBe(false);
    expect(
      integrationSetupFlowSnapshotSchema.safeParse({
        ...flowFixture(),
        updatedAt: "2026-07-13T09:59:59.000Z",
      }).success
    ).toBe(false);
    expect(
      integrationSetupFlowSnapshotSchema.safeParse({
        ...flowFixture(),
        expiresAt: timestamps.createdAt,
      }).success
    ).toBe(false);

    const reversedStep = flowFixture();
    reversedStep.steps[0] = {
      ...reversedStep.steps[0]!,
      completedAt: "2026-07-13T10:00:00.500Z",
    };
    expect(integrationSetupFlowSnapshotSchema.safeParse(reversedStep).success).toBe(false);

    const completedWithoutStart = flowFixture();
    delete completedWithoutStart.steps[0]!.startedAt;
    expect(integrationSetupFlowSnapshotSchema.safeParse(completedWithoutStart).success).toBe(false);

    const startsBeforeFlow = flowFixture();
    startsBeforeFlow.steps[0] = {
      ...startsBeforeFlow.steps[0]!,
      startedAt: "2026-07-13T09:59:59.000Z",
    };
    expect(integrationSetupFlowSnapshotSchema.safeParse(startsBeforeFlow).success).toBe(false);

    const completesAfterUpdate = flowFixture();
    completesAfterUpdate.steps[0] = {
      ...completesAfterUpdate.steps[0]!,
      completedAt: "2026-07-13T10:00:05.000Z",
    };
    expect(integrationSetupFlowSnapshotSchema.safeParse(completesAfterUpdate).success).toBe(false);
  });

  it("validates start and request-only credential submission payloads strictly", () => {
    expect(
      integrationSetupStartRequestSchema.parse({
        schemaVersion: 1,
        integrationId: "github.integration",
        manifestVersion: "1.2.3",
        manifestCredentialId: "github.auth",
        credentialType: "github-oauth",
        mode: "setup",
      })
    ).toMatchObject({ mode: "setup" });

    const submission = {
      schemaVersion: 1,
      flowId: "setup-flow:01",
      revision: 2,
      stepId: "setup.credentials",
      data: { clientId: "public-id", clientSecret: "raw-request-only" },
    };
    expect(integrationSetupCredentialSubmissionRequestSchema.safeParse(submission).success).toBe(
      true
    );
    expect(
      integrationSetupCredentialSubmissionRequestSchema.safeParse({
        ...submission,
        data: { nested: { password: "not-json-string-data" } },
      }).success
    ).toBe(false);
    expect(
      integrationSetupCredentialSubmissionRequestSchema.safeParse({
        ...submission,
        metadata: {},
      }).success
    ).toBe(false);
    expect(
      integrationSetupStartRequestSchema.safeParse({
        schemaVersion: 1,
        integrationId: "github.integration",
        manifestVersion: "1.2.3",
        credentialType: "github-oauth",
        mode: "setup",
        metadata: {},
      }).success
    ).toBe(false);
    expect(
      integrationSetupCredentialSubmissionRequestSchema.safeParse({
        ...submission,
        data: Object.fromEntries(
          Array.from({ length: INTEGRATION_SETUP_LIMITS.credentialFields + 1 }, (_, index) => [
            `field${index}`,
            "value",
          ])
        ),
      }).success
    ).toBe(false);
    expect(
      integrationSetupCredentialSubmissionRequestSchema.safeParse({
        ...submission,
        data: { value: "x".repeat(INTEGRATION_SETUP_LIMITS.credentialValue + 1) },
      }).success
    ).toBe(false);
    expect(
      integrationSetupFlowSnapshotSchema.safeParse({ ...flowFixture(), data: submission.data })
        .success
    ).toBe(false);
  });

  it("strictly validates instruction acknowledgement identity and current step", () => {
    const acknowledgement = {
      schemaVersion: 1 as const,
      flowId: "setup-flow:01",
      revision: 2,
      stepId: "setup.instructions",
    };

    expect(integrationSetupInstructionAcknowledgementRequestSchema.parse(acknowledgement)).toEqual(
      acknowledgement
    );
    expect(
      integrationSetupInstructionAcknowledgementRequestSchema.safeParse({
        ...acknowledgement,
        acknowledged: true,
      }).success
    ).toBe(false);
    expect(
      integrationSetupInstructionAcknowledgementRequestSchema.safeParse({
        ...acknowledgement,
        stepId: undefined,
      }).success
    ).toBe(false);
    expect(
      integrationSetupInstructionAcknowledgementRequestSchema.safeParse({
        ...acknowledgement,
        schemaVersion: 2,
      }).success
    ).toBe(false);
  });

  it.each([
    { decision: "reuse-existing", credentialId: "credential:existing" },
    { decision: "replace-existing", credentialId: "credential:existing" },
    { decision: "create-additional" },
    { decision: "cancel" },
  ] as const)("accepts duplicate decision $decision", (decision) => {
    expect(
      integrationSetupDuplicateDecisionRequestSchema.safeParse({
        schemaVersion: 1,
        flowId: "setup-flow:01",
        revision: 2,
        ...decision,
      }).success
    ).toBe(true);
  });

  it("requires a candidate only for decisions that operate on an existing credential", () => {
    expect(
      integrationSetupDuplicateDecisionRequestSchema.safeParse({
        schemaVersion: 1,
        flowId: "setup-flow:01",
        revision: 2,
        decision: "reuse-existing",
      }).success
    ).toBe(false);
    expect(
      integrationSetupDuplicateDecisionRequestSchema.safeParse({
        schemaVersion: 1,
        flowId: "setup-flow:01",
        revision: 2,
        decision: "cancel",
        credentialId: "credential:existing",
      }).success
    ).toBe(false);
  });

  it("validates server-derived discovery triggers and strict flow responses", () => {
    const trigger = {
      schemaVersion: 1 as const,
      flowId: "setup-flow:01",
      revision: 2,
      stepId: "setup.diagnostic",
    };
    expect(integrationSetupDiscoveryRequestSchema.parse(trigger)).toEqual(trigger);
    expect(
      integrationSetupDiscoveryRequestSchema.safeParse({
        ...trigger,
        authStatus: "active",
      }).success
    ).toBe(false);
    expect(integrationSetupFlowResponseSchema.safeParse({ data: flowFixture() }).success).toBe(
      true
    );
    expect(
      integrationSetupFlowResponseSchema.safeParse({ data: flowFixture(), metadata: {} }).success
    ).toBe(false);
  });
});
