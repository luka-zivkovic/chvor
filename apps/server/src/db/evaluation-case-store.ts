import { randomUUID } from "node:crypto";
import {
  parseEvaluationCaseDocument,
  safeParseEvaluationCaseDocument,
  serializeEvaluationCaseDocument,
  type EvaluationCaseDocumentV1,
  type EvaluationCaseRecord,
} from "@chvor/shared";
import { getDb } from "./database.ts";

export type { EvaluationCaseRecord } from "@chvor/shared";

export class EvaluationCaseNotFoundError extends Error {}

export class EvaluationCaseRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `evaluation case revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}`
    );
  }
}

interface EvaluationCaseRow {
  id: string;
  revision: number;
  document_json: string;
  created_at: string;
  updated_at: string;
}

export const EVALUATION_CASE_PAGE_MAX = 20;

export interface EvaluationCaseListCursor {
  updatedAt: string;
  id: string;
}

export interface EvaluationCasePage {
  records: EvaluationCaseRecord[];
  nextCursor: EvaluationCaseListCursor | null;
}

export interface EvaluationCaseRevisionPage {
  revisions: EvaluationCaseRecord[];
  nextCursor: number | null;
}

function pageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVALUATION_CASE_PAGE_MAX) {
    throw new RangeError(`limit must be between 1 and ${EVALUATION_CASE_PAGE_MAX}`);
  }
  return limit;
}

function parseDocument(value: string, id: string, revision: number): EvaluationCaseDocumentV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`corrupt evaluation case ${id} revision ${revision}: invalid JSON`, {
      cause: error,
    });
  }
  const result = safeParseEvaluationCaseDocument(parsed);
  if (!result.success) {
    throw new Error(`corrupt evaluation case ${id} revision ${revision}: invalid document`, {
      cause: result.error,
    });
  }
  return result.data;
}

