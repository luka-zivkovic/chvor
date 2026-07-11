import { describe, expect, it, vi } from "vitest";
import { evaluationRunConfigurationSchema, parseEvaluationCaseDocument } from "@chvor/shared";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText,
}));

const { runEvaluationSidecar } = await import("../sidecar-engine.ts");
const hash = "a".repeat(64);

describe("isolated evaluation sidecar", () => {
  it("executes only deterministic stubs, records approvals, cost, and raw secret findings", async () => {
    generateText.mockImplementationOnce(
      async (options: {
        tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>;
      }) => {
        await options.tools.read.execute({ query: "api_key=raw" });
        await options.tools.write.execute({ path: "/production" });
        return {
          text: "answer authorization=Bearer raw-token",
          usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
          finishReason: "stop",
        };
      }
    );
    const configuration = evaluationRunConfigurationSchema.parse({
      engineId: "chvor-isolated-v1",
      providerId: "openai",
      modelId: "test",
      prompt: "prompt",
      promptHash: hash,
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      tools: [
        { name: "read", effect: "read", approval: "auto-approve", result: { fixture: true } },
        { name: "write", effect: "write", approval: "auto-deny", result: { shouldNotRun: true } },
      ],
    });
    const response = await runEvaluationSidecar(
      {
        configuration,
        credential: { apiKey: "credential-only-in-memory" },
        cases: [
          {
            caseId: "case",
            revision: 1,
            documentHash: hash,
            critical: true,
            document: parseEvaluationCaseDocument({
              schemaVersion: 1,
              name: "case",
              input: "hello",
              expected: { status: "completed", outputContains: [] },
              requiredTools: [],
              forbiddenTools: [],
              safetyAssertions: [],
            }),
          },
        ],
      },
      () => ({}) as never
    );
    expect(response.cases[0].secretDetected).toBe(true);
    expect(response.cases[0].observation.output).toContain("[REDACTED]");
    expect(response.cases[0].observation.costUsd).toBe(0.000008);
    expect(response.cases[0].observation.toolCalls).toEqual([
      { name: "read", approvalRequested: true, approved: true, executed: true },
      { name: "write", approvalRequested: true, approved: false, executed: false },
    ]);
    expect(JSON.stringify(response)).not.toContain("credential-only-in-memory");
  });

  it("does not report blocked or unfinished provider outcomes as completed", async () => {
    generateText
      .mockResolvedValueOnce({
        text: "blocked partial response",
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        finishReason: "content-filter",
      })
      .mockResolvedValueOnce({
        text: "partial response before another tool round",
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        finishReason: "tool-calls",
      });
    const configuration = evaluationRunConfigurationSchema.parse({
      engineId: "chvor-isolated-v1",
      providerId: "openai",
      modelId: "test",
      prompt: "prompt",
      promptHash: hash,
      tools: [],
    });
    const request = {
      configuration,
      credential: { apiKey: "credential-only-in-memory" },
      cases: [
        {
          caseId: "case",
          revision: 1,
          documentHash: hash,
          critical: true,
          document: parseEvaluationCaseDocument({
            schemaVersion: 1,
            name: "case",
            input: "hello",
            expected: { status: "completed", outputContains: [] },
            requiredTools: [],
            forbiddenTools: [],
            safetyAssertions: [],
          }),
        },
      ],
    };

    const blocked = await runEvaluationSidecar(request, () => ({}) as never);
    expect(blocked.cases[0].observation).toMatchObject({
      status: "failed",
      error: "model finished with content-filter",
    });
    const unfinished = await runEvaluationSidecar(request, () => ({}) as never);
    expect(unfinished.cases[0].observation).toMatchObject({
      status: "round-limited",
      error: null,
    });
  });

  it("scrubs the exact provider credential even when it has no recognizable key shape", async () => {
    const apiKey = "opaque credential with spaces";
    generateText
      .mockResolvedValueOnce({
        text: `provider echoed ${apiKey}`,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      })
      .mockRejectedValueOnce(new Error(`provider rejected ${apiKey}`));
    const configuration = evaluationRunConfigurationSchema.parse({
      engineId: "chvor-isolated-v1",
      providerId: "openai",
      modelId: "test",
      prompt: "prompt",
      promptHash: hash,
      tools: [],
    });
    const response = await runEvaluationSidecar(
      {
        configuration,
        credential: { apiKey },
        cases: [
          {
            caseId: "case",
            revision: 1,
            documentHash: hash,
            critical: true,
            document: parseEvaluationCaseDocument({
              schemaVersion: 1,
              name: "case",
              input: "hello",
              expected: { status: "completed", outputContains: [] },
              requiredTools: [],
              forbiddenTools: [],
              safetyAssertions: [],
            }),
          },
        ],
      },
      () => ({}) as never
    );
    expect(response.cases[0].secretDetected).toBe(true);
    expect(JSON.stringify(response)).not.toContain(apiKey);
    expect(response.cases[0].observation.output).toContain("[REDACTED]");
    const failed = await runEvaluationSidecar(
      {
        configuration,
        credential: { apiKey },
        cases: response.cases.map(() => ({
          caseId: "case",
          revision: 1,
          documentHash: hash,
          critical: true,
          document: parseEvaluationCaseDocument({
            schemaVersion: 1,
            name: "case",
            input: "hello",
            expected: { status: "completed", outputContains: [] },
            requiredTools: [],
            forbiddenTools: [],
            safetyAssertions: [],
          }),
        })),
      },
      () => ({}) as never
    );
    expect(JSON.stringify(failed)).not.toContain(apiKey);
    expect(failed.cases[0].observation.error).toContain("[REDACTED]");
  });

  it.each(["ollama", "lmstudio", "vllm"] as const)(
    "does not scrub or flag the %s provider-id placeholder",
    async (providerId) => {
      generateText.mockImplementationOnce(
        async (options: {
          tools: Record<string, { execute: (args: unknown) => Promise<unknown> }>;
        }) => {
          await options.tools.inspect.execute({ provider: providerId });
          return {
            text: `using ${providerId} locally`,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            finishReason: "stop",
          };
        }
      );
      const configuration = evaluationRunConfigurationSchema.parse({
        engineId: "chvor-isolated-v1",
        providerId,
        modelId: "test",
        prompt: "prompt",
        promptHash: hash,
        tools: [
          {
            name: "inspect",
            effect: "read",
            approval: "auto-approve",
            result: { provider: providerId },
          },
        ],
      });
      const response = await runEvaluationSidecar(
        {
          configuration,
          credential: { apiKey: providerId },
          cases: [
            {
              caseId: "case",
              revision: 1,
              documentHash: hash,
              critical: true,
              document: parseEvaluationCaseDocument({
                schemaVersion: 1,
                name: "case",
                input: "hello",
                expected: { status: "completed", outputContains: [] },
                requiredTools: [],
                forbiddenTools: [],
                safetyAssertions: [],
              }),
            },
          ],
        },
        () => ({}) as never
      );

      expect(response.cases[0].secretDetected).toBe(false);
      expect(response.cases[0].observation.output).toBe(`using ${providerId} locally`);
      expect(response.cases[0].observation.output).not.toContain("[REDACTED]");
    }
  );

  it("still scrubs and detects a genuine local-provider API key", async () => {
    const apiKey = "opaque local access phrase";
    generateText.mockResolvedValueOnce({
      text: `provider echoed ${apiKey}`,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });
    const configuration = evaluationRunConfigurationSchema.parse({
      engineId: "chvor-isolated-v1",
      providerId: "ollama",
      modelId: "test",
      prompt: "prompt",
      promptHash: hash,
      tools: [],
    });
    const response = await runEvaluationSidecar(
      {
        configuration,
        credential: { apiKey },
        cases: [
          {
            caseId: "case",
            revision: 1,
            documentHash: hash,
            critical: true,
            document: parseEvaluationCaseDocument({
              schemaVersion: 1,
              name: "case",
              input: "hello",
              expected: { status: "completed", outputContains: [] },
              requiredTools: [],
              forbiddenTools: [],
              safetyAssertions: [],
            }),
          },
        ],
      },
      () => ({}) as never
    );

    expect(response.cases[0].secretDetected).toBe(true);
    expect(response.cases[0].observation.output).toBe("provider echoed [REDACTED]");
    expect(JSON.stringify(response)).not.toContain(apiKey);
  });
});
