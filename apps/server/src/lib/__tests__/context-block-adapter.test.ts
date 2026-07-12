import { describe, expect, it } from "vitest";
import type { MemoryBlockRecord } from "@chvor/shared";
import {
  mapMemoryBlocksToContextCandidates,
  mapMemoryBlockToContextCandidate,
} from "../orchestrator/context-block-adapter.ts";

function record(
  layer: "identity" | "human" | "procedural",
  overrides: Partial<MemoryBlockRecord["document"]> = {}
): MemoryBlockRecord {
  const document = {
    schemaVersion: 1 as const,
    layer,
    managedBy: layer === "procedural" ? ("agent" as const) : ("user" as const),
    label: "PRIVATE LABEL",
    description: "PRIVATE DESCRIPTION",
    content: `${layer} model content`,
    characterBudget: { unit: "characters" as const, limit: 200 },
    declaredOrder: 4,
    readOnly: false,
    confidence: 0.8,
    provenance: { private: "PRIVATE PROVENANCE" },
    verifiedAt: null,
    ...(layer === "procedural" ? { proceduralPriority: "required" as const } : {}),
    ...overrides,
  } as MemoryBlockRecord["document"];
  return {
    id: `block-${layer}`,
    revision: 3,
    document,
    operation: "update",
    actor: { actorType: "system", actorId: null },
    restoredFromRevision: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
  };
}

describe("stable memory-block context adapter", () => {
  it("maps B11 records directly without retrieval and preserves input order", () => {
    const records = [record("identity"), record("human"), record("procedural")];
    const candidates = mapMemoryBlocksToContextCandidates(records);

    expect(candidates.map(({ layer }) => layer)).toEqual(["identity", "human", "procedural"]);
    expect(candidates.map(({ reference }) => reference.id)).toEqual(records.map(({ id }) => id));
    expect(candidates.map(({ inclusionReasons }) => inclusionReasons[0].code)).toEqual([
      "contract-required",
      "configured-profile",
      "capability-enabled",
    ]);
  });

  it("puts only persisted content in the model representation", () => {
    const candidate = mapMemoryBlockToContextCandidate(record("human"));
    expect(candidate.representations).toEqual([
      {
        kind: "full",
        id: "memory-block.content",
        version: "1",
        content: "human model content",
      },
    ]);
    const modelContent = JSON.stringify(candidate.representations);
    expect(modelContent).not.toContain("PRIVATE LABEL");
    expect(modelContent).not.toContain("PRIVATE DESCRIPTION");
    expect(modelContent).not.toContain("PRIVATE PROVENANCE");
  });

  it("projects stable policy metadata without token accounting or canonical rank", () => {
    const candidate = mapMemoryBlockToContextCandidate(
      record("procedural", { readOnly: true, declaredOrder: 7, proceduralPriority: "optional" })
    );
    expect(candidate).toMatchObject({
      owner: "agent",
      mutability: "immutable",
      modelVisibility: "conditional",
      authority: "untrusted-data",
      ordering: {
        declaredOrder: 7,
        procedurePriority: "optional",
        scopeSpecificity: 0,
      },
    });
    expect(candidate.ordering).not.toHaveProperty("canonicalRank");
    expect(candidate).not.toHaveProperty("accounting");
  });

  it("accepts the largest B11-valid block so existing stable context is not dropped", () => {
    const content = "x".repeat(1_000_000);
    const candidate = mapMemoryBlockToContextCandidate(
      record("identity", {
        content,
        characterBudget: { unit: "characters", limit: 1_000_000 },
      })
    );
    expect(candidate.representations[0].content).toHaveLength(1_000_000);
  });
});
