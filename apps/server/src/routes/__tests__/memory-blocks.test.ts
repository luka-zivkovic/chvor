import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-memory-block-routes-"));
process.env.CHVOR_DATA_DIR = dataDir;

type Document = {
  schemaVersion: 1;
  layer: "identity" | "human" | "procedural";
  managedBy: "user" | "agent";
  label: string;
  description: string | null;
  content: string;
  characterBudget: { unit: "characters"; limit: number };
  declaredOrder: number;
  proceduralPriority?: "required" | "optional";
  readOnly: boolean;
  confidence: number;
  provenance: { kind: string; sourceId: string | null };
  verifiedAt: string | null;
};

type Actor = { actorType: "user" | "agent"; actorId: string | null };
type Record = {
  id: string;
  revision: number;
  operation: "create" | "update" | "restore";
  actor: Actor;
  restoredFromRevision: number | null;
  document: Document;
  createdAt: string;
  updatedAt: string;
};

let app: Hono;
let readKey = "";
let writeKey = "";
let genericKey = "";
let sessionToken = "";
let closeDb: typeof import("../../db/database.ts").closeDb;

const records = new Map<string, Record[]>();
let sequence = 0;

class MemoryBlockNotFoundError extends Error {}
class MemoryBlockImmutableFieldError extends Error {}
class MemoryBlockRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super("revision conflict");
  }
}
class MemoryBlockValidationError extends Error {}

function document(overrides: Partial<Document> = {}): Document {
  const layer = overrides.layer ?? "identity";
  return {
    schemaVersion: 1,
    layer,
    managedBy: overrides.managedBy ?? "user",
    label: overrides.label ?? "Stable profile",
    description: overrides.description ?? null,
    content: overrides.content ?? "Be concise.",
    characterBudget: overrides.characterBudget ?? { unit: "characters", limit: 100 },
    declaredOrder: overrides.declaredOrder ?? 0,
    ...(layer === "procedural"
      ? { proceduralPriority: overrides.proceduralPriority ?? "required" }
      : {}),
    readOnly: overrides.readOnly ?? false,
    confidence: overrides.confidence ?? 1,
    provenance: overrides.provenance ?? { kind: "manual", sourceId: null },
    verifiedAt: overrides.verifiedAt ?? null,
  };
}

function validate(value: unknown): Document {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryBlockValidationError("invalid document");
  }
  const candidate = value as Document;
  if (
    typeof candidate.content !== "string" ||
    !Number.isSafeInteger(candidate.characterBudget?.limit) ||
    [...candidate.content].length > candidate.characterBudget.limit
  ) {
    throw new MemoryBlockValidationError("content exceeds private limit detail");
  }
  if (candidate.label === "explode") {
    throw new Error("private persistence failure detail");
  }
  return structuredClone(candidate);
}

function now(): string {
  sequence += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
}

function current(id: string): Record | null {
  return records.get(id)?.at(-1) ?? null;
}

