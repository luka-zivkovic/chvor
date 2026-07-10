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

const startedAt = "2026-07-10T09:00:00.000Z";
const completedAt = "2026-07-10T09:00:02.000Z";

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
