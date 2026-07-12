import { describe, expect, it } from "vitest";
import {
  CANONICAL_TRAJECTORY_COMPATIBILITY,
  CANONICAL_TRAJECTORY_SCHEMA_VERSION,
  TRAJECTORY_PAYLOAD_LIMITS,
  TRAJECTORY_REDACTED_VALUE,
  parseCanonicalTrajectory,
  safeParseCanonicalTrajectory,
  sanitizeTrajectoryValue,
  trajectoryErrorSchema,
} from "../src/types/trajectory.js";
import {
  CONTEXT_LAYER_ORDER,
  CONTEXT_LAYER_POLICIES,
  parseContextAssembly,
  projectContextAssemblyTrace,
} from "../src/types/context.js";

const startedAt = "2026-07-10T09:00:00.000Z";
const completedAt = "2026-07-10T09:00:02.000Z";
const PRIVATE_CONTEXT_BODY = "PRIVATE_CONTEXT_BODY_trajectory_schema_7f41e9";

function expectRoundTrip(input: unknown) {
  const parsed = parseCanonicalTrajectory(input);
  expect(parseCanonicalTrajectory(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  return parsed;
}

function completedChatTrajectory() {
  return {
    schemaVersion: CANONICAL_TRAJECTORY_SCHEMA_VERSION,
    id: "traj-chat-1",
    origin: { kind: "web-chat", sessionId: "session-1" },
    actor: { type: "user", id: "user-1" },
    status: "completed",
    startedAt,
    completedAt,
    durationMs: 2000,
    input: { text: "List my GitHub repositories" },
    output: { text: "Found three repositories" },
    steps: [
      {
        id: "step-1",
        trajectoryId: "traj-chat-1",
        sequence: 0,
        kind: "trajectory.started",
        status: "completed",
        startedAt,
        completedAt: startedAt,
      },
      {
        id: "step-2",
        trajectoryId: "traj-chat-1",
        sequence: 1,
        kind: "model.response",
        status: "completed",
        startedAt,
        completedAt,
        modelUsage: {
          providerId: "anthropic",
          modelId: "claude-sonnet",
          inputTokens: 100,
          outputTokens: 40,
        },
      },
      {
        id: "step-3",
        trajectoryId: "traj-chat-1",
        sequence: 2,
        kind: "tool.call",
        status: "completed",
        startedAt,
        completedAt,
        input: { owner: "octocat" },
        toolCall: {
          toolCallId: "call-1",
          toolName: "github.list_repositories",
          toolKind: "mcp",
          credentialRefs: [{ credentialId: "cred-1", credentialType: "github" }],
        },
      },
      {
        id: "step-4",
        trajectoryId: "traj-chat-1",
        sequence: 3,
        kind: "approval.resolved",
        status: "completed",
        startedAt,
        completedAt,
        approval: {
          approvalId: "approval-1",
          kind: "external-mutation",
          risk: "high",
          status: "allowed",
          decision: "allow-once",
          requestedAt: startedAt,
          resolvedAt: completedAt,
        },
      },
    ],
  } as const;
}

function contextAssembly(content: string = PRIVATE_CONTEXT_BODY) {
  const layers = CONTEXT_LAYER_ORDER.map((layer, index) => {
    const policy = structuredClone(CONTEXT_LAYER_POLICIES[index]);
    const included = index === 0 ? 5 : 0;
    return {
      layer,
      policy,
      tokenBudget: index === 0 ? 20 : 0,
      items:
        index === 0
          ? [
              {
                id: "context-item-identity",
                owner: "system",
                mutability: "immutable",
                modelVisibility: "always",
                authority: "system",
                reference: { namespace: "context", id: "identity-1", revision: "1" },
                source: { kind: "block", id: "block-1", revision: "1" },
                representation: { kind: "full", id: "identity.full", version: "1" },
                ordering: { canonicalRank: 1, declaredOrder: 0 },
                inclusionReasons: [{ kind: "required", code: "contract-required" }],
                accounting: {
                  sourceTokens: included,
                  includedTokens: included,
                  truncatedTokens: 0,
                },
                content,
              },
            ]
          : [],
      accounting: {
        sourceTokens: included,
        includedTokens: included,
        truncatedTokens: 0,
        overflowTokens: 0,
      },
    };
  });
  return parseContextAssembly({
    schemaVersion: 1,
    id: "assembly-trajectory-schema",
    createdAt: startedAt,
    configuration: {
      tokenizer: { id: "test-tokenizer", version: "1" },
      retrievalScoring: { id: "test-scoring", version: "1" },
      contextWindowTokens: 100,
      systemInstructionTokens: 20,
      developerInstructionTokens: 10,
      currentRequestTokens: 10,
      otherPromptTokens: 10,
      responseReserveTokens: 20,
      toolDefinitionTokens: 10,
      hierarchyBudgetTokens: 20,
    },
    layers,
    accounting: {
      sourceTokens: 5,
      includedTokens: 5,
      truncatedTokens: 0,
      overflowTokens: 0,
    },
  });
}

describe("canonical trajectory v1", () => {
  it("round-trips a representative chat/tool/approval trajectory", () => {
    const parsed = expectRoundTrip(completedChatTrajectory());

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.steps).toHaveLength(4);
    expect(parsed.steps[2].toolCall?.credentialRefs[0]).toEqual({
      credentialId: "cred-1",
      credentialType: "github",
    });
  });

  it("validates content-free B12 traces while retaining legacy v1 read compatibility", () => {
    const runtimeAssembly = contextAssembly();
    const trace = projectContextAssemblyTrace(runtimeAssembly);
    const contextStep = {
      id: "step-context",
      trajectoryId: "traj-chat-1",
      sequence: 0,
      kind: "context.assembled",
      status: "completed",
      name: "Context assembled",
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      contextAssembly: trace,
    } as const;

    const parsed = parseCanonicalTrajectory({
      ...completedChatTrajectory(),
      steps: [contextStep],
    });
    expect(parsed.steps[0].contextAssembly).toEqual(trace);
    expect(JSON.stringify(parsed.steps[0])).not.toContain(PRIVATE_CONTEXT_BODY);
    expect(JSON.stringify(parsed.steps[0])).not.toContain('"content"');

    expect(
      safeParseCanonicalTrajectory({
        ...completedChatTrajectory(),
        steps: [
          {
            ...contextStep,
            contextAssembly: undefined,
            input: { legacy: true },
            attributes: { legacyProducer: true },
          },
        ],
      }).success
    ).toBe(true);
    expect(
      safeParseCanonicalTrajectory({
        ...completedChatTrajectory(),
        steps: [{ ...contextStep, contextAssembly: runtimeAssembly }],
      }).success
    ).toBe(false);

    const malformedTrace = structuredClone(trace);
    malformedTrace.layers[0].items[0].inclusionReasons = [];
    expect(
      safeParseCanonicalTrajectory({
        ...completedChatTrajectory(),
        steps: [{ ...contextStep, contextAssembly: malformedTrace }],
      }).success
    ).toBe(false);
  });

  it("rejects generic or extension payloads on context.assembled steps", () => {
    const contextStep = {
      id: "step-context-exclusive",
      trajectoryId: "traj-chat-1",
      sequence: 0,
      kind: "context.assembled",
      status: "completed",
      name: "Context assembled",
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      contextAssembly: projectContextAssemblyTrace(contextAssembly()),
    } as const;

    for (const extraPayload of [
      { input: { content: PRIVATE_CONTEXT_BODY } },
      { output: { content: PRIVATE_CONTEXT_BODY } },
      { attributes: { content: PRIVATE_CONTEXT_BODY } },
      { privateContextBody: PRIVATE_CONTEXT_BODY },
      { actor: { type: "test", id: "test", privateContextBody: PRIVATE_CONTEXT_BODY } },
      {
        modelUsage: {
          providerId: "test",
          modelId: "test",
          privateContextBody: PRIVATE_CONTEXT_BODY,
        },
      },
      {
        toolCall: {
          toolCallId: "test",
          toolName: "test",
          toolKind: "system",
          privateContextBody: PRIVATE_CONTEXT_BODY,
        },
      },
      {
        error: {
          code: "test",
          category: "test",
          message: "test",
          details: { privateContextBody: PRIVATE_CONTEXT_BODY },
        },
      },
      {
        artifacts: [
          {
            artifactId: "test",
            kind: "trace",
            locator: PRIVATE_CONTEXT_BODY,
          },
        ],
      },
    ]) {
      expect(
        safeParseCanonicalTrajectory({
          ...completedChatTrajectory(),
          steps: [{ ...contextStep, ...extraPayload }],
        }).success
      ).toBe(false);
    }
  });

  it("represents scheduled failures and channel waits", () => {
    const failedSchedule = {
      schemaVersion: 1,
      id: "traj-schedule-1",
      origin: { kind: "schedule", scheduleId: "schedule-1" },
      actor: { type: "schedule", id: "schedule-1" },
      status: "failed",
      startedAt,
      completedAt,
      error: {
        code: "provider.rate_limit",
        category: "provider",
        message: "Provider returned 429",
        retryable: true,
      },
      steps: [
        {
          id: "step-failed",
          trajectoryId: "traj-schedule-1",
          sequence: 0,
          kind: "trajectory.failed",
          status: "failed",
          startedAt,
          completedAt,
          error: {
            code: "provider.rate_limit",
            category: "provider",
            message: "Provider returned 429",
            retryable: true,
          },
        },
      ],
    };
    expect(expectRoundTrip(failedSchedule).status).toBe("failed");

    const waitingChannel = {
      schemaVersion: 1,
      id: "traj-channel-1",
      origin: { kind: "channel", channelType: "telegram", channelId: "chat-1" },
      actor: { type: "channel", id: "chat-1" },
      status: "waiting",
      startedAt,
      steps: [
        {
          id: "step-waiting",
          trajectoryId: "traj-channel-1",
          sequence: 0,
          kind: "approval.requested",
          status: "waiting",
          startedAt,
          approval: {
            approvalId: "approval-2",
            kind: "shell",
            risk: "high",
            status: "pending",
            requestedAt: startedAt,
          },
        },
      ],
    };
    expect(expectRoundTrip(waitingChannel).status).toBe("waiting");
  });

  it("preserves additive v1 fields while rejecting unknown semantic enums", () => {
    const input = {
      ...completedChatTrajectory(),
      producerExtension: { version: 2 },
      extensionSecret: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz" },
      origin: {
        ...completedChatTrajectory().origin,
        futureOriginMetadata: "preserved",
      },
    };
    const parsed = parseCanonicalTrajectory(input) as Record<string, unknown>;
    expect(parsed.producerExtension).toEqual({ version: 2 });
    expect(parsed.extensionSecret).toEqual({ apiKey: TRAJECTORY_REDACTED_VALUE });
    expect((parsed.origin as Record<string, unknown>).futureOriginMetadata).toBe("preserved");
    expect(CANONICAL_TRAJECTORY_COMPATIBILITY.additiveFields).toBe("preserve");

    expect(
      safeParseCanonicalTrajectory({ ...completedChatTrajectory(), status: "future-status" })
        .success
    ).toBe(false);
    expect(
      safeParseCanonicalTrajectory({ ...completedChatTrajectory(), schemaVersion: 2 }).success
    ).toBe(false);
  });

  it("redacts sensitive keys and embedded credentials without mutating input", () => {
    const payload = {
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
      "X-API-Key": "opaque-header-secret",
      "X-Auth-Token": "opaque-auth-secret",
      nested: {
        accessToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signaturevalue",
        message: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        url: "https://api.example.test/items?api_key=secret-value&page=1",
        credentialId: "cred-safe-metadata",
        inputTokens: 42,
      },
    };

    const sanitized = sanitizeTrajectoryValue(payload);
    expect(sanitized).toEqual({
      apiKey: TRAJECTORY_REDACTED_VALUE,
      "X-API-Key": TRAJECTORY_REDACTED_VALUE,
      "X-Auth-Token": TRAJECTORY_REDACTED_VALUE,
      nested: {
        accessToken: TRAJECTORY_REDACTED_VALUE,
        message: `Authorization=${TRAJECTORY_REDACTED_VALUE}`,
        url: `https://api.example.test/items?api_key=${TRAJECTORY_REDACTED_VALUE}&page=1`,
        credentialId: "cred-safe-metadata",
        inputTokens: 42,
      },
    });
    expect(payload.apiKey).toBe("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts secrets during schema parsing, including error text and artifacts", () => {
    const parsed = parseCanonicalTrajectory({
      ...completedChatTrajectory(),
      output: { password: "hunter2", note: "Bearer abcdefghijklmnop" },
      artifacts: [
        {
          artifactId: "artifact-1",
          kind: "log",
          locator: "https://logs.test/view?access_token=super-secret",
        },
      ],
      summary: "api_key=top-secret",
      labels: ["password=hunter2", "safe-label"],
    });

    expect(parsed.output).toEqual({
      password: TRAJECTORY_REDACTED_VALUE,
      note: `Bearer ${TRAJECTORY_REDACTED_VALUE}`,
    });
    expect(parsed.artifacts[0].locator).toContain(TRAJECTORY_REDACTED_VALUE);
    expect(parsed.summary).toBe(`api_key=${TRAJECTORY_REDACTED_VALUE}`);
    expect(parsed.labels).toEqual([`password=${TRAJECTORY_REDACTED_VALUE}`, "safe-label"]);

    expect(
      trajectoryErrorSchema.parse({
        code: "provider.unauthorized",
        category: "provider",
        message: "Cookie: session=super-secret; path=/",
      }).message
    ).toBe(`Cookie=${TRAJECTORY_REDACTED_VALUE}`);
  });

  it("rejects invalid ordering, mismatched ids, missing required detail, and non-JSON data", () => {
    const invalid = completedChatTrajectory();
    const reversed = {
      ...invalid,
      steps: [
        { ...invalid.steps[0], sequence: 1 },
        { ...invalid.steps[1], sequence: 0 },
      ],
    };
    expect(safeParseCanonicalTrajectory(reversed).success).toBe(false);

    const mismatched = {
      ...invalid,
      steps: [{ ...invalid.steps[0], trajectoryId: "other" }],
    };
    expect(safeParseCanonicalTrajectory(mismatched).success).toBe(false);

    const missingToolDetails = {
      ...invalid,
      steps: [{ ...invalid.steps[0], kind: "tool.call" }],
    };
    expect(safeParseCanonicalTrajectory(missingToolDetails).success).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidPayload = { ...invalid, output: cyclic };
    expect(safeParseCanonicalTrajectory(invalidPayload).success).toBe(false);

    const unsafeKey = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(safeParseCanonicalTrajectory({ ...invalid, output: unsafeKey }).success).toBe(false);

    const oversizedPayload = new Array(TRAJECTORY_PAYLOAD_LIMITS.maxNodes).fill(null);
    expect(safeParseCanonicalTrajectory({ ...invalid, output: oversizedPayload }).success).toBe(
      false
    );
  });
});
