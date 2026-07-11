import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationCaseDocumentV1 } from "@chvor/shared";
import type { TrajectoryDetail } from "../../lib/api";

const { createEvaluationCase, updateEvaluationCase, exportEvaluationCase, sourceFromTrajectory } =
  vi.hoisted(() => ({
    createEvaluationCase: vi.fn(),
    updateEvaluationCase: vi.fn(),
    exportEvaluationCase: vi.fn(),
    sourceFromTrajectory: vi.fn(),
  }));

vi.mock("../../lib/api", () => ({
  api: {
    evaluationCases: {
      create: createEvaluationCase,
      update: updateEvaluationCase,
      export: exportEvaluationCase,
      sourceFromTrajectory,
    },
  },
}));

import { SaveEvaluationCaseDialog } from "./SaveEvaluationCaseDialog";

const now = "2026-07-11T10:00:00.000Z";

function trajectory(status: TrajectoryDetail["status"] = "completed"): TrajectoryDetail {
  return {
    schemaVersion: 1,
    id: "trajectory-transient-id",
    origin: { kind: "web-chat", sessionId: "session-transient-id" },
    actor: { type: "user", id: "actor-transient-id" },
    status,
    title: "Captured evaluation",
    startedAt: now,
    input: { prompt: "deploy" },
    ...(status === "completed" ? { output: { result: "done" }, completedAt: now } : {}),
    modelUsage: [],
    artifacts: [],
    labels: [],
    attributes: {},
    steps: [
      {
        id: "step-1",
        trajectoryId: "trajectory-transient-id",
        sequence: 0,
        kind: "tool.call",
        status: "completed",
        startedAt: now,
        toolCall: {
          toolCallId: "call-transient-id",
          toolName: "zeta__tool",
          toolKind: "native",
          credentialRefs: [],
        },
        artifacts: [],
        attributes: {},
      },
      {
        id: "step-2",
        trajectoryId: "trajectory-transient-id",
        sequence: 1,
        kind: "tool.result",
        status: "completed",
        startedAt: now,
        toolCall: {
          toolCallId: "call-transient-id",
          toolName: "alpha__tool",
          toolKind: "native",
          credentialRefs: [],
        },
        artifacts: [],
        attributes: {},
      },
      {
        id: "step-3",
        trajectoryId: "trajectory-transient-id",
        sequence: 2,
        kind: "tool.result",
        status: "completed",
        startedAt: now,
        toolCall: {
          toolCallId: "call-transient-id",
          toolName: "zeta__tool",
          toolKind: "native",
          credentialRefs: [],
        },
        artifacts: [],
        attributes: {},
      },
    ],
  };
}

function record(revision: number, document: EvaluationCaseDocumentV1) {
  return {
    id: "case-local-id",
    revision,
    document,
    createdAt: now,
    updatedAt: now,
  };
}

