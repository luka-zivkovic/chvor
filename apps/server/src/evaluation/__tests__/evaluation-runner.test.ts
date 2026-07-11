import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrent = vi.fn();
const getRevision = vi.fn();
vi.mock("../../db/evaluation-case-store.ts", () => ({
  getEvaluationCase: getCurrent,
  getEvaluationCaseRevision: getRevision,
}));

const { runEvaluation } = await import("../evaluation-runner.ts");

const document = {
  schemaVersion: 1 as const,
  name: "runner case",
  input: "hello",
  expected: { status: "completed" as const, outputContains: ["world"] },
  requiredTools: [],
  forbiddenTools: [],
  safetyAssertions: [] as const,
};

describe("runEvaluation", () => {
  beforeEach(() => {
    getCurrent.mockReset();
    getRevision.mockReset();
    getCurrent.mockReturnValue({
      id: "case-1",
      revision: 2,
      document,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    });
  });

  it("snapshots cases/configuration and never persists credentials", async () => {
    const invoke = vi.fn().mockResolvedValue({
      cases: [
        {
          secretDetected: false,
          observation: {
            status: "completed",
            output: "hello world",
            toolCalls: [],
            usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
            latencyMs: 10,
            costUsd: 0.000008,
            error: null,
          },
        },
      ],
    });
    const times = [new Date("2026-07-11T00:00:00.000Z"), new Date("2026-07-11T00:00:01.000Z")];
    const report = await runEvaluation(
      {
        cases: [{ id: "case-1" }],
        configuration: {
          engineId: "chvor-isolated-v1",
          providerId: "openai",
          modelId: "test",
          prompt: "be helpful",
          pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          tools: [],
        },
      },
      undefined,
      {
        now: () => times.shift()!,
        id: () => "run-1",
        credential: () => ({ apiKey: "raw-secret" }),
        invoke,
      }
    );
    expect(report.passed).toBe(true);
    expect(report.cases[0].snapshot.revision).toBe(2);
    expect(report.environment.chvorVersion).toBe("0.0.1");
    expect(JSON.stringify(report)).not.toContain("raw-secret");
    expect(invoke.mock.calls[0][0].credential.apiKey).toBe("raw-secret");
  });

  it("rejects unsupported stored input before credential or sidecar access", async () => {
    getCurrent.mockReturnValue({
      id: "case-1",
      revision: 2,
      document: { ...document, input: { arbitrary: true } },
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    });
    const credential = vi.fn();
    const invoke = vi.fn();
    await expect(
      runEvaluation(
        {
          cases: [{ id: "case-1" }],
          configuration: {
            engineId: "chvor-isolated-v1",
            providerId: "openai",
            modelId: "test",
            prompt: "prompt",
            tools: [],
          },
        },
        undefined,
        { now: () => new Date(), id: () => "run", credential, invoke }
      )
    ).rejects.toThrow("evaluation input must be");
    expect(credential).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("deduplicates current and explicit selections after revision resolution", async () => {
    getRevision.mockReturnValue(getCurrent());
    await expect(
      runEvaluation(
        {
          cases: [{ id: "case-1" }, { id: "case-1", revision: 2 }],
          configuration: {
            engineId: "chvor-isolated-v1",
            providerId: "openai",
            modelId: "test",
            prompt: "prompt",
            tools: [],
          },
        },
        undefined,
        { now: () => new Date(), id: () => "run", credential: vi.fn(), invoke: vi.fn() }
      )
    ).rejects.toThrow("selected more than once");
  });

  it("rejects opaque provider credentials embedded anywhere in configuration", async () => {
    const invoke = vi.fn();
    await expect(
      runEvaluation(
        {
          cases: [{ id: "case-1" }],
          configuration: {
            engineId: "chvor-isolated-v1",
            providerId: "openai",
            modelId: "test",
            prompt: "never persist opaque-provider-credential",
            tools: [],
          },
        },
        undefined,
        {
          now: () => new Date(),
          id: () => "run",
          credential: () => ({
            apiKey: "opaque-provider-credential",
          }),
          invoke,
        }
      )
    ).rejects.toThrow("must not contain the selected provider credential");
    expect(invoke).not.toHaveBeenCalled();
  });
});
