import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrajectoryDetail } from "../../lib/api";
import { PayloadBlock, TrajectoryInspector } from "./TrajectoryInspector";

function trajectory(status: TrajectoryDetail["status"]): TrajectoryDetail {
  return {
    schemaVersion: 1,
    id: `run-${status}`,
    origin: { kind: "test" },
    actor: { type: "test", id: null },
    status,
    startedAt: "2026-07-11T10:00:00.000Z",
    modelUsage: [],
    steps: [],
    artifacts: [],
    labels: [],
    attributes: {},
    ...(status === "failed"
      ? {
          completedAt: "2026-07-11T10:00:01.000Z",
          error: {
            code: "EXECUTION_FAILED",
            category: "runtime",
            message: "failure details",
            retryable: false,
          },
        }
      : {}),
  };
}

describe("TrajectoryInspector states", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("distinguishes partial, aborted, and failed executions", async () => {
    await act(async () => root.render(<TrajectoryInspector trajectory={trajectory("waiting")} />));
    expect(container.textContent).toContain("partial and may receive more steps");
    expect(container.textContent).toContain("waiting");

    await act(async () => root.render(<TrajectoryInspector trajectory={trajectory("aborted")} />));
    expect(container.textContent).toContain("aborted");
    expect(container.textContent).not.toContain("partial and may receive more steps");

    await act(async () => root.render(<TrajectoryInspector trajectory={trajectory("failed")} />));
    expect(container.textContent).toContain("failed");
    expect(container.textContent).toContain("EXECUTION_FAILED · failure details");
  });

  it("renders preview-shaped payload objects without hiding their envelope fields", async () => {
    await act(async () =>
      root.render(
        <PayloadBlock
          label="input"
          value={{ truncated: true, preview: "result", originalBytes: 100 }}
        />
      )
    );

    expect(container.textContent).toContain('"truncated": true');
    expect(container.textContent).toContain('"preview": "result"');
    expect(container.textContent).toContain('"originalBytes": 100');
  });

  it("opens evaluation capture from the trajectory header", async () => {
    await act(async () =>
      root.render(<TrajectoryInspector trajectory={trajectory("completed")} />)
    );
    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save as evaluation"
    );
    await act(async () => save!.click());

    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain("Portable data excludes trajectory IDs");
  });
});