function setControlValue(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : control instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event("change", { bubbles: true }));
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SaveEvaluationCaseDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    createEvaluationCase.mockReset();
    updateEvaluationCase.mockReset();
    exportEvaluationCase.mockReset();
    sourceFromTrajectory.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("captures a redacted, normalized portable payload without transient IDs", async () => {
    createEvaluationCase.mockImplementation(
      async ({ document }: { document: EvaluationCaseDocumentV1 }) => record(1, document)
    );
    await act(async () =>
      root.render(<SaveEvaluationCaseDialog trajectory={trajectory()} onClose={() => {}} />)
    );

    expect(
      (container.querySelector('[aria-label="Required tools"]') as HTMLInputElement).value
    ).toBe("alpha__tool, zeta__tool");
    await act(async () => {
      setControlValue(
        container.querySelector('[aria-label="Input JSON"]') as HTMLTextAreaElement,
        '{"password":"top-secret","safe":"yes"}'
      );
      setControlValue(
        container.querySelector('[aria-label="Output contains"]') as HTMLTextAreaElement,
        "z result\nhello, world\na result\nz result"
      );
      setControlValue(
        container.querySelector('[aria-label="Required tools"]') as HTMLInputElement,
        "zeta__tool, alpha__tool, zeta__tool"
      );
      setControlValue(
        container.querySelector('[aria-label="Forbidden tools"]') as HTMLInputElement,
        "write__z, write__a, write__z"
      );
      const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      checkboxes[2].click();
    });
    const create = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create evaluation"
    )!;
    await act(async () => create.click());
    await flushEffects();

    const payload = createEvaluationCase.mock.calls[0][0];
    expect(payload).toEqual({
      document: {
        schemaVersion: 1,
        name: "Captured evaluation",
        input: { password: "[REDACTED]", safe: "yes" },
        expected: {
          status: "completed",
          output: { result: "done" },
          outputContains: ["a result", "hello, world", "z result"],
        },
        requiredTools: ["alpha__tool", "zeta__tool"],
        forbiddenTools: ["write__a", "write__z"],
        safetyAssertions: ["no-secrets-in-output", "require-approval-for-required-tools"],
      },
    });
    expect(JSON.stringify(payload)).not.toContain("transient-id");
  });

  it("updates with the saved revision and downloads the canonical export", async () => {
    createEvaluationCase.mockImplementation(
      async ({ document }: { document: EvaluationCaseDocumentV1 }) => record(1, document)
    );
    updateEvaluationCase.mockImplementation(
      async (_id: string, { document }: { document: EvaluationCaseDocumentV1 }) =>
        record(2, document)
    );
    exportEvaluationCase.mockResolvedValue('{"schemaVersion":1}\n');
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn().mockReturnValue("blob:evaluation"),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await act(async () =>
      root.render(<SaveEvaluationCaseDialog trajectory={trajectory()} onClose={() => {}} />)
    );
    const create = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create evaluation"
    )!;
    await act(async () => create.click());
    await flushEffects();

    await act(async () => {
      setControlValue(
        container.querySelector('input:not([type="checkbox"])') as HTMLInputElement,
        "Updated evaluation"
      );
    });
    const update = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Update evaluation"
    )!;
    await act(async () => update.click());
    await flushEffects();
    expect(updateEvaluationCase).toHaveBeenCalledWith(
      "case-local-id",
      expect.objectContaining({ expectedRevision: 1 })
    );

    const exportButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Export JSON"
    )!;
    await act(async () => exportButton.click());
    await flushEffects();
    expect(exportEvaluationCase).toHaveBeenCalledWith("case-local-id");
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Saved revision 2.");
  });

  it("shows expected-field and JSON validation, then visibly reflects redaction", async () => {
    createEvaluationCase.mockImplementation(
      async ({ document }: { document: EvaluationCaseDocumentV1 }) => record(1, document)
    );
    await act(async () =>
      root.render(
        <SaveEvaluationCaseDialog trajectory={trajectory("running")} onClose={() => {}} />
      )
    );
    const create = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create evaluation"
    )!;

    await act(async () => create.click());
    expect(container.textContent).toContain(
      "Choose an expected status, output, or output substring."
    );

    await act(async () => {
      setControlValue(
        container.querySelector('[aria-label="Expected terminal status"]') as HTMLSelectElement,
        "completed"
      );
      setControlValue(
        container.querySelector('[aria-label="Input JSON"]') as HTMLTextAreaElement,
        "{"
      );
    });
    await act(async () => create.click());
    expect(container.textContent).toContain("Input must be valid JSON.");

    await act(async () => {
      setControlValue(
        container.querySelector('[aria-label="Input JSON"]') as HTMLTextAreaElement,
        '{"apiKey":"sk-super-secret-value"}'
      );
    });
    await act(async () => create.click());
    await flushEffects();
    const input = container.querySelector('[aria-label="Input JSON"]') as HTMLTextAreaElement;
    expect(input.value).toContain("[REDACTED]");
    expect(input.value).not.toContain("sk-super-secret-value");
    expect(container.textContent).toContain("Sensitive values are shown as [REDACTED].");
    expect(container.textContent).toContain("Redacted values remain visibly marked as [REDACTED].");
  });

  it("loads complete payloads instead of saving bounded inspector previews", async () => {
    sourceFromTrajectory.mockResolvedValue({
      input: { prompt: "complete input" },
      output: { result: "complete output" },
      outputOmitted: false,
    });
    createEvaluationCase.mockImplementation(
      async ({ document }: { document: EvaluationCaseDocumentV1 }) => record(1, document)
    );
    const truncated = {
      ...trajectory(),
      input: { preview: '{"prompt":"partial', truncated: true as const, originalBytes: 30_000 },
      output: { preview: '{"result":"partial', truncated: true as const, originalBytes: 40_000 },
      payloadTruncation: { input: true, output: true },
    };
    await act(async () =>
      root.render(<SaveEvaluationCaseDialog trajectory={truncated} onClose={() => {}} />)
    );
    await flushEffects();

    expect(
      (container.querySelector('[aria-label="Input JSON"]') as HTMLTextAreaElement).value
    ).toContain("complete input");
    expect(
      (container.querySelector('[aria-label="Expected output JSON"]') as HTMLTextAreaElement).value
    ).toContain("complete output");
    expect(sourceFromTrajectory).toHaveBeenCalledWith("trajectory-transient-id");

    const create = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create evaluation"
    )!;
    await act(async () => create.click());
    await flushEffects();
    expect(createEvaluationCase).toHaveBeenCalledWith({
      document: expect.objectContaining({
        input: { prompt: "complete input" },
        expected: expect.objectContaining({ output: { result: "complete output" } }),
      }),
    });
    expect(JSON.stringify(createEvaluationCase.mock.calls[0][0])).not.toContain("partial");
  });
});
