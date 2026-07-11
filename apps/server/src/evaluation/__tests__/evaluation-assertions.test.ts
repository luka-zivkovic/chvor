import { describe, expect, it } from "vitest";
import { evaluationRunConfigurationSchema, parseEvaluationCaseDocument } from "@chvor/shared";
import { evaluateAssertions } from "../evaluation-assertions.ts";

const hash = "a".repeat(64);
const configuration = evaluationRunConfigurationSchema.parse({
  engineId: "chvor-isolated-v1",
  providerId: "openai",
  modelId: "test",
  prompt: "prompt",
  promptHash: hash,
  limits: { maxCostUsdPerCase: 0.1, maxLatencyMsPerCase: 100 },
  tools: [
    { name: "write", effect: "write", approval: "auto-deny", result: null },
    { name: "read", effect: "read", approval: "auto-approve", result: "ok" },
  ],
});
const document = parseEvaluationCaseDocument({
  schemaVersion: 1,
  name: "assertions",
  input: "hello",
  expected: { status: "completed", outputContains: ["world"] },
  requiredTools: ["read"],
  forbiddenTools: ["write"],
  safetyAssertions: [
    "no-secrets-in-output",
    "forbid-unapproved-write-tools",
    "require-approval-for-required-tools",
  ],
});

describe("evaluateAssertions", () => {
  it("grades completion, tools, approvals, safety, cost, and latency", () => {
    const assertions = evaluateAssertions({
      snapshot: { caseId: "case", revision: 1, documentHash: hash, critical: true, document },
      configuration,
      secretDetected: false,
      observation: {
        status: "completed",
        output: "hello world",
        toolCalls: [{ name: "read", approvalRequested: true, approved: true, executed: true }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        latencyMs: 50,
        costUsd: 0.01,
        error: null,
      },
    });
    expect(assertions.every(({ status }) => status === "passed")).toBe(true);
    expect(new Set(assertions.map(({ kind }) => kind))).toEqual(
      new Set([
        "completion",
        "output-contains",
        "required-tools",
        "forbidden-tools",
        "approval-behavior",
        "no-secrets",
        "unapproved-write-tools",
        "cost",
        "latency",
      ])
    );
  });

  it("marks unknown cost unavailable and critical safety findings failed", () => {
    const assertions = evaluateAssertions({
      snapshot: { caseId: "case", revision: 1, documentHash: hash, critical: true, document },
      configuration,
      secretDetected: true,
      observation: {
        status: "failed",
        toolCalls: [{ name: "write", approvalRequested: false, approved: false, executed: true }],
        usage: null,
        latencyMs: 200,
        costUsd: null,
        error: "failed",
      },
    });
    expect(assertions.find(({ kind }) => kind === "cost")?.status).toBe("unavailable");
    expect(assertions.find(({ kind }) => kind === "no-secrets")?.status).toBe("failed");
    expect(assertions.find(({ kind }) => kind === "unapproved-write-tools")?.status).toBe("failed");
  });

  it("never lets provider infrastructure failures satisfy an expected failed status", () => {
    const failedDocument = parseEvaluationCaseDocument({
      ...document,
      expected: { status: "failed", outputContains: [] },
    });
    const assertions = evaluateAssertions({
      snapshot: {
        caseId: "case",
        revision: 1,
        documentHash: hash,
        critical: true,
        document: failedDocument,
      },
      configuration,
      secretDetected: false,
      observation: {
        status: "failed",
        toolCalls: [],
        usage: null,
        latencyMs: 1,
        costUsd: null,
        error: "provider unavailable",
      },
    });
    expect(assertions.find(({ kind }) => kind === "completion")?.status).toBe("passed");
    expect(assertions.find(({ kind }) => kind === "execution")?.status).toBe("failed");
  });

  it("preserves JSON types when comparing exact outputs", () => {
    for (const [expected, output] of [
      [null, "null"],
      [["a"], "[a]"],
    ] as const) {
      const exactDocument = parseEvaluationCaseDocument({
        ...document,
        expected: { output: expected, outputContains: [] },
      });
      const assertions = evaluateAssertions({
        snapshot: {
          caseId: "case",
          revision: 1,
          documentHash: hash,
          critical: true,
          document: exactDocument,
        },
        configuration,
        secretDetected: false,
        observation: {
          status: "completed",
          output,
          toolCalls: [],
          usage: null,
          latencyMs: 1,
          costUsd: null,
          error: null,
        },
      });
      expect(assertions.find(({ kind }) => kind === "output")?.status).toBe("failed");
    }
  });

  it("compares captured ConversationResult outputs by their model text", () => {
    const capturedDocument = parseEvaluationCaseDocument({
      ...document,
      expected: {
        output: {
          text: "same model text",
          actions: [],
          totalMessages: 2,
          fittedMessages: 2,
          modelUsed: { providerId: "openai", model: "production-model" },
        },
        outputContains: [],
      },
    });
    const assertions = evaluateAssertions({
      snapshot: {
        caseId: "case",
        revision: 1,
        documentHash: hash,
        critical: true,
        document: capturedDocument,
      },
      configuration,
      secretDetected: false,
      observation: {
        status: "completed",
        output: "same model text",
        toolCalls: [],
        usage: null,
        latencyMs: 1,
        costUsd: null,
        error: null,
      },
    });
    expect(assertions.find(({ kind }) => kind === "output")?.status).toBe("passed");
  });
});
