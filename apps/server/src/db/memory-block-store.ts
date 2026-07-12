import { randomUUID } from "node:crypto";
import {
  isMemoryBlockTimestamp,
  memoryBlockActorSchema,
  safeParseMemoryBlockDocument,
  type MemoryBlockActor,
  type MemoryBlockActorType,
  type MemoryBlockDocumentV1,
  type MemoryBlockOperation,
  type MemoryBlockRecord,
} from "@chvor/shared";
import { getDb } from "./database.ts";

export { MEMORY_BLOCK_SCHEMA_VERSION, memoryBlockCharacterCount } from "@chvor/shared";
export type {
  MemoryBlockActor,
  MemoryBlockActorType,
  MemoryBlockDocumentV1,
  MemoryBlockOperation,
  MemoryBlockRecord,
} from "@chvor/shared";
export const MEMORY_BLOCK_PAGE_DEFAULT = 20;
export const MEMORY_BLOCK_PAGE_MAX = 100;
export const MEMORY_BLOCK_CONTENT_MAX_CHARACTERS = 1_000_000;

export interface MemoryBlockListCursor {
  updatedAt: string;
  id: string;
}

export interface MemoryBlockPage {
  records: MemoryBlockRecord[];
  nextCursor: MemoryBlockListCursor | null;
}

export interface MemoryBlockRevisionPage {
  revisions: MemoryBlockRecord[];
  nextCursor: number | null;
}

export class MemoryBlockValidationError extends Error {}
export class MemoryBlockCorruptionError extends Error {}
export class MemoryBlockNotFoundError extends Error {}
export class MemoryBlockImmutableIdentityError extends Error {}
export class MemoryBlockReadOnlyError extends Error {}
export class MemoryBlockForbiddenError extends Error {}

export class MemoryBlockRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `memory block revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}`
    );
  }
}

interface MemoryBlockRow {
  id: string;
  revision: number;
  layer: string;
  managed_by: string;
  snapshot_json: string;
  operation: string;
  actor_type: string;
  actor_id: string | null;
  restored_from_revision: number | null;
  created_at: string;
  updated_at: string;
}

interface CurrentMemoryBlockRow extends MemoryBlockRow {
  current_revision: number;
}

const ACTOR_TYPES = new Set<MemoryBlockActorType>([
  "user",
  "session",
  "apikey",
  "agent",
  "channel",
  "schedule",
  "daemon",
  "webhook",
  "system",
  "test",
]);
const AGENT_ACTOR_TYPES = new Set<MemoryBlockActorType>([
  "apikey",
  "agent",
  "channel",
  "schedule",
  "daemon",
  "webhook",
]);
const OPERATIONS = new Set<MemoryBlockOperation>(["create", "update", "restore"]);

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function validTimestamp(value: unknown): value is string {
  return isMemoryBlockTimestamp(value);
}

function validationFailure(message: string): never {
  throw new MemoryBlockValidationError(message);
}

/** Validate and detach a strict v1 full-snapshot document. */
export function parseMemoryBlockDocument(value: unknown): MemoryBlockDocumentV1 {
  const result = safeParseMemoryBlockDocument(value);
  if (result.success) return result.data;
  throw new MemoryBlockValidationError(
    result.error.issues[0]?.message ?? "invalid memory block document",
    { cause: result.error }
  );
}

function checkedPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be a positive 32-bit integer`);
  }
  return value;
}

function checkedPageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_BLOCK_PAGE_MAX) {
    throw new RangeError(`limit must be between 1 and ${MEMORY_BLOCK_PAGE_MAX}`);
  }
  return limit;
}

function checkedActor(value: MemoryBlockActor): MemoryBlockActor {
  const parsed = memoryBlockActorSchema.safeParse(value);
  if (!parsed.success) validationFailure("actor metadata is invalid");
  return parsed.data;
}

function isAgentActor(actor: MemoryBlockActor): boolean {
  return AGENT_ACTOR_TYPES.has(actor.actorType);
}

function authorizeCreate(document: MemoryBlockDocumentV1, actor: MemoryBlockActor): void {
  if (isAgentActor(actor) && document.managedBy !== "agent") {
    throw new MemoryBlockForbiddenError("agent actors may create only agent-managed blocks");
  }
}

function authorizeRevision(document: MemoryBlockDocumentV1, actor: MemoryBlockActor): void {
  if (!isAgentActor(actor)) return;
  if (document.managedBy !== "agent") {
    throw new MemoryBlockForbiddenError("agent actors may revise only agent-managed blocks");
  }
  if (document.readOnly) {
    throw new MemoryBlockReadOnlyError("agent cannot alter a read-only memory block");
  }
}

function parseSnapshot(value: string, id: string, revision: number): MemoryBlockDocumentV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new MemoryBlockCorruptionError(
      `corrupt memory block ${id} revision ${revision}: invalid JSON`,
      { cause: error }
    );
  }
  const result = safeParseMemoryBlockDocument(parsed);
  if (!result.success) {
    throw new MemoryBlockCorruptionError(
      `corrupt memory block ${id} revision ${revision}: invalid document`,
      { cause: result.error }
    );
  }
  return result.data;
}

function recordFromRow(row: MemoryBlockRow): MemoryBlockRecord {
  const document = parseSnapshot(row.snapshot_json, row.id, row.revision);
  if (row.layer !== document.layer || row.managed_by !== document.managedBy) {
    throw new MemoryBlockCorruptionError(
      `corrupt memory block ${row.id} revision ${row.revision}: identity mismatch`
    );
  }
  if (
    !OPERATIONS.has(row.operation as MemoryBlockOperation) ||
    !ACTOR_TYPES.has(row.actor_type as MemoryBlockActorType)
  ) {
    throw new MemoryBlockCorruptionError(
      `corrupt memory block ${row.id} revision ${row.revision}: audit metadata`
    );
  }
  const restored = row.restored_from_revision;
  if ((row.operation === "restore") !== (restored !== null)) {
    throw new MemoryBlockCorruptionError(
      `corrupt memory block ${row.id} revision ${row.revision}: restore metadata`
    );
  }
  return {
    id: row.id,
    revision: row.revision,
    document,
    operation: row.operation as MemoryBlockOperation,
    actor: { actorType: row.actor_type as MemoryBlockActorType, actorId: row.actor_id },
    restoredFromRevision: restored,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CURRENT_SELECT = `SELECT b.id, b.current_revision AS revision, b.current_revision,
  b.layer, b.managed_by, r.snapshot AS snapshot_json, r.operation, r.actor_type,
  r.actor_id, r.restored_from_revision, b.created_at, b.updated_at
  FROM memory_blocks b JOIN memory_block_revisions r
    ON r.block_id = b.id AND r.revision = b.current_revision`;

const REVISION_SELECT = `SELECT b.id, r.revision, b.layer, b.managed_by,
  r.snapshot AS snapshot_json, r.operation, r.actor_type, r.actor_id,
  r.restored_from_revision, b.created_at, r.created_at AS updated_at
  FROM memory_blocks b JOIN memory_block_revisions r ON r.block_id = b.id`;

function currentRow(id: string): CurrentMemoryBlockRow | undefined {
  return getDb().prepare(`${CURRENT_SELECT} WHERE b.id = ?`).get(id) as
    | CurrentMemoryBlockRow
    | undefined;
}

function conflict(expectedRevision: number, id: string): never {
  const actual = getDb()
    .prepare("SELECT current_revision FROM memory_blocks WHERE id = ?")
    .get(id) as { current_revision: number } | undefined;
  if (!actual) throw new MemoryBlockNotFoundError(`memory block ${id} not found`);
  throw new MemoryBlockRevisionConflictError(expectedRevision, actual.current_revision);
}

function assertIdentityUnchanged(
  current: MemoryBlockDocumentV1,
  next: MemoryBlockDocumentV1
): void {
  if (current.layer !== next.layer || current.managedBy !== next.managedBy) {
    throw new MemoryBlockImmutableIdentityError("memory block layer and manager are immutable");
  }
}

function insertRevision(
  id: string,
  revision: number,
  operation: MemoryBlockOperation,
  document: MemoryBlockDocumentV1,
  actor: MemoryBlockActor,
  restoredFromRevision: number | null,
  now: string,
  snapshotJson = JSON.stringify(document)
): void {
  getDb()
    .prepare(
      `INSERT INTO memory_block_revisions
         (block_id, revision, operation, actor_type, actor_id, restored_from_revision, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      revision,
      operation,
      actor.actorType,
      actor.actorId,
      restoredFromRevision,
      snapshotJson,
      now
    );
}

