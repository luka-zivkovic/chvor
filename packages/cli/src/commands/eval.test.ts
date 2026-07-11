import { describe, expect, it, vi } from "vitest";
import { compareEvaluationCommand, runEvaluationCommand, type EvalIo } from "./eval.js";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function io() {
  const output: string[] = [];
  const errors: string[] = [];
  const value: EvalIo = {
    out: (entry) => output.push(entry),
    error: (entry) => errors.push(entry),
    readFile: () => "{}",
  };
  return { value, output, errors };
}

describe("evaluation CLI", () => {
  it("returns 0/1 for completed gates and writes JSON to stdout", async () => {
    for (const passed of [true, false]) {
      const fetch = vi.fn().mockResolvedValue(
        response({
          report: {
            id: "run",
            passed,
            status: "completed",
            summary: {
              total: 1,
              passed: Number(passed),
              failed: Number(!passed),
              criticalFailed: Number(!passed),
              totalCostUsd: null,
              totalLatencyMs: 1,
            },
            cases: [{ snapshot: { document: { name: "case" } }, passed, assertions: [] }],
          },
        })
      );
      const sink = io();
      expect(
        await runEvaluationCommand(
          [],
          {
            cases: ["case-1"],
            provider: "openai",
            model: "test",
            prompt: "prompt",
            json: true,
            fetch,
          },
          sink.value
        )
      ).toBe(passed ? 0 : 1);
      expect(sink.output[0]).toContain('"id":"run"');
    }
  });

  it("returns 2 for transport/config failures and 1 for regressions", async () => {
    const failed = io();
    expect(
      await runEvaluationCommand(
        [],
        {
          cases: [],
          provider: "openai",
          model: "test",
          prompt: "prompt",
          fetch: vi.fn(),
        },
        failed.value
      )
    ).toBe(2);
    expect(failed.errors[0]).toContain("at least one");

    const compared = io();
    const fetch = vi.fn().mockResolvedValue(
      response({
        regressions: 1,
        improvements: 0,
        rows: [
          { caseName: "case", classification: "regression", costDeltaUsd: null, latencyDeltaMs: 1 },
        ],
      })
    );
    expect(await compareEvaluationCommand("a", "b", { fetch }, compared.value)).toBe(1);
  });

  it("requires pricing for cost gates and consumes every comparison page", async () => {
    const invalid = io();
    expect(
      await runEvaluationCommand(
        [],
        {
          cases: ["case"],
          provider: "openai",
          model: "test",
          prompt: "prompt",
          maxCost: "1",
          fetch: vi.fn(),
        },
        invalid.value
      )
    ).toBe(2);
    expect(invalid.errors[0]).toContain("requires --input-price");

    const paged = io();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          regressions: 1,
          improvements: 0,
          rows: [{ caseName: "first", classification: "regression" }],
          nextCursor: "next",
        })
      )
      .mockResolvedValueOnce(
        response({
          regressions: 1,
          improvements: 0,
          rows: [{ caseName: "second", classification: "unchanged-passed" }],
          nextCursor: null,
        })
      );
    expect(await compareEvaluationCommand("a", "b", { fetch }, paged.value)).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(paged.output.join("\n")).toContain("second");
  });
});