const fakeStore = {
  createMemoryBlock(value: unknown, actor: Actor): Record {
    const snapshot = validate(value);
    const id = `block-${sequence + 1}`;
    const timestamp = now();
    const record: Record = {
      id,
      revision: 1,
      operation: "create",
      actor,
      restoredFromRevision: null,
      document: snapshot,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    records.set(id, [record]);
    return record;
  },
  getMemoryBlock(id: string): Record | null {
    return current(id);
  },
  listMemoryBlocks(limit: number, cursor?: { updatedAt: string; id: string }) {
    const all = [...records.values()]
      .map((history) => history.at(-1)!)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const start = cursor ? Math.max(0, all.findIndex((record) => record.id === cursor.id) + 1) : 0;
    const page = all.slice(start, start + limit);
    const last = page.at(-1);
    return {
      records: page,
      nextCursor:
        start + limit < all.length && last ? { updatedAt: last.updatedAt, id: last.id } : null,
    };
  },
  listMemoryBlockRevisions(id: string, limit: number, beforeRevision?: number) {
    const history = records.get(id);
    if (!history) throw new MemoryBlockNotFoundError();
    const all = [...history]
      .reverse()
      .filter((record) => beforeRevision === undefined || record.revision < beforeRevision);
    const page = all.slice(0, limit);
    const last = page.at(-1);
    return {
      revisions: page,
      nextCursor: page.length < all.length && last ? last.revision : null,
    };
  },
  updateMemoryBlock(id: string, expectedRevision: number, value: unknown, actor: Actor): Record {
    const active = current(id);
    if (!active) throw new MemoryBlockNotFoundError();
    if (active.revision !== expectedRevision) {
      throw new MemoryBlockRevisionConflictError(expectedRevision, active.revision);
    }
    const snapshot = validate(value);
    if (
      snapshot.layer !== active.document.layer ||
      snapshot.managedBy !== active.document.managedBy
    ) {
      throw new MemoryBlockImmutableFieldError();
    }
    const record: Record = {
      ...active,
      revision: active.revision + 1,
      operation: "update",
      actor,
      restoredFromRevision: null,
      document: snapshot,
      updatedAt: now(),
    };
    records.get(id)!.push(record);
    return record;
  },
  restoreMemoryBlock(
    id: string,
    expectedRevision: number,
    restoredFromRevision: number,
    actor: Actor
  ): Record {
    const active = current(id);
    if (!active) throw new MemoryBlockNotFoundError();
    if (active.revision !== expectedRevision) {
      throw new MemoryBlockRevisionConflictError(expectedRevision, active.revision);
    }
    const source = records.get(id)!.find((record) => record.revision === restoredFromRevision);
    if (!source) throw new MemoryBlockNotFoundError();
    const record: Record = {
      ...active,
      revision: active.revision + 1,
      operation: "restore",
      actor,
      restoredFromRevision,
      document: structuredClone(source.document),
      updatedAt: now(),
    };
    records.get(id)!.push(record);
    return record;
  },
};

function authorization(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function encodeCursor(value: { [key: string]: unknown }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function request(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<Response> {
  return app.request(path, {
    method: options.method,
    headers: {
      ...authorization(options.token ?? readKey),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

beforeAll(async () => {
  const [{ chvorAuth }, routes, authStore, apiKeyStore, database, memoryBlockStore] =
    await Promise.all([
      import("../../middleware/auth.ts"),
      import("../memory-blocks.ts"),
      import("../../db/auth-store.ts"),
      import("../../db/api-key-store.ts"),
      import("../../db/database.ts"),
      import("../../db/memory-block-store.ts"),
    ]);
  closeDb = database.closeDb;
  vi.spyOn(memoryBlockStore, "createMemoryBlock").mockImplementation(
    fakeStore.createMemoryBlock as never
  );
  vi.spyOn(memoryBlockStore, "getMemoryBlock").mockImplementation(
    fakeStore.getMemoryBlock as never
  );
  vi.spyOn(memoryBlockStore, "listMemoryBlocks").mockImplementation(
    fakeStore.listMemoryBlocks as never
  );
  vi.spyOn(memoryBlockStore, "listMemoryBlockRevisions").mockImplementation(
    fakeStore.listMemoryBlockRevisions as never
  );
  vi.spyOn(memoryBlockStore, "updateMemoryBlock").mockImplementation(
    fakeStore.updateMemoryBlock as never
  );
  vi.spyOn(memoryBlockStore, "restoreMemoryBlock").mockImplementation(
    fakeStore.restoreMemoryBlock as never
  );
  authStore.enableAuth();
  readKey = apiKeyStore.generateApiKey("block reader", undefined, "memory-block:read").key;
  writeKey = apiKeyStore.generateApiKey(
    "block writer",
    undefined,
    "memory-block:read,memory-block:write"
  ).key;
  genericKey = apiKeyStore.generateApiKey("generic", undefined, "api:read,api:write").key;
  sessionToken = authStore.createSession("memory-block-test").token;
  app = new Hono();
  app.use("/api/*", chvorAuth);
  app.route("/api/memory-blocks", routes.default);
});

beforeEach(() => {
  records.clear();
  sequence = 0;
});

afterAll(() => {
  vi.restoreAllMocks();
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("memory-block HTTP and authorization", () => {
  it("enforces dedicated scopes and no-store on every response", async () => {
    const unauthorized = await app.request("/api/memory-blocks");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    expect((await request("/api/memory-blocks", { token: genericKey })).status).toBe(403);
    expect((await request("/api/%6demory-blocks", { token: genericKey })).status).toBe(403);

    const list = await request("/api/memory-blocks");
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(
      (
        await request("/api/memory-blocks", {
          method: "POST",
          body: { document: document({ layer: "procedural", managedBy: "agent" }) },
        })
      ).status
    ).toBe(403);
  });

  it("lets sessions create, update, inspect history, and append restores", async () => {
    const createdResponse = await request("/api/memory-blocks", {
      method: "POST",
      token: sessionToken,
      body: { document: document() },
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { data: { memoryBlock: Record } };
    const id = created.data.memoryBlock.id;
    expect(created.data.memoryBlock).toMatchObject({
      revision: 1,
      operation: "create",
      actor: { actorType: "user" },
    });

    const updated = await request(`/api/memory-blocks/${id}`, {
      method: "PUT",
      token: sessionToken,
      body: { expectedRevision: 1, document: document({ content: "Updated" }) },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: { memoryBlock: { revision: 2, operation: "update" } },
    });

    const restored = await request(`/api/memory-blocks/${id}/restore`, {
      method: "POST",
      token: sessionToken,
      body: { expectedRevision: 2, restoredFromRevision: 1 },
    });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      data: {
        memoryBlock: {
          revision: 3,
          operation: "restore",
          restoredFromRevision: 1,
          document: { content: "Be concise." },
        },
      },
    });

    const history = (await (await request(`/api/memory-blocks/${id}/revisions`)).json()) as {
      data: { revisions: Record[] };
    };
    expect(history.data.revisions.map(({ revision }) => revision)).toEqual([3, 2, 1]);
    expect((await request(`/api/memory-blocks/${id}`)).status).toBe(200);
  });

  it("maps optimistic conflicts and immutable ownership to safe client errors", async () => {
    const created = (await (
      await request("/api/memory-blocks", {
        method: "POST",
        token: sessionToken,
        body: { document: document({ layer: "human" }) },
      })
    ).json()) as { data: { memoryBlock: Record } };
    const id = created.data.memoryBlock.id;

    const conflict = await request(`/api/memory-blocks/${id}`, {
      method: "PUT",
      token: sessionToken,
      body: { expectedRevision: 2, document: document({ layer: "human" }) },
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      expectedRevision: 2,
      actualRevision: 1,
    });

    const immutable = await request(`/api/memory-blocks/${id}`, {
      method: "PUT",
      token: sessionToken,
      body: {
        expectedRevision: 1,
        document: document({ layer: "procedural", managedBy: "user" }),
      },
    });
    expect(immutable.status).toBe(400);
    expect(await immutable.text()).not.toContain("private");
  });

  it("limits API keys to unlocked agent-managed procedural writes and forbids restore", async () => {
    expect(
      (
        await request("/api/memory-blocks", {
          method: "POST",
          token: writeKey,
          body: { document: document() },
        })
      ).status
    ).toBe(403);

    const created = (await (
      await request("/api/memory-blocks", {
        method: "POST",
        token: writeKey,
        body: {
          document: document({ layer: "procedural", managedBy: "agent", readOnly: false }),
        },
      })
    ).json()) as { data: { memoryBlock: Record } };
    const id = created.data.memoryBlock.id;
    expect(created.data.memoryBlock.actor.actorType).toBe("agent");

    expect(
      (
        await request(`/api/memory-blocks/${id}`, {
          method: "PUT",
          token: writeKey,
          body: {
            expectedRevision: 1,
            document: document({ layer: "procedural", managedBy: "agent", readOnly: true }),
          },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await request(`/api/memory-blocks/${id}`, {
          method: "PUT",
          token: writeKey,
          body: {
            expectedRevision: 2,
            document: document({ layer: "procedural", managedBy: "agent", readOnly: false }),
          },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await request(`/api/memory-blocks/${id}/restore`, {
          method: "POST",
          token: writeKey,
          body: { expectedRevision: 2, restoredFromRevision: 1 },
        })
      ).status
    ).toBe(403);
  });

  it("preserves deterministic Unicode code-point budget validation", async () => {
    const accepted = await request("/api/memory-blocks", {
      method: "POST",
      token: sessionToken,
      body: {
        document: document({ content: "😀😀", characterBudget: { unit: "characters", limit: 2 } }),
      },
    });
    expect(accepted.status).toBe(201);
    const rejected = await request("/api/memory-blocks", {
      method: "POST",
      token: sessionToken,
      body: {
        document: document({ content: "😀😀", characterBudget: { unit: "characters", limit: 1 } }),
      },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain("private limit detail");
  });

  it("bounds pages, cursors, request shapes, and bodies", async () => {
    for (const label of ["one", "two"]) {
      expect(
        (
          await request("/api/memory-blocks", {
            method: "POST",
            token: sessionToken,
            body: { document: document({ label }) },
          })
        ).status
      ).toBe(201);
    }
    const first = (await (await request("/api/memory-blocks?limit=1")).json()) as {
      data: { records: Record[]; nextCursor: string };
    };
    expect(first.data.records).toHaveLength(1);
    expect(first.data.nextCursor).toBeTruthy();
    const second = (await (
      await request(`/api/memory-blocks?limit=1&cursor=${first.data.nextCursor}`)
    ).json()) as { data: { records: Record[]; nextCursor: string | null } };
    expect(second.data.records).toHaveLength(1);
    expect(second.data.nextCursor).toBeNull();
    expect((await request("/api/memory-blocks?limit=101")).status).toBe(400);
    expect((await request("/api/memory-blocks?cursor=bad!cursor")).status).toBe(400);
    const parseableButNonCanonical = encodeCursor({
      v: 1,
      kind: "blocks",
      updatedAt: "Sunday, July 12, 2026 12:00:00 GMT+0000",
      id: "block-1",
    });
    expect((await request(`/api/memory-blocks?cursor=${parseableButNonCanonical}`)).status).toBe(
      400
    );
    const invalidCalendarDate = encodeCursor({
      v: 1,
      kind: "blocks",
      updatedAt: "2026-02-31T00:00:00.000Z",
      id: "block-1",
    });
    expect((await request(`/api/memory-blocks?cursor=${invalidCalendarDate}`)).status).toBe(400);
    const oversizedRevision = encodeCursor({
      v: 1,
      kind: "revisions",
      revision: 2_147_483_648,
    });
    expect(
      (
        await request(
          `/api/memory-blocks/${first.data.records[0].id}/revisions?cursor=${oversizedRevision}`
        )
      ).status
    ).toBe(400);
    expect(
      (
        await request("/api/memory-blocks", {
          method: "POST",
          token: sessionToken,
          body: { document: document(), unexpected: true },
        })
      ).status
    ).toBe(400);

    const body = JSON.stringify({ document: document({ content: "x".repeat(600_000) }) });
    const oversized = await app.request("/api/memory-blocks", {
      method: "POST",
      headers: {
        ...authorization(sessionToken),
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("cache-control")).toBe("no-store");
  });

  it("does not expose unexpected persistence details", async () => {
    const response = await request("/api/memory-blocks", {
      method: "POST",
      token: sessionToken,
      body: { document: document({ label: "explode" }) },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private persistence failure detail");
  });
});
