import { describe, expect, it } from "vitest";
import {
  EVALUATION_CASE_DOCUMENT_MAX_BYTES,
  EVALUATION_CASE_SCHEMA_VERSION,
  EVALUATION_CASE_TRANSIENT_ID_VALUE,
  EVALUATION_CASE_TRANSIENT_TIMESTAMP_VALUE,
  evaluationCaseRecordSchema,
  evaluationCaseUpdateSchema,
  parseEvaluationCaseDocument,
  parseEvaluationCaseDocumentJson,
  safeParseEvaluationCaseDocument,
  serializeEvaluationCaseDocument,
} from "../src/types/evaluation-case.js";
import { TRAJECTORY_REDACTED_VALUE } from "../src/types/trajectory.js";

function documentFixture() {
  return {
    schemaVersion: EVALUATION_CASE_SCHEMA_VERSION,
    name: "Repository lookup",
    input: { owner: "octocat" },
    expected: {
      status: "completed",
      outputContains: ["three repositories"],
    },
    requiredTools: ["github.list_repositories"],
    forbiddenTools: ["shell.execute"],
    safetyAssertions: ["no-secrets-in-output"],
  } as const;
}

describe("evaluation case document v1", () => {
  it("parses the portable contract and accepts each expected outcome form", () => {
    expect(parseEvaluationCaseDocument(documentFixture()).schemaVersion).toBe(1);

    const outputOnly = {
      ...documentFixture(),
      expected: { output: { count: 3 }, outputContains: [] },
    };
    expect(parseEvaluationCaseDocument(outputOnly).expected.output).toEqual({ count: 3 });

    const substringOnly = {
      ...documentFixture(),
      expected: { outputContains: ["repository"] },
    };
    expect(parseEvaluationCaseDocument(substringOnly).expected.outputContains).toEqual([
      "repository",
    ]);
  });

  it("requires an expected outcome and rejects unsupported values or extra fields", () => {
    expect(
      safeParseEvaluationCaseDocument({
        ...documentFixture(),
        expected: { outputContains: [] },
      }).success
    ).toBe(false);
    expect(
      safeParseEvaluationCaseDocument({
        ...documentFixture(),
        expected: { status: "running", outputContains: [] },
      }).success
    ).toBe(false);
    expect(
      safeParseEvaluationCaseDocument({ ...documentFixture(), schemaVersion: 2 }).success
    ).toBe(false);
    expect(
      safeParseEvaluationCaseDocument({ ...documentFixture(), trajectoryId: "trajectory-1" })
        .success
    ).toBe(false);
    expect(
      safeParseEvaluationCaseDocument({
        ...documentFixture(),
        expected: { ...documentFixture().expected, toolCallId: "call-1" },
      }).success
    ).toBe(false);
  });

  it("redacts every free-text and JSON payload without mutating the input", () => {
    const input = {
      ...documentFixture(),
      name: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      input: {
        apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
        note: "password=hunter2",
      },
      expected: {
        output: { token: "opaque-secret", note: "Bearer abcdefghijklmnop" },
        outputContains: [" api_key=top-secret "],
      },
      requiredTools: [" api_token=tool-secret "],
      forbiddenTools: [" password=tool-secret "],
    };

    const parsed = parseEvaluationCaseDocument(input);

    expect(parsed.name).toBe(`Authorization=${TRAJECTORY_REDACTED_VALUE}`);
    expect(parsed.input).toEqual({
      apiKey: TRAJECTORY_REDACTED_VALUE,
      note: `password=${TRAJECTORY_REDACTED_VALUE}`,
    });
    expect(parsed.expected.output).toEqual({
      token: TRAJECTORY_REDACTED_VALUE,
      note: `Bearer ${TRAJECTORY_REDACTED_VALUE}`,
    });
    expect(parsed.expected.outputContains).toEqual([`api_key=${TRAJECTORY_REDACTED_VALUE}`]);
    expect(parsed.requiredTools).toEqual([`api_token=${TRAJECTORY_REDACTED_VALUE}`]);
    expect(parsed.forbiddenTools).toEqual([`password=${TRAJECTORY_REDACTED_VALUE}`]);
    expect(input.input.apiKey).toBe("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("removes known transient identifiers from nested portable payloads", () => {
    const parsed = parseEvaluationCaseDocument({
      ...documentFixture(),
      input: {
        sessionId: "session-1",
        nested: [{ tool_call_id: "call-1", businessId: "stable-business-id" }],
      },
      expected: {
        output: { trajectoryId: "trajectory-1", artifact_id: "artifact-1" },
        outputContains: [],
      },
    });

    expect(parsed.input).toEqual({
      sessionId: EVALUATION_CASE_TRANSIENT_ID_VALUE,
      nested: [
        { tool_call_id: EVALUATION_CASE_TRANSIENT_ID_VALUE, businessId: "stable-business-id" },
      ],
    });
    expect(parsed.expected.output).toEqual({
      trajectoryId: EVALUATION_CASE_TRANSIENT_ID_VALUE,
      artifact_id: EVALUATION_CASE_TRANSIENT_ID_VALUE,
    });
  });

  it("removes generic IDs and timestamps from known captured message and media shapes", () => {
    const parsed = parseEvaluationCaseDocument({
      ...documentFixture(),
      input: [
        {
          id: "message-1",
          role: "user",
          content: "show this",
          channelType: "web",
          timestamp: "2026-07-11T10:00:00.000Z",
          audioUrl: "/audio/transient.mp3",
          media: [
            {
              id: "media-1",
              url: "/api/media/transient.png",
              mimeType: "image/png",
              mediaType: "image",
            },
          ],
          actions: [
            {
              tool: "search",
              summary: "searched",
              timestamp: "2026-07-11T10:00:01.000Z",
            },
          ],
        },
        { id: "stable-business-id", timestamp: "2026-07-11", value: "domain data" },
      ],
    });

    expect(parsed.input).toEqual([
      {
        id: EVALUATION_CASE_TRANSIENT_ID_VALUE,
        role: "user",
        content: "show this",
        channelType: "web",
        timestamp: EVALUATION_CASE_TRANSIENT_TIMESTAMP_VALUE,
        audioUrl: EVALUATION_CASE_TRANSIENT_ID_VALUE,
        media: [
          {
            id: EVALUATION_CASE_TRANSIENT_ID_VALUE,
            url: EVALUATION_CASE_TRANSIENT_ID_VALUE,
            mimeType: "image/png",
            mediaType: "image",
          },
        ],
        actions: [
          {
            tool: "search",
            summary: "searched",
            timestamp: EVALUATION_CASE_TRANSIENT_TIMESTAMP_VALUE,
          },
        ],
      },
      { id: "stable-business-id", timestamp: "2026-07-11", value: "domain data" },
    ]);
  });

  it("removes transient identity and time fields throughout captured emotion snapshots", () => {
    const parsed = parseEvaluationCaseDocument({
      ...documentFixture(),
      expected: {
        output: {
          emotionSnapshot: {
            id: "snapshot-1",
            sessionId: "session-1",
            vad: { valence: 0.2, arousal: 0.4, dominance: 0.6 },
            blend: { primary: { emotion: "joy", weight: 1 }, intensity: 0.5 },
            displayLabel: "calm",
            color: "#fff",
            timestamp: "2026-07-11T10:00:00.000Z",
            advancedState: {
              mood: { since: "2026-07-11T09:00:00.000Z" },
              relationship: { firstInteraction: "2026-01-01T00:00:00.000Z" },
              unresolvedResidues: [
                {
                  id: "residue-1",
                  snapshotId: "snapshot-0",
                  unresolvedSince: "2026-07-10T10:00:00.000Z",
                },
              ],
            },
          },
        },
        outputContains: [],
      },
    });

    expect(parsed.expected.output).toMatchObject({
      emotionSnapshot: {
        id: EVALUATION_CASE_TRANSIENT_ID_VALUE,
        sessionId: EVALUATION_CASE_TRANSIENT_ID_VALUE,
        timestamp: EVALUATION_CASE_TRANSIENT_TIMESTAMP_VALUE,
        advancedState: {
          mood: { since: EVALUATION_CASE_TRANSIENT_TIMESTAMP_VALUE },
          relationship: { firstInteraction: EVALUATION_CASE_TRANSIENT_TIMESTAMP_VALUE },
          unresolvedResidues: [
            {
              id: EVALUATION_CASE_TRANSIENT_ID_VALUE,
              snapshotId: EVALUATION_CASE_TRANSIENT_ID_VALUE,
              unresolvedSince: EVALUATION_CASE_TRANSIENT_TIMESTAMP_VALUE,
            },
          ],
        },
      },
    });
  });

  it("trims, removes empty entries, deduplicates, and sorts set-like arrays", () => {
    const parsed = parseEvaluationCaseDocument({
      ...documentFixture(),
      expected: { outputContains: [" zebra ", "alpha", "", " alpha "] },
      requiredTools: [" tool.z ", "tool.a", "tool.z", "   "],
      forbiddenTools: ["tool.b", " tool.c ", "tool.b"],
      safetyAssertions: [
        "require-approval-for-required-tools",
        "no-secrets-in-output",
        "require-approval-for-required-tools",
      ],
    });

    expect(parsed.expected.outputContains).toEqual(["alpha", "zebra"]);
    expect(parsed.requiredTools).toEqual(["tool.a", "tool.z"]);
    expect(parsed.forbiddenTools).toEqual(["tool.b", "tool.c"]);
    expect(parsed.safetyAssertions).toEqual([
      "no-secrets-in-output",
      "require-approval-for-required-tools",
    ]);
  });

  it("rejects empty names and contradictory tool assertions", () => {
    expect(safeParseEvaluationCaseDocument({ ...documentFixture(), name: "   " }).success).toBe(
      false
    );
    expect(
      safeParseEvaluationCaseDocument({
        ...documentFixture(),
        requiredTools: ["tool.same"],
        forbiddenTools: ["tool.same"],
      }).success
    ).toBe(false);
  });

  it("enforces text bounds again after redaction expands secret markers", () => {
    const expandingName = "password=x ".repeat(40).trim();
    const expandingSubstring = "password=x ".repeat(300).trim();
    const expandingToolName = "password=x ".repeat(20).trim();

    expect(
      safeParseEvaluationCaseDocument({
        ...documentFixture(),
        name: expandingName,
      }).success
    ).toBe(false);
    expect(
      safeParseEvaluationCaseDocument({
        ...documentFixture(),
        expected: { outputContains: [expandingSubstring] },
      }).success
    ).toBe(false);
    expect(
      safeParseEvaluationCaseDocument({
        ...documentFixture(),
        requiredTools: [expandingToolName],
      }).success
    ).toBe(false);
  });

  it("rejects documents above the canonical persisted byte limit", () => {
    expect(
      safeParseEvaluationCaseDocument({
        ...documentFixture(),
        input: { text: "x".repeat(EVALUATION_CASE_DOCUMENT_MAX_BYTES) },
      }).success
    ).toBe(false);
  });

  it("serializes canonical JSON with recursively sorted keys and a final newline", () => {
    const document = {
      ...documentFixture(),
      input: { z: 1, nested: { z: true, a: false }, a: 2 },
      expected: {
        output: { z: 1, a: 2 },
        outputContains: [" zeta ", "alpha"],
        status: "completed",
      },
      requiredTools: ["tool.z", "tool.a"],
    };

    const serialized = serializeEvaluationCaseDocument(document);
    const reparsed = parseEvaluationCaseDocumentJson(serialized);
    const canonicalJson = JSON.parse(serialized) as {
      input: Record<string, unknown>;
      expected: { output: Record<string, unknown> };
    };

    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).toBe(serializeEvaluationCaseDocument(reparsed));
    expect(Object.keys(canonicalJson)).toEqual([
      "expected",
      "forbiddenTools",
      "input",
      "name",
      "requiredTools",
      "safetyAssertions",
      "schemaVersion",
    ]);
    expect(Object.keys(canonicalJson.input)).toEqual(["a", "nested", "z"]);
    expect(Object.keys(canonicalJson.expected.output)).toEqual(["a", "z"]);
    expect(reparsed.requiredTools).toEqual(["tool.a", "tool.z"]);
    expect(reparsed.expected.outputContains).toEqual(["alpha", "zeta"]);
  });

  it("rejects malformed JSON and non-JSON payloads", () => {
    expect(() => parseEvaluationCaseDocumentJson("{not-json}")).toThrow(SyntaxError);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(safeParseEvaluationCaseDocument({ ...documentFixture(), input: cyclic }).success).toBe(
      false
    );
  });
});

describe("local evaluation case metadata", () => {
  it("validates immutable revision records separately from portable documents", () => {
    const record = evaluationCaseRecordSchema.parse({
      id: "case-1",
      revision: 2,
      document: documentFixture(),
      createdAt: "2026-07-11T08:00:00.000Z",
      updatedAt: "2026-07-11T09:00:00.000Z",
    });

    expect(record.revision).toBe(2);
    expect(JSON.parse(serializeEvaluationCaseDocument(record.document))).not.toHaveProperty("id");
    expect(evaluationCaseRecordSchema.safeParse({ ...record, revision: 0 }).success).toBe(false);
  });

  it("requires a positive expected revision for optimistic updates", () => {
    expect(
      evaluationCaseUpdateSchema.safeParse({
        expectedRevision: 2,
        document: documentFixture(),
      }).success
    ).toBe(true);
    expect(
      evaluationCaseUpdateSchema.safeParse({
        expectedRevision: 0,
        document: documentFixture(),
      }).success
    ).toBe(false);
  });
});
