import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isMemoryBlockTimestamp } from "@chvor/shared";
import * as defaultMemoryBlockStore from "../db/memory-block-store.ts";
import {
  MEMORY_BLOCK_PAGE_MAX,
  MemoryBlockForbiddenError,
  MemoryBlockImmutableIdentityError,
  MemoryBlockNotFoundError,
  MemoryBlockReadOnlyError,
  MemoryBlockRevisionConflictError,
  MemoryBlockValidationError,
  type MemoryBlockActor,
  type MemoryBlockListCursor,
  type MemoryBlockRecord,
} from "../db/memory-block-store.ts";
import type { AuthEnv } from "../middleware/auth.ts";

const memoryBlocks = new Hono<AuthEnv>();

export const MEMORY_BLOCK_REQUEST_MAX_BYTES = 512 * 1024;
const DEFAULT_PAGE_LIMIT = 20;

type JsonObject = Record<string, unknown>;

class MemoryBlockQueryError extends Error {}
class MemoryBlockRequestError extends Error {}

memoryBlocks.use(
  "*",
  bodyLimit({
    maxSize: MEMORY_BLOCK_REQUEST_MAX_BYTES,
    onError: (c) => c.json({ error: "Memory block payload too large" }, 413),
  })
);

memoryBlocks.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function exactObject(value: unknown, keys: readonly string[]): JsonObject {
  const result = object(value);
  if (!result || Object.keys(result).some((key) => !keys.includes(key))) {
    throw new MemoryBlockRequestError("invalid request shape");
  }
  return result;
}

async function readJson(c: Context<AuthEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof Error && error.name === "BodyLimitError") throw error;
    throw new MemoryBlockRequestError("request body must be valid JSON");
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new MemoryBlockRequestError(`${field} must be a positive integer`);
  }
  return value as number;
}

function validId(id: string): boolean {
  return id.length > 0 && id.length <= 256;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!/^\d+$/.test(value)) throw new MemoryBlockQueryError("limit must be an integer");
  const limit = Number(value);
  if (limit < 1 || limit > MEMORY_BLOCK_PAGE_MAX) {
    throw new MemoryBlockQueryError(`limit must be between 1 and ${MEMORY_BLOCK_PAGE_MAX}`);
  }
  return limit;
}

function encodeCursor(value: JsonObject): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new MemoryBlockQueryError("cursor is malformed");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const result = object(parsed);
    if (!result) throw new Error("invalid cursor");
    return result;
  } catch {
    throw new MemoryBlockQueryError("cursor is malformed");
  }
}

function listCursor(value: string | undefined): MemoryBlockListCursor | undefined {
  const cursor = decodeCursor(value);
  if (!cursor) return undefined;
  if (
    cursor.v !== 1 ||
    cursor.kind !== "blocks" ||
    !isMemoryBlockTimestamp(cursor.updatedAt) ||
    typeof cursor.id !== "string" ||
    !validId(cursor.id) ||
    Object.keys(cursor).sort().join(",") !== "id,kind,updatedAt,v"
  ) {
    throw new MemoryBlockQueryError("cursor is malformed");
  }
  return { updatedAt: cursor.updatedAt, id: cursor.id };
}

function revisionCursor(value: string | undefined): number | undefined {
  const cursor = decodeCursor(value);
  if (!cursor) return undefined;
  if (
    cursor.v !== 1 ||
    cursor.kind !== "revisions" ||
    !Number.isSafeInteger(cursor.revision) ||
    (cursor.revision as number) < 1 ||
    (cursor.revision as number) > 2_147_483_647 ||
    Object.keys(cursor).sort().join(",") !== "kind,revision,v"
  ) {
    throw new MemoryBlockQueryError("cursor is malformed");
  }
  return cursor.revision as number;
}

function actor(c: Context<AuthEnv>): MemoryBlockActor {
  const apiKey = c.get("authType") === "apikey";
  return {
    actorType: apiKey ? "agent" : "user",
    actorId: apiKey ? (c.get("apiKeyId") ?? null) : (c.get("sessionId") ?? null),
  };
}

function documentFrom(record: MemoryBlockRecord): JsonObject | null {
  return object(record.document);
}

function apiKeyMayCreate(document: unknown): boolean {
  const candidate = object(document);
  return candidate?.layer === "procedural" && candidate.managedBy === "agent";
}

function apiKeyMayUpdate(current: MemoryBlockRecord, document: unknown): boolean {
  const before = documentFrom(current);
  const after = object(document);
  return (
    before?.layer === "procedural" &&
    before.managedBy === "agent" &&
    before.readOnly !== true &&
    after?.layer === "procedural" &&
    after.managedBy === "agent"
  );
}

function isApiKey(c: Context<AuthEnv>): boolean {
  return c.get("authType") === "apikey";
}

