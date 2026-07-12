import {
  MEMORY_BLOCK_REQUEST_MAX_BYTES,
  type MemoryBlockCreateRequest,
  type MemoryBlockDocumentV1,
  type MemoryBlockRecord,
  type MemoryBlockRestoreRequest,
  type MemoryBlockUpdateRequest,
} from "@chvor/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { HttpError } from "./http-error";
import { createMemoryBlocksApi } from "./memory-blocks-api";

const document: MemoryBlockDocumentV1 = {
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
  provenance: { kind: "stated" },
  verifiedAt: null,
};

const record: MemoryBlockRecord = {
  id: "block/one",
  revision: 1,
  document,
  operation: "create",
  actor: { actorType: "user", actorId: null },
  restoredFromRevision: null,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("memory blocks API", () => {
  it("shares the server's 512 KiB mutation request limit for preflight checks", () => {
    expect(MEMORY_BLOCK_REQUEST_MAX_BYTES).toBe(512 * 1024);
  });

  it("encodes IDs and treats list and revision cursors as opaque values", async () => {
    const listPage = { records: [record], nextCursor: "next/list" };
    const revisionPage = { revisions: [record], nextCursor: null };
    const request = vi
      .fn()
      .mockResolvedValueOnce(listPage)
      .mockResolvedValueOnce({ memoryBlock: record })
      .mockResolvedValueOnce(revisionPage);
    const memoryBlocks = createMemoryBlocksApi(request);

    await expect(memoryBlocks.list({ limit: 7, cursor: "opaque+/= ?&" })).resolves.toEqual(
      listPage
    );
    await expect(memoryBlocks.get("block/with space?")).resolves.toEqual(record);
    await expect(
      memoryBlocks.revisions("block/with space?", { limit: 3, cursor: "rev+/=" })
    ).resolves.toEqual(revisionPage);

    expect(request.mock.calls[0]).toEqual(["/memory-blocks?limit=7&cursor=opaque%2B%2F%3D+%3F%26"]);
    expect(request.mock.calls[1]).toEqual(["/memory-blocks/block%2Fwith%20space%3F"]);
    expect(request.mock.calls[2]).toEqual([
      "/memory-blocks/block%2Fwith%20space%3F/revisions?limit=3&cursor=rev%2B%2F%3D",
    ]);
  });

  it("sends typed mutation bodies and unwraps memory-block envelopes", async () => {
    const updated = { ...record, revision: 2, operation: "update" as const };
    const restored = {
      ...record,
      revision: 3,
      operation: "restore" as const,
      restoredFromRevision: 1,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ memoryBlock: record })
      .mockResolvedValueOnce({ memoryBlock: updated })
      .mockResolvedValueOnce({ memoryBlock: restored });
    const memoryBlocks = createMemoryBlocksApi(request);
    const createBody: MemoryBlockCreateRequest = { document };
    const updateBody: MemoryBlockUpdateRequest = { expectedRevision: 1, document };
    const restoreBody: MemoryBlockRestoreRequest = {
      expectedRevision: 2,
      restoredFromRevision: 1,
    };

    await expect(memoryBlocks.create(createBody)).resolves.toEqual(record);
    await expect(memoryBlocks.update("block/one", updateBody)).resolves.toEqual(updated);
    await expect(memoryBlocks.restore("block/one", restoreBody)).resolves.toEqual(restored);

    expect(request.mock.calls).toEqual([
      ["/memory-blocks", { method: "POST", body: JSON.stringify(createBody) }],
      ["/memory-blocks/block%2Fone", { method: "PUT", body: JSON.stringify(updateBody) }],
      ["/memory-blocks/block%2Fone/restore", { method: "POST", body: JSON.stringify(restoreBody) }],
    ]);
  });

  it("preserves only safe revision metadata on 409 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 409,
        ok: false,
        json: vi.fn().mockResolvedValue({
          error: "Memory block revision conflict",
          expectedRevision: 4,
          actualRevision: 6,
          secret: { internal: "do not retain" },
        }),
      } satisfies Partial<Response>)
    );

    let caught: unknown;
    try {
      await api.memoryBlocks.update("block/one", { expectedRevision: 4, document });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).toMatchObject({
      status: 409,
      expectedRevision: 4,
      actualRevision: 6,
      message: "Memory block revision conflict",
    });
    expect(caught).not.toHaveProperty("body");
    expect(caught).not.toHaveProperty("secret");
  });
});
