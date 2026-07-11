import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import {
  EVALUATION_CASE_DOCUMENT_MAX_BYTES,
  evaluationCaseUpdateSchema,
  redactTrajectoryText,
} from "@chvor/shared";
import {
  createEvaluationCase,
  EVALUATION_CASE_PAGE_MAX,
  EvaluationCaseNotFoundError,
  EvaluationCaseRevisionConflictError,
  exportEvaluationCase,
  getEvaluationCase,
  listEvaluationCaseRevisions,
  listEvaluationCases,
  updateEvaluationCase,
  type EvaluationCaseListCursor,
} from "../db/evaluation-case-store.ts";

const evaluationCases = new Hono();
export const EVALUATION_CASE_REQUEST_MAX_BYTES = EVALUATION_CASE_DOCUMENT_MAX_BYTES + 64 * 1024;
const DEFAULT_PAGE_LIMIT = 10;

class EvaluationCaseQueryError extends Error {}

evaluationCases.use(
  "*",
  bodyLimit({
    maxSize: EVALUATION_CASE_REQUEST_MAX_BYTES,
    onError: (c) => c.json({ error: "Evaluation case payload too large" }, 413),
  })
);

evaluationCases.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

function validId(id: string): boolean {
  return id.length > 0 && id.length <= 256;
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof Error && error.name === "BodyLimitError") throw error;
    throw new SyntaxError("request body must be valid JSON");
  }
}

function rethrowBodyLimit(error: unknown): void {
  if (error instanceof Error && error.name === "BodyLimitError") throw error;
}

function isClientValidationError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof ZodError;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!/^\d+$/.test(value)) throw new EvaluationCaseQueryError("limit must be an integer");
  const limit = Number(value);
  if (limit < 1 || limit > EVALUATION_CASE_PAGE_MAX) {
    throw new EvaluationCaseQueryError(`limit must be between 1 and ${EVALUATION_CASE_PAGE_MAX}`);
  }
  return limit;
}

function encodedCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
}

function parsedCursor(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new EvaluationCaseQueryError("cursor is malformed");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid cursor shape");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new EvaluationCaseQueryError("cursor is malformed");
  }
}

function parseListCursor(value: string | undefined): EvaluationCaseListCursor | undefined {
  const cursor = parsedCursor(value);
  if (!cursor) return undefined;
  if (
    cursor.v !== 1 ||
    cursor.kind !== "cases" ||
    typeof cursor.updatedAt !== "string" ||
    cursor.updatedAt.length > 64 ||
    Number.isNaN(Date.parse(cursor.updatedAt)) ||
    typeof cursor.id !== "string" ||
    !validId(cursor.id) ||
    Object.keys(cursor).sort().join(",") !== "id,kind,updatedAt,v"
  ) {
    throw new EvaluationCaseQueryError("cursor is malformed");
  }
  return { updatedAt: cursor.updatedAt, id: cursor.id };
}

function parseRevisionCursor(value: string | undefined): number | undefined {
  const cursor = parsedCursor(value);
  if (!cursor) return undefined;
  if (
    cursor.v !== 1 ||
    cursor.kind !== "revisions" ||
    !Number.isSafeInteger(cursor.revision) ||
    (cursor.revision as number) < 1 ||
    Object.keys(cursor).sort().join(",") !== "kind,revision,v"
  ) {
    throw new EvaluationCaseQueryError("cursor is malformed");
  }
  return cursor.revision as number;
}

function validationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "invalid evaluation case document";
  return redactTrajectoryText(message).slice(0, 2_000);
}

evaluationCases.get("/", (c) => {
  try {
    const page = listEvaluationCases(
      parseLimit(c.req.query("limit")),
      parseListCursor(c.req.query("cursor"))
    );
    return c.json({
      data: {
        records: page.records,
        nextCursor: page.nextCursor ? encodedCursor({ kind: "cases", ...page.nextCursor }) : null,
      },
    });
  } catch (error) {
    if (error instanceof EvaluationCaseQueryError) {
      return c.json({ error: "Invalid evaluation case query", detail: error.message }, 400);
    }
    throw error;
  }
});

evaluationCases.post("/", async (c) => {
  try {
    const body = await readJson(c);
    const object = objectBody(body);
    const document = object && "document" in object ? object.document : body;
    const record = createEvaluationCase(document);
    return c.json({ data: { evaluationCase: record } }, 201);
  } catch (error) {
    rethrowBodyLimit(error);
    if (isClientValidationError(error)) {
      return c.json({ error: "Invalid evaluation case", detail: validationMessage(error) }, 400);
    }
    throw error;
  }
});

evaluationCases.post("/import", async (c) => {
  try {
    const document = await readJson(c);
    const record = createEvaluationCase(document);
    return c.json({ data: { evaluationCase: record } }, 201);
  } catch (error) {
    rethrowBodyLimit(error);
    if (isClientValidationError(error)) {
      return c.json(
        { error: "Invalid evaluation case import", detail: validationMessage(error) },
        400
      );
    }
    throw error;
  }
});

evaluationCases.get("/:id/revisions", (c) => {
  const id = c.req.param("id");
  if (!validId(id)) return c.json({ error: "Invalid evaluation case ID" }, 400);
  if (!getEvaluationCase(id)) return c.json({ error: "Evaluation case not found" }, 404);
  try {
    const page = listEvaluationCaseRevisions(
      id,
      parseLimit(c.req.query("limit")),
      parseRevisionCursor(c.req.query("cursor"))
    );
    return c.json({
      data: {
        revisions: page.revisions,
        nextCursor: page.nextCursor
          ? encodedCursor({ kind: "revisions", revision: page.nextCursor })
          : null,
      },
    });
  } catch (error) {
    if (error instanceof EvaluationCaseQueryError) {
      return c.json({ error: "Invalid evaluation case query", detail: error.message }, 400);
    }
    throw error;
  }
});

evaluationCases.get("/:id/export", (c) => {
  const id = c.req.param("id");
  if (!validId(id)) return c.json({ error: "Invalid evaluation case ID" }, 400);
  const json = exportEvaluationCase(id);
  if (json === null) return c.json({ error: "Evaluation case not found" }, 404);
  return new Response(json, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="evaluation-case-${id}.json"`,
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

evaluationCases.get("/:id", (c) => {
  const id = c.req.param("id");
  if (!validId(id)) return c.json({ error: "Invalid evaluation case ID" }, 400);
  const record = getEvaluationCase(id);
  if (!record) return c.json({ error: "Evaluation case not found" }, 404);
  return c.json({ data: { evaluationCase: record } });
});

evaluationCases.put("/:id", async (c) => {
  const id = c.req.param("id");
  if (!validId(id)) return c.json({ error: "Invalid evaluation case ID" }, 400);
  try {
    const update = evaluationCaseUpdateSchema.parse(await readJson(c));
    const record = updateEvaluationCase(id, update.expectedRevision, update.document);
    return c.json({ data: { evaluationCase: record } });
  } catch (error) {
    rethrowBodyLimit(error);
    if (error instanceof EvaluationCaseNotFoundError) {
      return c.json({ error: "Evaluation case not found" }, 404);
    }
    if (error instanceof EvaluationCaseRevisionConflictError) {
      return c.json(
        {
          error: "Evaluation case revision conflict",
          detail: error.message,
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        },
        409
      );
    }
    if (isClientValidationError(error)) {
      return c.json(
        { error: "Invalid evaluation case update", detail: validationMessage(error) },
        400
      );
    }
    throw error;
  }
});

export default evaluationCases;