function persistenceError(c: Context<AuthEnv>, error: unknown) {
  if (error instanceof Error && error.name === "BodyLimitError") throw error;
  const name = error instanceof Error ? error.constructor.name : "";
  const details = object(error);
  if (error instanceof MemoryBlockNotFoundError || name.includes("NotFound")) {
    return c.json({ error: "Memory block not found" }, 404);
  }
  if (
    error instanceof MemoryBlockRevisionConflictError ||
    name.includes("RevisionConflict") ||
    typeof details?.actualRevision === "number"
  ) {
    return c.json(
      {
        error: "Memory block revision conflict",
        expectedRevision: details?.expectedRevision,
        actualRevision: details?.actualRevision,
      },
      409
    );
  }
  if (
    error instanceof MemoryBlockReadOnlyError ||
    error instanceof MemoryBlockForbiddenError ||
    name.includes("ReadOnly") ||
    name.includes("Forbidden")
  ) {
    return c.json({ error: "Memory block write forbidden" }, 403);
  }
  if (
    error instanceof MemoryBlockRequestError ||
    error instanceof MemoryBlockValidationError ||
    error instanceof MemoryBlockImmutableIdentityError ||
    error instanceof RangeError ||
    name === "ZodError" ||
    name.includes("Immutable") ||
    name.includes("Validation")
  ) {
    return c.json({ error: "Invalid memory block request" }, 400);
  }
  throw error;
}

memoryBlocks.get("/", async (c) => {
  try {
    const store = defaultMemoryBlockStore;
    const page = store.listMemoryBlocks(
      parseLimit(c.req.query("limit")),
      listCursor(c.req.query("cursor"))
    );
    return c.json({
      data: {
        records: page.records,
        nextCursor: page.nextCursor ? encodeCursor({ kind: "blocks", ...page.nextCursor }) : null,
      },
    });
  } catch (error) {
    if (error instanceof MemoryBlockQueryError) {
      return c.json({ error: "Invalid memory block query" }, 400);
    }
    throw error;
  }
});

memoryBlocks.post("/", async (c) => {
  try {
    const store = defaultMemoryBlockStore;
    const body = exactObject(await readJson(c), ["document"]);
    if (!("document" in body)) throw new MemoryBlockRequestError("document is required");
    if (isApiKey(c) && !apiKeyMayCreate(body.document)) {
      return c.json({ error: "API keys may write only agent-managed procedural blocks" }, 403);
    }
    return c.json({ data: { memoryBlock: store.createMemoryBlock(body.document, actor(c)) } }, 201);
  } catch (error) {
    return persistenceError(c, error);
  }
});

memoryBlocks.get("/:id/revisions", async (c) => {
  const id = c.req.param("id");
  if (!validId(id)) return c.json({ error: "Invalid memory block ID" }, 400);
  const store = defaultMemoryBlockStore;
  if (!store.getMemoryBlock(id)) return c.json({ error: "Memory block not found" }, 404);
  try {
    const page = store.listMemoryBlockRevisions(
      id,
      parseLimit(c.req.query("limit")),
      revisionCursor(c.req.query("cursor"))
    );
    return c.json({
      data: {
        revisions: page.revisions,
        nextCursor: page.nextCursor
          ? encodeCursor({ kind: "revisions", revision: page.nextCursor })
          : null,
      },
    });
  } catch (error) {
    if (error instanceof MemoryBlockQueryError) {
      return c.json({ error: "Invalid memory block query" }, 400);
    }
    throw error;
  }
});

memoryBlocks.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  if (!validId(id)) return c.json({ error: "Invalid memory block ID" }, 400);
  if (isApiKey(c)) return c.json({ error: "API keys may not restore memory blocks" }, 403);
  try {
    const store = defaultMemoryBlockStore;
    const body = exactObject(await readJson(c), ["expectedRevision", "restoredFromRevision"]);
    const expected = positiveInteger(body.expectedRevision, "expectedRevision");
    const source = positiveInteger(body.restoredFromRevision, "restoredFromRevision");
    return c.json({
      data: { memoryBlock: store.restoreMemoryBlock(id, expected, source, actor(c)) },
    });
  } catch (error) {
    return persistenceError(c, error);
  }
});

memoryBlocks.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!validId(id)) return c.json({ error: "Invalid memory block ID" }, 400);
  const store = defaultMemoryBlockStore;
  const record = store.getMemoryBlock(id);
  return record
    ? c.json({ data: { memoryBlock: record } })
    : c.json({ error: "Memory block not found" }, 404);
});

memoryBlocks.put("/:id", async (c) => {
  const id = c.req.param("id");
  if (!validId(id)) return c.json({ error: "Invalid memory block ID" }, 400);
  try {
    const store = defaultMemoryBlockStore;
    const body = exactObject(await readJson(c), ["expectedRevision", "document"]);
    const expected = positiveInteger(body.expectedRevision, "expectedRevision");
    if (!("document" in body)) throw new MemoryBlockRequestError("document is required");
    if (isApiKey(c)) {
      const current = store.getMemoryBlock(id);
      if (!current) return c.json({ error: "Memory block not found" }, 404);
      if (!apiKeyMayUpdate(current, body.document)) {
        return c.json({ error: "API key memory block write forbidden" }, 403);
      }
    }
    return c.json({
      data: { memoryBlock: store.updateMemoryBlock(id, expected, body.document, actor(c)) },
    });
  } catch (error) {
    return persistenceError(c, error);
  }
});

export default memoryBlocks;
