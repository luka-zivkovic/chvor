import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MemoryBlockDocumentV1, MemoryBlockRecord } from "@chvor/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  revisions: vi.fn(),
  update: vi.fn(),
  restore: vi.fn(),
  create: vi.fn(),
}));

const dashboardRender = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api", () => ({
  api: { memoryBlocks: apiMocks },
}));

vi.mock("../memory/MemoryInsightsDashboard", () => ({
  MemoryInsightsDashboard: () => {
    dashboardRender();
    return <div>Associative dashboard mounted</div>;
  },
}));

import { MemoryPanel } from "./MemoryPanel";

const timestamp = "2026-07-12T10:00:00.000Z";

function blockDocument(
  content: string,
  overrides: Partial<MemoryBlockDocumentV1> = {}
): MemoryBlockDocumentV1 {
  return {
    schemaVersion: 1,
    layer: "human",
    managedBy: "user",
    label: "Preferred response style",
    description: "A stable preference",
    content,
    characterBudget: { unit: "characters", limit: 1000 },
    declaredOrder: 5,
    readOnly: false,
    confidence: 0.75,
    provenance: { kind: "manual", sourceId: "profile" },
    verifiedAt: timestamp,
    ...overrides,
  } as MemoryBlockDocumentV1;
}

function record(
  revision: number,
  content = "Be concise.",
  overrides: Partial<MemoryBlockRecord> = {}
): MemoryBlockRecord {
  return {
    id: "block-1",
    revision,
    document: blockDocument(content),
    operation: revision === 1 ? "create" : "update",
    actor: { actorType: "user", actorId: "session-1" },
    restoredFromRevision: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(container: HTMLElement, label: string, index = 0): HTMLButtonElement {
  const matches = Array.from(container.querySelectorAll("button")).filter(
    (candidate) => candidate.textContent?.trim() === label
  );
  const match = matches[index];
  if (!match) throw new Error(`Button not found: ${label} at index ${index}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushEffects();
}

async function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  cursor?: number
) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    if (cursor !== undefined && "setSelectionRange" in element) {
      element.setSelectionRange(cursor, cursor);
    }
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })
    );
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("MemoryPanel stable beliefs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    dashboardRender.mockReset();
    apiMocks.list.mockResolvedValue({ records: [record(2)], nextCursor: null });
    apiMocks.get.mockResolvedValue(record(2));
    apiMocks.revisions.mockResolvedValue({ revisions: [record(2), record(1)], nextCursor: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("defaults to stable beliefs, exposes complete block metadata and pagination, and lazily mounts associative memory", async () => {
    const procedural = record(1, "Run required checks", {
      id: "block-2",
      document: blockDocument("Run required checks", {
        layer: "procedural",
        managedBy: "agent",
        label: "Run required checks",
        proceduralPriority: "required",
        verifiedAt: null,
        readOnly: true,
      } as Partial<MemoryBlockDocumentV1>),
      actor: { actorType: "agent", actorId: "agent-key-1" },
    });
    apiMocks.list
      .mockResolvedValueOnce({ records: [record(2)], nextCursor: "next-page" })
      .mockResolvedValueOnce({ records: [procedural], nextCursor: null });

    await act(async () => root.render(<MemoryPanel />));
    await flushEffects();

    expect(container.textContent).toContain("Stable beliefs");
    expect(container.textContent).toContain("Source / provenance");
    expect(container.textContent).toContain("Confidence: 0.75");
    expect(container.textContent).toContain("Verified: 2026-07-12T10:00:00.000Z");
    expect(container.textContent).toContain("Revision · 2");
    expect(container.textContent).toContain("Prevent agent changes · Off");
    expect(container.textContent).toContain("Layer · human");
    expect(container.textContent).toContain("Manager · user");
    expect(container.textContent).toContain("Actor: user · session-1");
    expect(dashboardRender).not.toHaveBeenCalled();

    const layerFilter = container.querySelector(
      '[aria-label="Filter by layer"]'
    ) as HTMLSelectElement;
    await setValue(layerFilter, "procedural");
    expect(container.textContent).toContain("No stable beliefs match these filters");
    expect(button(container, "Load more blocks")).toBeTruthy();

    await click(button(container, "Load more blocks"));
    expect(apiMocks.list).toHaveBeenLastCalledWith({ limit: 20, cursor: "next-page" });
    expect(container.textContent).toContain("Run required checks");
    expect(container.textContent).toContain("Never verified");
    expect(container.textContent).toContain("Actor: agent · agent-key-1");

    const filteredList = container.querySelector('[aria-label="Stable belief blocks"]');
    expect(filteredList?.textContent).not.toContain("Preferred response style");
    expect(filteredList?.textContent).toContain("Run required checks");

    await click(button(container, "Associative memory"));
    expect(container.textContent).toContain("Associative dashboard mounted");
    expect(dashboardRender).toHaveBeenCalledTimes(1);
  });

  it("preserves exact empty content, clears stale verification, and verifies without changing confidence or provenance", async () => {
    const initial = record(2, "Original content");
    apiMocks.list.mockResolvedValue({ records: [initial], nextCursor: null });
    apiMocks.get.mockResolvedValue(initial);
    apiMocks.update.mockImplementation(
      async (_id: string, body: { expectedRevision: number; document: MemoryBlockDocumentV1 }) =>
        record(body.expectedRevision + 1, body.document.content, { document: body.document })
    );

    await act(async () => root.render(<MemoryPanel />));
    await flushEffects();

    const content = container.querySelector('[aria-label="Block content"]') as HTMLTextAreaElement;
    await setValue(content, "");
    expect(button(container, "Verify now").disabled).toBe(true);
    expect(button(container, "Prevent agent changes").disabled).toBe(true);
    await click(button(container, "Save correction"));

    const correction = apiMocks.update.mock.calls[0][1];
    expect(correction.expectedRevision).toBe(2);
    expect(correction.document.content).toBe("");
    expect(correction.document.verifiedAt).toBeNull();
    expect(correction.document.confidence).toBe(0.75);
    expect(correction.document.provenance).toEqual({ kind: "manual", sourceId: "profile" });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:34:56.789Z"));
    const correctedContent = container.querySelector(
      '[aria-label="Block content"]'
    ) as HTMLTextAreaElement;
    await setValue(correctedContent, "  corrected exactly\n");
    await click(button(container, "Save and verify"));

    const saveAndVerify = apiMocks.update.mock.calls[1][1];
    expect(saveAndVerify.expectedRevision).toBe(3);
    expect(saveAndVerify.document.content).toBe("  corrected exactly\n");
    expect(saveAndVerify.document.verifiedAt).toBe("2026-07-12T12:34:56.789Z");

    vi.setSystemTime(new Date("2026-07-12T12:35:00.123Z"));
    await click(button(container, "Verify now"));

    const verification = apiMocks.update.mock.calls[2][1];
    expect(verification.expectedRevision).toBe(4);
    expect(verification.document.verifiedAt).toBe("2026-07-12T12:35:00.123Z");
    expect(verification.document.confidence).toBe(0.75);
    expect(verification.document.provenance).toEqual({ kind: "manual", sourceId: "profile" });

    await click(button(container, "Prevent agent changes"));
    const protectedSnapshot = apiMocks.update.mock.calls[3][1];
    expect(protectedSnapshot.expectedRevision).toBe(5);
    expect(protectedSnapshot.document.readOnly).toBe(true);
    expect(protectedSnapshot.document.confidence).toBe(0.75);
    expect(protectedSnapshot.document.provenance).toEqual({
      kind: "manual",
      sourceId: "profile",
    });

    await click(button(container, "Allow agent changes"));
    expect(apiMocks.update.mock.calls[4][1]).toMatchObject({
      expectedRevision: 6,
      document: { readOnly: false },
    });
  });

  it("preserves stored CRLF content when only metadata is corrected", async () => {
    const initial = record(2, "first\r\nsecond\r\n");
    apiMocks.list.mockResolvedValue({ records: [initial], nextCursor: null });
    apiMocks.get.mockResolvedValue(initial);
    apiMocks.update.mockImplementation(
      async (_id: string, body: { expectedRevision: number; document: MemoryBlockDocumentV1 }) =>
        record(3, body.document.content, { document: body.document })
    );

    await act(async () => root.render(<MemoryPanel />));
    await flushEffects();

    const label = container.querySelector('[aria-label="Block label"]') as HTMLInputElement;
    await setValue(label, "Updated label");
    await click(button(container, "Save correction"));

    expect(apiMocks.update.mock.calls[0][1].document.content).toBe("first\r\nsecond\r\n");
    expect(apiMocks.update.mock.calls[0][1].document.verifiedAt).toBe(timestamp);
  });

  it("preserves the stored CRLF style when content is corrected", async () => {
    const initial = record(2, "first\r\nsecond\r\n");
    apiMocks.list.mockResolvedValue({ records: [initial], nextCursor: null });
    apiMocks.get.mockResolvedValue(initial);
    apiMocks.update.mockImplementation(
      async (_id: string, body: { expectedRevision: number; document: MemoryBlockDocumentV1 }) =>
        record(3, body.document.content, { document: body.document })
    );

    await act(async () => root.render(<MemoryPanel />));
    await flushEffects();

    const content = container.querySelector('[aria-label="Block content"]') as HTMLTextAreaElement;
    await setValue(content, "first changed\nsecond\n");
    await click(button(container, "Save correction"));

    expect(apiMocks.update.mock.calls[0][1].document.content).toBe(
      "first changed\r\nsecond\r\n"
    );
  });

  it("keeps surviving mixed line endings attached to unchanged adjacent lines", async () => {
    const initial = record(2, "a\r\nb\nc");
    apiMocks.list.mockResolvedValue({ records: [initial], nextCursor: null });
    apiMocks.get.mockResolvedValue(initial);
    apiMocks.update.mockImplementation(
      async (_id: string, body: { expectedRevision: number; document: MemoryBlockDocumentV1 }) =>
        record(3, body.document.content, { document: body.document })
    );

    await act(async () => root.render(<MemoryPanel />));
    await flushEffects();
    const content = container.querySelector('[aria-label="Block content"]') as HTMLTextAreaElement;
    await setValue(content, "b\nc", 0);
    await click(button(container, "Save correction"));

    expect(apiMocks.update.mock.calls[0][1].document.content).toBe("b\nc");
  });

  it("preserves the edited occurrence when mixed-line content has duplicate lines", async () => {
    const initial = record(2, "a\r\nb\na\rb");
    apiMocks.list.mockResolvedValue({ records: [initial], nextCursor: null });
    apiMocks.get.mockResolvedValue(initial);
    apiMocks.update.mockImplementation(
      async (_id: string, body: { expectedRevision: number; document: MemoryBlockDocumentV1 }) =>
        record(3, body.document.content, { document: body.document })
    );

    await act(async () => root.render(<MemoryPanel />));
    await flushEffects();
    const content = container.querySelector('[aria-label="Block content"]') as HTMLTextAreaElement;
    await setValue(content, "a\nb", 0);
    await click(button(container, "Save correction"));

    expect(apiMocks.update.mock.calls[0][1].document.content).toBe("a\rb");
  });

  it("validates provenance and Unicode character budgets with the shared document schema", async () => {
    await act(async () => root.render(<MemoryPanel />));
    await flushEffects();

    const provenance = container.querySelector(
      '[aria-label="Provenance JSON"]'
    ) as HTMLTextAreaElement;
    await setValue(provenance, "[]");
    await click(button(container, "Save correction"));
    expect(container.textContent).toContain("provenance must be a bounded structured JSON object");
    expect(apiMocks.update).not.toHaveBeenCalled();

    await setValue(provenance, '{"kind":"manual"}');
    const content = container.querySelector('[aria-label="Block content"]') as HTMLTextAreaElement;
    const budget = container.querySelector('[aria-label="Character budget"]') as HTMLInputElement;
    await setValue(content, "😀😀");
    await setValue(budget, "1");
    await click(button(container, "Save correction"));
    expect(container.textContent).toContain("content exceeds its character budget");
    expect(container.textContent).toContain("2 Unicode characters");

    await setValue(content, "x".repeat(525_000));
    await setValue(budget, "600000");
    await click(button(container, "Save correction"));
    expect(container.textContent).toContain("Mutation request is");
    expect(container.textContent).toContain("the limit is 524288 bytes");
    expect(apiMocks.update).not.toHaveBeenCalled();
  });

  it("compares complete revisions and confirms restore and current-revision-minus-one undo", async () => {
    const current = record(3, "Current");
    const previous = record(2, "Previous");
    const original = record(1, "Original");
    apiMocks.list.mockResolvedValue({ records: [current], nextCursor: null });
    apiMocks.get.mockResolvedValue(current);
    apiMocks.revisions.mockResolvedValue({
      revisions: [current, previous, original],
      nextCursor: null,
    });
    apiMocks.restore
      .mockResolvedValueOnce(
        record(4, "Original", {
          document: original.document,
          operation: "restore",
          restoredFromRevision: 1,
        })
      )
      .mockResolvedValueOnce(
        record(5, "Current", {
          document: current.document,
          operation: "restore",
          restoredFromRevision: 3,
        })
      );

    await act(async () => root.render(<MemoryPanel />));
    await flushEffects();

    await click(button(container, "Compare full revision", 2));
    expect(container.textContent).toContain("Revision 1 vs current revision 3");
    expect(container.textContent).toContain("Selected full revision");
    expect(container.textContent).toContain("Current full revision");
    expect(container.textContent).toContain("Full snapshots are different");

    await click(button(container, "Restore", 1));
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    await click(button(container, "Confirm restore"));
    expect(apiMocks.restore).toHaveBeenNthCalledWith(1, "block-1", {
      expectedRevision: 3,
      restoredFromRevision: 1,
    });

    await click(button(container, "Undo previous revision"));
    expect(container.textContent).toContain("current revision minus one");
    await click(button(container, "Confirm undo"));
    expect(apiMocks.restore).toHaveBeenNthCalledWith(2, "block-1", {
      expectedRevision: 4,
      restoredFromRevision: 3,
    });
  });

  it("preserves a correction draft on 409, fetches latest head, and never retries automatically", async () => {
    const initial = record(2, "Original");
    const latest = record(3, "Changed elsewhere");
    apiMocks.list.mockResolvedValue({ records: [initial], nextCursor: null });
    apiMocks.get.mockResolvedValueOnce(initial).mockResolvedValueOnce(latest);
    apiMocks.update.mockRejectedValue(
      Object.assign(new Error("revision conflict"), {
        status: 409,
        expectedRevision: 2,
        actualRevision: 3,
      })
    );

    await act(async () => root.render(<MemoryPanel />));
    await flushEffects();

    const content = container.querySelector('[aria-label="Block content"]') as HTMLTextAreaElement;
    await setValue(content, "  preserved draft\n");
    await click(button(container, "Save correction"));

    expect(apiMocks.update).toHaveBeenCalledTimes(1);
    expect(apiMocks.get).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("A newer revision was saved elsewhere");
    expect(container.textContent).toContain("Expected revision 2; latest revision 3");
    expect(container.textContent).toContain("Nothing was retried");
    expect(container.textContent).toContain("Changed elsewhere");
    expect(
      (container.querySelector('[aria-label="Block content"]') as HTMLTextAreaElement).value
    ).toBe("  preserved draft\n");
    expect(button(container, "Save correction").disabled).toBe(true);

    await click(button(container, "I reviewed the latest head"));
    expect(
      (container.querySelector('[aria-label="Block content"]') as HTMLTextAreaElement).value
    ).toBe("  preserved draft\n");
    expect(button(container, "Save correction").disabled).toBe(false);
  });

  it("keeps a conflict locked until a failed head refresh is retried successfully", async () => {
    const initial = record(2, "Original");
    const latest = record(3, "Changed elsewhere");
    apiMocks.list.mockResolvedValue({ records: [initial], nextCursor: null });
    apiMocks.get
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(latest);
    apiMocks.update.mockRejectedValue(
      Object.assign(new Error("revision conflict"), {
        status: 409,
        expectedRevision: 2,
        actualRevision: 3,
      })
    );

    await act(async () => root.render(<MemoryPanel />));
    await flushEffects();
    const content = container.querySelector('[aria-label="Block content"]') as HTMLTextAreaElement;
    await setValue(content, "preserved draft");
    await click(button(container, "Save correction"));

    expect(container.textContent).toContain("canonical head could not be loaded");
    expect(container.textContent).not.toContain("I reviewed the latest head");
    expect(button(container, "Save correction").disabled).toBe(true);

    await click(button(container, "Retry latest head"));
    expect(container.textContent).toContain("The latest head is shown below");
    expect(container.textContent).toContain("Changed elsewhere");
    expect(
      (container.querySelector('[aria-label="Block content"]') as HTMLTextAreaElement).value
    ).toBe("preserved draft");
  });

  it("ignores stale history responses after selecting another block", async () => {
    const first = record(2, "First block");
    const second = record(4, "Second block", {
      id: "block-2",
      document: blockDocument("Second block", { label: "Second block" }),
    });
    const firstHistory = deferred<{ revisions: MemoryBlockRecord[]; nextCursor: null }>();
    apiMocks.list.mockResolvedValue({ records: [first, second], nextCursor: null });
    apiMocks.get.mockImplementation(async (id: string) => (id === first.id ? first : second));
    apiMocks.revisions.mockImplementation((id: string) =>
      id === first.id
        ? firstHistory.promise
        : Promise.resolve({ revisions: [second], nextCursor: null })
    );

    await act(async () => root.render(<MemoryPanel />));
    await flushEffects();
    const secondButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[aria-label="Stable belief blocks"] button')
    ).find((candidate) => candidate.textContent?.includes("Second block"));
    if (!secondButton) throw new Error("Second block was not rendered");
    await click(secondButton);
    expect(container.textContent).toContain("Revision 4 · update");

    await act(async () => {
      firstHistory.resolve({ revisions: [record(1, "Old first history")], nextCursor: null });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Revision 1 · create");
    expect(container.textContent).toContain("Second block");
  });
});
