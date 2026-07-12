import {
  MEMORY_BLOCK_REQUEST_MAX_BYTES,
  memoryBlockCharacterCount,
  safeParseMemoryBlockDocument,
  type MemoryBlockDocumentV1,
  type MemoryBlockRecord,
} from "@chvor/shared";
import type { ConflictInfo } from "./types";

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function provenanceText(record: MemoryBlockRecord): string {
  return prettyJson(record.document.provenance);
}

export function actorText(record: MemoryBlockRecord): string {
  const { actorType, actorId } = record.actor;
  return actorId === null ? actorType : `${actorType} · ${actorId}`;
}

export function verifiedText(value: string | null): string {
  return value === null ? "Never verified" : value;
}

export function canonicalNow(): string {
  return new Date().toISOString();
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function conflictFrom(error: unknown, fallbackExpected: number): ConflictInfo | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as {
    status?: unknown;
    expectedRevision?: unknown;
    actualRevision?: unknown;
    body?: { expectedRevision?: unknown; actualRevision?: unknown };
  };
  if (candidate.status !== 409) return null;
  const expectedRevision = candidate.body?.expectedRevision ?? candidate.expectedRevision;
  const actualRevision = candidate.body?.actualRevision ?? candidate.actualRevision;
  return {
    expectedRevision: typeof expectedRevision === "number" ? expectedRevision : fallbackExpected,
    actualRevision: typeof actualRevision === "number" ? actualRevision : null,
    latestLoaded: false,
  };
}

export function validateDocument(document: unknown): MemoryBlockDocumentV1 {
  const result = safeParseMemoryBlockDocument(document);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  throw new Error(`${field}${issue?.message ?? "Invalid memory block snapshot"}`);
}

export function contentCount(content: string): number {
  return memoryBlockCharacterCount(content);
}

export function textareaValue(raw: string): string {
  return raw.replace(/\r\n|\r/g, "\n");
}

function rawIndex(raw: string, normalizedIndex: number): number {
  let normalized = 0;
  let offset = 0;
  while (offset < raw.length && normalized < normalizedIndex) {
    if (raw[offset] === "\r" && raw[offset + 1] === "\n") offset += 2;
    else offset += 1;
    normalized += 1;
  }
  return offset;
}

function localLineEnding(raw: string, offset: number): string {
  const atEdit = raw.slice(offset).match(/^(\r\n|\r|\n)/)?.[0];
  if (atEdit) return atEdit;
  const before = raw.slice(0, offset).match(/(\r\n|\r|\n)(?![\s\S]*(?:\r\n|\r|\n))/)?.[0];
  return before ?? raw.match(/\r\n|\r|\n/)?.[0] ?? "\n";
}

export function applyTextareaEdit(raw: string, nextValue: string, cursor: number): string {
  const previous = textareaValue(raw);
  let suffix = 0;
  while (
    suffix < previous.length &&
    suffix < nextValue.length &&
    nextValue.length - suffix - 1 >= cursor &&
    previous[previous.length - suffix - 1] === nextValue[nextValue.length - suffix - 1]
  ) {
    suffix += 1;
  }
  let prefix = 0;
  const previousLimit = previous.length - suffix;
  const nextLimit = nextValue.length - suffix;
  while (
    prefix < previousLimit &&
    prefix < nextLimit &&
    previous[prefix] === nextValue[prefix]
  ) {
    prefix += 1;
  }
  const start = rawIndex(raw, prefix);
  const end = rawIndex(raw, previousLimit);
  const lineEnding = localLineEnding(raw, start);
  const inserted = nextValue.slice(prefix, nextLimit).replace(/\n/g, lineEnding);
  return raw.slice(0, start) + inserted + raw.slice(end);
}

export function assertMutationSize(body: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  if (bytes > MEMORY_BLOCK_REQUEST_MAX_BYTES) {
    throw new Error(
      `Mutation request is ${bytes} bytes; the limit is ${MEMORY_BLOCK_REQUEST_MAX_BYTES} bytes.`
    );
  }
}

export function sameDocument(left: MemoryBlockDocumentV1, right: MemoryBlockDocumentV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
