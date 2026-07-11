import { describe, expect, it } from "vitest";
import {
  evaluationComparisonSchema,
  evaluationRunConfigurationSchema,
  parseEvaluationRunReport,
  serializeEvaluationRunReport,
} from "../src/types/evaluation-run.js";

const hash = "a".repeat(64);

function configuration() {
  return {
    engineId: "chvor-isolated-v1" as const,
    providerId: "openai",
    modelId: "test-model",
    prompt: "Be helpful",
    promptHash: hash,
    temperature: 0,
    maxRounds: 2,
    caseTimeoutMs: 10_000,
    pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    limits: { maxCostUsdPerCase: 1, maxLatencyMsPerCase: 2_000 },
    tools: [
      {
        name: "write_file",
        description: "simulated",
        effect: "write" as const,
        approval: "auto-deny" as const,
        result: { secret: "not persisted" },
      },
    ],
  };
}

function report() {
  return {
    schemaVersion: 1 as const,
    id: "run-1",
    configuration: configuration(),
    configurationHash: hash,
    startedAt: "2026-07-11T12:00:00.000Z",
    completedAt: "2026-07-11T12:00:01.000Z",
    status: "completed" as const,
    passed: true,
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      criticalFailed: 0,
      totalCostUsd: 0.000003,
      totalLatencyMs: 10,
    },
    environment: {
      runnerVersion: "1",
      chvorVersion: "1",
      sourceCommit: null,
      nodeVersion: "v22",
      platform: "darwin",
      architecture: "arm64",
    },
    cases: [
      {
        position: 0,
        snapshot: {
          caseId: "case-1",
          revision: 1,
          documentHash: hash,
          critical: true,
          document: {
            schemaVersion: 1,
            name: "safe case",
            input: "hello",
            expected: { status: "completed", outputContains: ["hello"] },
            requiredTools: [],
            forbiddenTools: [],
            safetyAssertions: ["no-secrets-in-output"],
          },
        },
        observation: {
          status: "completed",
          output: "hello",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 10,
          costUsd: 0.000003,
          error: null,
        },
        assertions: [{ kind: "completion", status: "passed", message: "matched" }],
        passed: true,
      },
    ],
    error: null,
  };
}

describe("evaluation run contract", () => {
  it("normalizes tools and redacts persisted tool fixtures", () => {
    const parsed = evaluationRunConfigurationSchema.parse({
      ...configuration(),
      tools: [
        { name: "z", effect: "read", approval: "auto-approve", result: "ok" },
        { name: "a", effect: "write", approval: "auto-deny", result: "api_key=raw" },
      ],
    });
    expect(parsed.tools.map(({ name }) => name)).toEqual(["a", "z"]);
    expect(parsed.tools[0].result).toBe("api_key=[REDACTED]");
  });

  it("rejects duplicate tools and credential-bearing config fields", () => {
    expect(() =>
      evaluationRunConfigurationSchema.parse({
        ...configuration(),
        apiKey: "raw",
        tools: [
          { name: "same", effect: "read", approval: "auto-approve", result: null },
          { name: "same", effect: "read", approval: "auto-approve", result: null },
        ],
      })
    ).toThrow();
    expect(() =>
      evaluationRunConfigurationSchema.parse({
        ...configuration(),
        modelId: "sk-accidentally-pasted-secret-value",
      })
    ).toThrow(/credential-like/);
    expect(() =>
      evaluationRunConfigurationSchema.parse({
        ...configuration(),
        providerId: "custom-llm",
      })
    ).toThrow();
  });

  it("round-trips canonical reports without secrets", () => {
    const parsed = parseEvaluationRunReport(report());
    const serialized = serializeEvaluationRunReport(parsed);
    expect(serialized).not.toContain("not persisted");
    expect(serialized).toContain("[REDACTED]");
    expect(serializeEvaluationRunReport(JSON.parse(serialized))).toBe(serialized);
  });

  it("rejects inconsistent summaries and positions", () => {
    expect(() =>
      parseEvaluationRunReport({ ...report(), summary: { ...report().summary, total: 0 } })
    ).toThrow();
    expect(() =>
      parseEvaluationRunReport({
        ...report(),
        cases: [{ ...report().cases[0], position: 2 }],
      })
    ).toThrow();
  });

  it("allows the complete union of two 100-case reports", () => {
    expect(
      evaluationComparisonSchema.parse({
        baselineRunId: "baseline",
        candidateRunId: "candidate",
        regressions: 0,
        improvements: 0,
        rows: Array.from({ length: 200 }, (_, position) => ({
          position,
          caseName: `case ${position}`,
          classification: position < 100 ? "baseline-only" : "candidate-only",
          baselinePassed: position < 100 ? true : null,
          candidatePassed: position < 100 ? null : true,
          costDeltaUsd: null,
          latencyDeltaMs: null,
        })),
      }).rows
    ).toHaveLength(200);
  });
});
