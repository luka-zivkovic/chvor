import { describe, expect, it } from "vitest";
import { parseEvaluationCaseDocument } from "@chvor/shared";
import { evaluationMessages, UnsupportedEvaluationInputError } from "../evaluation-input.ts";

function document(input: unknown) {
  return parseEvaluationCaseDocument({
    schemaVersion: 1,
    name: "input",
    input,
    expected: { status: "completed", outputContains: [] },
    requiredTools: [],
    forbiddenTools: [],
    safetyAssertions: [],
  });
}

describe("evaluationMessages", () => {
  it("supports strings, prompt objects, and captured messages", () => {
    expect(evaluationMessages(document("hello"))).toEqual([{ role: "user", content: "hello" }]);
    expect(evaluationMessages(document({ prompt: "hello" }))).toEqual([
      { role: "user", content: "hello" },
    ]);
    expect(
      evaluationMessages(document({ messages: [{ role: "user", content: "hello" }] }))
    ).toEqual([{ role: "user", content: "hello" }]);
  });

  it("rejects ambiguous JSON before model invocation", () => {
    expect(() => evaluationMessages(document({ task: 42 }))).toThrow(
      UnsupportedEvaluationInputError
    );
  });

  it("preserves complete valid inputs instead of silently truncating them", () => {
    const input = "x".repeat(64_001);
    expect(evaluationMessages(document(input))).toEqual([{ role: "user", content: input }]);
    expect(evaluationMessages(document({ prompt: input }))).toEqual([
      { role: "user", content: input },
    ]);
    expect(evaluationMessages(document([{ role: "user", content: input }]))).toEqual([
      { role: "user", content: input },
    ]);
  });
});
