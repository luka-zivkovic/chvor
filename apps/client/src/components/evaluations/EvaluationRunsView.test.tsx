import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listRuns, getRun, listCases } = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  listCases: vi.fn(),
}));
vi.mock("../../lib/api", () => ({
  api: {
    evaluationRuns: { list: listRuns, get: getRun, create: vi.fn(), compare: vi.fn() },
    evaluationCases: { list: listCases },
  },
}));

import { evaluationToolStub, EvaluationRunsView } from "./EvaluationRunsView";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  listCases.mockResolvedValue({ records: [], nextCursor: null });
  listRuns.mockResolvedValue({ runs: [], nextCursor: null });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("EvaluationRunsView", () => {
  it("uses explicit, conservative simulated tool effects", () => {
    expect(evaluationToolStub("native__pc_do")).toMatchObject({
      effect: "write",
      approval: "auto-deny",
    });
    expect(evaluationToolStub("native__pc_do", "read")).toMatchObject({
      effect: "read",
      approval: "auto-approve",
    });
  });

  it("renders the empty state", async () => {
    await act(async () => root.render(<EvaluationRunsView />));
    await act(async () => undefined);
    expect(container.textContent).toContain("No evaluation reports");
    expect(container.textContent).toContain("Run dataset");
  });

  it("renders immutable report assertions and redacted output", async () => {
    listRuns.mockResolvedValue({
      runs: [
        {
          id: "run-1",
          engine: "chvor-isolated-v1",
          provider: "openai",
          model: "test",
          status: "completed",
          passed: true,
          completedAt: "2026-07-11T00:00:00.000Z",
          caseCount: 1,
          passedCaseCount: 1,
          failedCaseCount: 0,
          costUsd: null,
          totalLatencyMs: 10,
        },
      ],
      nextCursor: null,
    });
    getRun.mockResolvedValue({
      id: "run-1",
      configuration: { providerId: "openai", modelId: "test" },
      configurationHash: "a".repeat(64),
      passed: true,
      summary: { passed: 1, total: 1, totalCostUsd: null, totalLatencyMs: 10 },
      cases: [
        {
          position: 0,
          passed: true,
          snapshot: { document: { name: "redacted case" } },
          observation: { output: "token [REDACTED]" },
          assertions: [{ kind: "no-secrets", status: "passed", message: "safe" }],
        },
      ],
    });
    await act(async () => root.render(<EvaluationRunsView />));
    await act(async () => undefined);
    expect(container.textContent).toContain("redacted case");
    expect(container.textContent).toContain("[REDACTED]");
    expect(container.textContent).toContain("no-secrets");
  });
});