export function createMemoryBlock(
  document: unknown,
  actorValue: MemoryBlockActor
): MemoryBlockRecord {
  const normalized = parseMemoryBlockDocument(document);
  const actor = checkedActor(actorValue);
  authorizeCreate(normalized, actor);
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO memory_blocks (id, layer, managed_by, current_revision, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`
    ).run(id, normalized.layer, normalized.managedBy, now, now);
    insertRevision(id, 1, "create", normalized, actor, null, now);
  })();

  return {
    id,
    revision: 1,
    document: normalized,
    operation: "create",
    actor,
    restoredFromRevision: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function getMemoryBlock(id: string): MemoryBlockRecord | null {
  const row = currentRow(id);
  return row ? recordFromRow(row) : null;
}

export function getMemoryBlockRevision(id: string, revision: number): MemoryBlockRecord | null {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) return null;
  const row = getDb()
    .prepare(`${REVISION_SELECT} WHERE b.id = ? AND r.revision = ?`)
    .get(id, revision) as MemoryBlockRow | undefined;
  return row ? recordFromRow(row) : null;
}

function checkedListCursor(cursor?: MemoryBlockListCursor): MemoryBlockListCursor | undefined {
  if (cursor === undefined) return undefined;
  if (
    !plainObject(cursor) ||
    !exactKeys(cursor, ["updatedAt", "id"]) ||
    !validTimestamp(cursor.updatedAt) ||
    typeof cursor.id !== "string" ||
    cursor.id.length < 1 ||
    cursor.id.length > 256
  ) {
    throw new RangeError("cursor requires a valid updatedAt timestamp and 1-256 character id");
  }
  return cursor;
}

export function listMemoryBlocks(
  limit = MEMORY_BLOCK_PAGE_DEFAULT,
  cursorValue?: MemoryBlockListCursor
): MemoryBlockPage {
  const boundedLimit = checkedPageLimit(limit);
  const cursor = checkedListCursor(cursorValue);
  const rows = cursor
    ? (getDb()
        .prepare(
          `${CURRENT_SELECT}
           WHERE b.updated_at < ? OR (b.updated_at = ? AND b.id < ?)
           ORDER BY b.updated_at DESC, b.id DESC LIMIT ?`
        )
        .all(cursor.updatedAt, cursor.updatedAt, cursor.id, boundedLimit + 1) as MemoryBlockRow[])
    : (getDb()
        .prepare(`${CURRENT_SELECT} ORDER BY b.updated_at DESC, b.id DESC LIMIT ?`)
        .all(boundedLimit + 1) as MemoryBlockRow[]);
  const pageRows = rows.slice(0, boundedLimit);
  const last = pageRows.at(-1);
  return {
    records: pageRows.map(recordFromRow),
    nextCursor:
      rows.length > boundedLimit && last ? { updatedAt: last.updated_at, id: last.id } : null,
  };
}

export function listMemoryBlockRevisions(
  id: string,
  limit = MEMORY_BLOCK_PAGE_DEFAULT,
  beforeRevision?: number
): MemoryBlockRevisionPage {
  const boundedLimit = checkedPageLimit(limit);
  if (beforeRevision !== undefined) checkedPositiveInteger(beforeRevision, "revision cursor");
  const rows = beforeRevision
    ? (getDb()
        .prepare(
          `${REVISION_SELECT} WHERE b.id = ? AND r.revision < ? ORDER BY r.revision DESC LIMIT ?`
        )
        .all(id, beforeRevision, boundedLimit + 1) as MemoryBlockRow[])
    : (getDb()
        .prepare(`${REVISION_SELECT} WHERE b.id = ? ORDER BY r.revision DESC LIMIT ?`)
        .all(id, boundedLimit + 1) as MemoryBlockRow[]);
  const pageRows = rows.slice(0, boundedLimit);
  const last = pageRows.at(-1);
  return {
    revisions: pageRows.map(recordFromRow),
    nextCursor: rows.length > boundedLimit && last ? last.revision : null,
  };
}

export function updateMemoryBlock(
  id: string,
  expectedRevisionValue: number,
  document: unknown,
  actorValue: MemoryBlockActor
): MemoryBlockRecord {
  const expectedRevision = checkedPositiveInteger(expectedRevisionValue, "expectedRevision");
  const normalized = parseMemoryBlockDocument(document);
  const actor = checkedActor(actorValue);
  const db = getDb();

  return db.transaction((): MemoryBlockRecord => {
    const current = currentRow(id);
    if (!current) throw new MemoryBlockNotFoundError(`memory block ${id} not found`);
    if (current.current_revision !== expectedRevision) conflict(expectedRevision, id);
    const currentRecord = recordFromRow(current);
    assertIdentityUnchanged(currentRecord.document, normalized);
    authorizeRevision(currentRecord.document, actor);

    const revision = expectedRevision + 1;
    checkedPositiveInteger(revision, "next revision");
    const now = new Date().toISOString();
    insertRevision(id, revision, "update", normalized, actor, null, now);
    const result = db
      .prepare(
        `UPDATE memory_blocks SET current_revision = ?, updated_at = ?
         WHERE id = ? AND current_revision = ?`
      )
      .run(revision, now, id, expectedRevision);
    if (result.changes !== 1) conflict(expectedRevision, id);

    return {
      id,
      revision,
      document: normalized,
      operation: "update",
      actor,
      restoredFromRevision: null,
      createdAt: current.created_at,
      updatedAt: now,
    };
  })();
}

export function restoreMemoryBlock(
  id: string,
  expectedRevisionValue: number,
  restoredFromRevisionValue: number,
  actorValue: MemoryBlockActor
): MemoryBlockRecord {
  const expectedRevision = checkedPositiveInteger(expectedRevisionValue, "expectedRevision");
  const restoredFromRevision = checkedPositiveInteger(
    restoredFromRevisionValue,
    "restoredFromRevision"
  );
  const actor = checkedActor(actorValue);
  const db = getDb();

  return db.transaction((): MemoryBlockRecord => {
    const current = currentRow(id);
    if (!current) throw new MemoryBlockNotFoundError(`memory block ${id} not found`);
    if (current.current_revision !== expectedRevision) conflict(expectedRevision, id);
    if (restoredFromRevision >= expectedRevision) {
      throw new MemoryBlockValidationError("restore source must be an earlier revision");
    }
    const targetRow = db
      .prepare(`${REVISION_SELECT} WHERE b.id = ? AND r.revision = ?`)
      .get(id, restoredFromRevision) as MemoryBlockRow | undefined;
    if (!targetRow) {
      throw new MemoryBlockNotFoundError(
        `memory block ${id} revision ${restoredFromRevision} not found`
      );
    }
    const currentRecord = recordFromRow(current);
    const target = recordFromRow(targetRow);
    assertIdentityUnchanged(currentRecord.document, target.document);
    authorizeRevision(currentRecord.document, actor);

    const revision = expectedRevision + 1;
    checkedPositiveInteger(revision, "next revision");
    const now = new Date().toISOString();
    insertRevision(
      id,
      revision,
      "restore",
      target.document,
      actor,
      restoredFromRevision,
      now,
      targetRow.snapshot_json
    );
    const result = db
      .prepare(
        `UPDATE memory_blocks SET current_revision = ?, updated_at = ?
         WHERE id = ? AND current_revision = ?`
      )
      .run(revision, now, id, expectedRevision);
    if (result.changes !== 1) conflict(expectedRevision, id);

    return {
      id,
      revision,
      document: target.document,
      operation: "restore",
      actor,
      restoredFromRevision,
      createdAt: current.created_at,
      updatedAt: now,
    };
  })();
}