function recordFromRow(row: EvaluationCaseRow): EvaluationCaseRecord {
  return {
    id: row.id,
    revision: row.revision,
    document: parseDocument(row.document_json, row.id, row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizedDocument(document: unknown): EvaluationCaseDocumentV1 {
  return parseEvaluationCaseDocument(document);
}

/** Stable portable JSON: normalized document, recursively sorted object keys, final newline. */
export function canonicalEvaluationCaseJson(document: unknown): string {
  return serializeEvaluationCaseDocument(document);
}

export function createEvaluationCase(document: unknown): EvaluationCaseRecord {
  const normalized = normalizedDocument(document);
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO evaluation_cases (id, current_revision, created_at, updated_at)
       VALUES (?, 1, ?, ?)`
    ).run(id, now, now);
    db.prepare(
      `INSERT INTO evaluation_case_revisions (case_id, revision, document, created_at)
       VALUES (?, 1, ?, ?)`
    ).run(id, JSON.stringify(normalized), now);
  })();

  return { id, revision: 1, document: normalized, createdAt: now, updatedAt: now };
}

export function getEvaluationCase(id: string): EvaluationCaseRecord | null {
  const row = getDb()
    .prepare(
      `SELECT c.id, c.current_revision AS revision, r.document AS document_json,
              c.created_at, c.updated_at
         FROM evaluation_cases c
         JOIN evaluation_case_revisions r
           ON r.case_id = c.id AND r.revision = c.current_revision
        WHERE c.id = ?`
    )
    .get(id) as EvaluationCaseRow | undefined;
  return row ? recordFromRow(row) : null;
}

export function listEvaluationCases(
  limit = EVALUATION_CASE_PAGE_MAX,
  cursor?: EvaluationCaseListCursor
): EvaluationCasePage {
  const boundedLimit = pageLimit(limit);
  const db = getDb();
  const select = `SELECT c.id, c.current_revision AS revision, r.document AS document_json,
                         c.created_at, c.updated_at
                    FROM evaluation_cases c
                    JOIN evaluation_case_revisions r
                      ON r.case_id = c.id AND r.revision = c.current_revision`;
  const rows = cursor
    ? (db
        .prepare(
          `${select}
             WHERE c.updated_at < ? OR (c.updated_at = ? AND c.id < ?)
             ORDER BY c.updated_at DESC, c.id DESC
             LIMIT ?`
        )
        .all(
          cursor.updatedAt,
          cursor.updatedAt,
          cursor.id,
          boundedLimit + 1
        ) as EvaluationCaseRow[])
    : (db
        .prepare(
          `${select}
             ORDER BY c.updated_at DESC, c.id DESC
             LIMIT ?`
        )
        .all(boundedLimit + 1) as EvaluationCaseRow[]);
  const pageRows = rows.slice(0, boundedLimit);
  const last = pageRows.at(-1);
  return {
    records: pageRows.map(recordFromRow),
    nextCursor:
      rows.length > boundedLimit && last ? { updatedAt: last.updated_at, id: last.id } : null,
  };
}

/** Return immutable revisions newest-first. */
export function listEvaluationCaseRevisions(
  id: string,
  limit = EVALUATION_CASE_PAGE_MAX,
  beforeRevision?: number
): EvaluationCaseRevisionPage {
  const boundedLimit = pageLimit(limit);
  if (
    beforeRevision !== undefined &&
    (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)
  ) {
    throw new RangeError("revision cursor must be a positive integer");
  }
  const db = getDb();
  const select = `SELECT c.id, r.revision, r.document AS document_json,
                         c.created_at, r.created_at AS updated_at
                    FROM evaluation_cases c
                    JOIN evaluation_case_revisions r ON r.case_id = c.id
                   WHERE c.id = ?`;
  const rows = beforeRevision
    ? (db
        .prepare(`${select} AND r.revision < ? ORDER BY r.revision DESC LIMIT ?`)
        .all(id, beforeRevision, boundedLimit + 1) as EvaluationCaseRow[])
    : (db
        .prepare(`${select} ORDER BY r.revision DESC LIMIT ?`)
        .all(id, boundedLimit + 1) as EvaluationCaseRow[]);
  const pageRows = rows.slice(0, boundedLimit);
  const last = pageRows.at(-1);
  return {
    revisions: pageRows.map(recordFromRow),
    nextCursor: rows.length > boundedLimit && last ? last.revision : null,
  };
}

export function updateEvaluationCase(
  id: string,
  expectedRevision: number,
  document: unknown
): EvaluationCaseRecord {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new RangeError("expectedRevision must be a positive integer");
  }
  const normalized = normalizedDocument(document);
  const db = getDb();

  return db.transaction(() => {
    const current = db
      .prepare("SELECT current_revision, created_at FROM evaluation_cases WHERE id = ?")
      .get(id) as { current_revision: number; created_at: string } | undefined;
    if (!current) throw new EvaluationCaseNotFoundError(`evaluation case ${id} not found`);
    if (current.current_revision !== expectedRevision) {
      throw new EvaluationCaseRevisionConflictError(expectedRevision, current.current_revision);
    }

    const revision = expectedRevision + 1;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO evaluation_case_revisions (case_id, revision, document, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(id, revision, JSON.stringify(normalized), now);
    const updated = db
      .prepare(
        `UPDATE evaluation_cases
            SET current_revision = ?, updated_at = ?
          WHERE id = ? AND current_revision = ?`
      )
      .run(revision, now, id, expectedRevision);
    if (updated.changes !== 1) {
      const actual = db
        .prepare("SELECT current_revision FROM evaluation_cases WHERE id = ?")
        .get(id) as { current_revision: number } | undefined;
      throw new EvaluationCaseRevisionConflictError(
        expectedRevision,
        actual?.current_revision ?? expectedRevision
      );
    }

    return {
      id,
      revision,
      document: normalized,
      createdAt: current.created_at,
      updatedAt: now,
    };
  })();
}

export function exportEvaluationCase(id: string): string | null {
  const record = getEvaluationCase(id);
  return record ? canonicalEvaluationCaseJson(record.document) : null;
}
