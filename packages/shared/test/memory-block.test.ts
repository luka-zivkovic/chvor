import { describe, expect, it } from "vitest";
import {
  MEMORY_BLOCK_LIMITS,
  isMemoryBlockTimestamp,
  memoryBlockCharacterCount,
  memoryBlockActorSchema,
  memoryBlockCreateSchema,
  memoryBlockDocumentV1Schema,
  memoryBlockRecordSchema,
  memoryBlockRestoreSchema,
  memoryBlockUpdateSchema,
  parseMemoryBlockDocument,
} from "../src/index.js";

function document(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    layer: "human",
    managedBy: "user",
    label: "Preferences",
    description: null,
    content: "Prefer concise responses.",
    characterBudget: { unit: "characters", limit: 100 },
    declaredOrder: 1,
    readOnly: false,
    confidence: 1,
    provenance: { kind: "stated", source: { type: "session", id: "session-1" } },
    verifiedAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("structured memory block v1", () => {
  it("accepts only exact millisecond-precision offset timestamps", () => {
    expect(isMemoryBlockTimestamp("2026-07-12T00:00:00.000Z")).toBe(true);
    expect(isMemoryBlockTimestamp("2026-07-12T02:00:00.000+02:00")).toBe(true);
    expect(isMemoryBlockTimestamp("2026-07-12T00:00:00Z")).toBe(false);
    expect(isMemoryBlockTimestamp("Sunday, July 12, 2026 12:00:00 GMT+0000")).toBe(false);
    expect(isMemoryBlockTimestamp("2026-02-31T00:00:00.000Z")).toBe(false);
    expect(isMemoryBlockTimestamp("2026-07-12T00:00:00.000+99:99")).toBe(false);
  });

  it("parses stable user-managed and agent-managed documents", () => {
    expect(parseMemoryBlockDocument(document()).layer).toBe("human");
    expect(
      parseMemoryBlockDocument(
        document({
          layer: "procedural",
          managedBy: "agent",
          proceduralPriority: "required",
        })
      )
    ).toMatchObject({ layer: "procedural", managedBy: "agent" });
  });

  it("enforces layer-manager and procedural-priority rules", () => {
    expect(memoryBlockDocumentV1Schema.safeParse(document({ managedBy: "agent" })).success).toBe(
      false
    );
    expect(
      memoryBlockDocumentV1Schema.safeParse(document({ layer: "procedural", managedBy: "agent" }))
        .success
    ).toBe(false);
    expect(
      memoryBlockDocumentV1Schema.safeParse(
        document({ layer: "human", proceduralPriority: "optional" })
      ).success
    ).toBe(false);
  });

  it("counts Unicode code points and enforces the exact character budget", () => {
    expect("😀".length).toBe(2);
    expect(memoryBlockCharacterCount("A😀é")).toBe(4);
    expect(
      memoryBlockDocumentV1Schema.safeParse(
        document({ content: "😀😀", characterBudget: { unit: "characters", limit: 2 } })
      ).success
    ).toBe(true);
    expect(
      memoryBlockDocumentV1Schema.safeParse(
        document({ content: "😀😀😀", characterBudget: { unit: "characters", limit: 2 } })
      ).success
    ).toBe(false);
  });

  it("rejects unknown fields, invalid timestamps, NUL text, and unsafe provenance", () => {
    expect(memoryBlockDocumentV1Schema.safeParse({ ...document(), future: true }).success).toBe(
      false
    );
    expect(
      memoryBlockDocumentV1Schema.safeParse(document({ verifiedAt: "2026-07-12T00:00:00Z" }))
        .success
    ).toBe(false);
    expect(memoryBlockDocumentV1Schema.safeParse(document({ content: "bad\0text" })).success).toBe(
      false
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(memoryBlockDocumentV1Schema.safeParse(document({ provenance: cyclic })).success).toBe(
      false
    );
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "secret", { get: () => "invoked", enumerable: true });
    expect(memoryBlockDocumentV1Schema.safeParse(document({ provenance: accessor })).success).toBe(
      false
    );
  });

  it("bounds fields, confidence, and complete documents", () => {
    expect(
      memoryBlockDocumentV1Schema.safeParse(
        document({ label: "x".repeat(MEMORY_BLOCK_LIMITS.labelCodePoints + 1) })
      ).success
    ).toBe(false);
    expect(memoryBlockDocumentV1Schema.safeParse(document({ confidence: 1.1 })).success).toBe(
      false
    );
    expect(memoryBlockDocumentV1Schema.safeParse(document({ label: "   " })).success).toBe(false);
    expect(memoryBlockActorSchema.safeParse({ actorType: "agent", actorId: "" }).success).toBe(
      false
    );
  });

  it("validates update, restore, and immutable audit record envelopes", () => {
    expect(memoryBlockCreateSchema.safeParse({ document: document() }).success).toBe(true);
    expect(
      memoryBlockUpdateSchema.safeParse({ expectedRevision: 1, document: document() }).success
    ).toBe(true);
    expect(
      memoryBlockRestoreSchema.safeParse({ expectedRevision: 2, restoredFromRevision: 1 }).success
    ).toBe(true);
    expect(
      memoryBlockRecordSchema.safeParse({
        id: "block-1",
        revision: 3,
        document: document(),
        operation: "restore",
        actor: { actorType: "session", actorId: "session-1" },
        restoredFromRevision: 1,
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:01:00.000Z",
      }).success
    ).toBe(true);
    const record = {
      id: "block-1",
      document: document(),
      actor: { actorType: "user", actorId: null },
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:01:00.000Z",
    };
    expect(
      memoryBlockRecordSchema.safeParse({
        ...record,
        revision: 2,
        operation: "create",
        restoredFromRevision: null,
      }).success
    ).toBe(false);
    expect(
      memoryBlockRecordSchema.safeParse({
        ...record,
        revision: 1,
        operation: "update",
        restoredFromRevision: null,
      }).success
    ).toBe(false);
    expect(
      memoryBlockRecordSchema.safeParse({
        ...record,
        revision: 3,
        operation: "restore",
        restoredFromRevision: 2,
      }).success
    ).toBe(false);
    expect(
      memoryBlockRecordSchema.safeParse({
        id: "block-1",
        revision: 1,
        document: document(),
        operation: "create",
        actor: { actorType: "user", actorId: null },
        restoredFromRevision: null,
        createdAt: "2026-07-12T00:01:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      }).success
    ).toBe(false);
  });
});
