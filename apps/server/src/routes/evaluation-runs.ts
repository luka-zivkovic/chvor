import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { EVALUATION_RUN_MAX_BYTES, redactTrajectoryText } from "@chvor/shared";
import {
  EVALUATION_RUN_CASE_PAGE_MAX,
  EVALUATION_RUN_PAGE_MAX,
  evaluationRunExists,
  getEvaluationRunCase,
  getEvaluationRun,
  insertEvaluationRun,
  listEvaluationRunCases,
  listEvaluationRuns,
  type EvaluationRunListCursor,
} from "../db/evaluation-run-store.ts";
import { compareEvaluationReports } from "../evaluation/evaluation-comparison.ts";
import {
  EvaluationCaseSelectionNotFoundError,
  EvaluationRunPayloadTooLargeError,
  EvaluationRunConfigurationError,
  EvaluationRunInputError,
  EvaluationToolCoverageError,
  runEvaluation,
} from "../evaluation/evaluation-runner.ts";

const routes = new Hono();
const DEFAULT_LIMIT = 10;
class EvaluationRunQueryError extends Error {}

routes.use(
  "*",
  bodyLimit({
    maxSize: EVALUATION_RUN_MAX_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: "Evaluation run payload too large" }, 413),
  })
);
routes.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

function limit(value: string | undefined, maximum: number): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(value)) throw new EvaluationRunQueryError("limit must be an integer");
  const parsed = Number(value);
  if (parsed < 1 || parsed > maximum)
    throw new EvaluationRunQueryError(`limit must be between 1 and ${maximum}`);
  return parsed;
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value })).toString("base64url");
}

function decodeCursor(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new EvaluationRunQueryError("cursor is malformed");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new EvaluationRunQueryError("cursor is malformed");
    return parsed as Record<string, unknown>;
  } catch {
    throw new EvaluationRunQueryError("cursor is malformed");
  }
}

function listCursor(value: string | undefined): EvaluationRunListCursor | undefined {
  const cursor = decodeCursor(value);
  if (!cursor) return undefined;
  if (
    cursor.v !== 1 ||
    cursor.kind !== "runs" ||
    typeof cursor.completedAt !== "string" ||
    Number.isNaN(Date.parse(cursor.completedAt)) ||
    typeof cursor.id !== "string"
  )
    throw new EvaluationRunQueryError("cursor is malformed");
  return { completedAt: cursor.completedAt, id: cursor.id };
}

function caseCursor(value: string | undefined, runId: string): number | undefined {
  const cursor = decodeCursor(value);
  if (!cursor) return undefined;
  if (
    cursor.v !== 1 ||
    cursor.kind !== "cases" ||
    cursor.runId !== runId ||
    !Number.isSafeInteger(cursor.position)
  ) {
    throw new EvaluationRunQueryError("cursor is malformed");
  }
  return cursor.position as number;
}

routes.post("/", async (c) => {
  try {
    const input = await c.req.json();
    const report = await runEvaluation(input, c.req.raw.signal);
    insertEvaluationRun(report);
    return c.json({ data: { report } }, 201);
  } catch (error) {
    if (error instanceof EvaluationCaseSelectionNotFoundError) {
      return c.json({ error: "Evaluation case not found", detail: error.message }, 404);
    }
    if (error instanceof EvaluationRunPayloadTooLargeError) {
      return c.json({ error: "Evaluation run dataset too large" }, 413);
    }
    if (
      error instanceof EvaluationRunConfigurationError ||
      error instanceof EvaluationRunInputError
    ) {
      return c.json(
        {
          error: "Invalid evaluation run configuration",
          detail: redactTrajectoryText(error.message).slice(0, 2_000),
        },
        400
      );
    }
    if (
      error instanceof EvaluationToolCoverageError ||
      error instanceof ZodError ||
      error instanceof SyntaxError
    ) {
      return c.json(
        {
          error: "Invalid evaluation run",
          detail: redactTrajectoryText(error.message).slice(0, 2_000),
        },
        400
      );
    }
    throw error;
  }
});

routes.get("/", (c) => {
  try {
    const page = listEvaluationRuns(
      limit(c.req.query("limit"), EVALUATION_RUN_PAGE_MAX),
      listCursor(c.req.query("cursor"))
    );
    return c.json({
      data: {
        runs: page.runs,
        nextCursor: page.nextCursor ? encodeCursor({ kind: "runs", ...page.nextCursor }) : null,
      },
    });
  } catch (error) {
    if (!(error instanceof EvaluationRunQueryError) && !(error instanceof RangeError)) throw error;
    return c.json(
      {
        error: "Invalid evaluation run query",
        detail: error instanceof Error ? error.message : "invalid query",
      },
      400
    );
  }
});

routes.get("/compare", (c) => {
  const baselineId = c.req.query("baseline");
  const candidateId = c.req.query("candidate");
  if (!baselineId || !candidateId)
    return c.json({ error: "baseline and candidate are required" }, 400);
  const baseline = getEvaluationRun(baselineId);
  const candidate = getEvaluationRun(candidateId);
  if (!baseline || !candidate) return c.json({ error: "Evaluation run not found" }, 404);
  try {
    const comparison = compareEvaluationReports(baseline, candidate);
    const maximum = limit(c.req.query("limit"), EVALUATION_RUN_CASE_PAGE_MAX);
    const cursor = decodeCursor(c.req.query("cursor"));
    let position = 0;
    if (cursor) {
      if (
        cursor.v !== 1 ||
        cursor.kind !== "comparison" ||
        cursor.baseline !== baselineId ||
        cursor.candidate !== candidateId ||
        !Number.isSafeInteger(cursor.position) ||
        (cursor.position as number) < 0
      )
        throw new EvaluationRunQueryError("cursor is malformed");
      position = cursor.position as number;
    }
    const rows = comparison.rows.slice(position, position + maximum);
    const next = position + rows.length;
    return c.json({
      data: {
        ...comparison,
        rows,
        nextCursor:
          next < comparison.rows.length
            ? encodeCursor({
                kind: "comparison",
                baseline: baselineId,
                candidate: candidateId,
                position: next,
              })
            : null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid comparison";
    if (!(error instanceof EvaluationRunQueryError) && !message.includes("completed")) throw error;
    return c.json(
      {
        error: message.includes("completed")
          ? "Evaluation runs are not comparable"
          : "Invalid comparison query",
        detail: message,
      },
      message.includes("completed") ? 409 : 400
    );
  }
});

routes.get("/:id/cases", (c) => {
  const runId = c.req.param("id");
  if (!evaluationRunExists(runId)) return c.json({ error: "Evaluation run not found" }, 404);
  try {
    const page = listEvaluationRunCases(
      runId,
      limit(c.req.query("limit"), EVALUATION_RUN_CASE_PAGE_MAX),
      caseCursor(c.req.query("cursor"), runId)
    );
    return c.json({
      data: {
        cases: page.cases,
        nextCursor:
          page.nextCursor === null
            ? null
            : encodeCursor({ kind: "cases", runId, position: page.nextCursor }),
      },
    });
  } catch (error) {
    if (!(error instanceof EvaluationRunQueryError) && !(error instanceof RangeError)) throw error;
    return c.json(
      {
        error: "Invalid evaluation run query",
        detail: error instanceof Error ? error.message : "invalid query",
      },
      400
    );
  }
});

routes.get("/:id/cases/:position", (c) => {
  const runId = c.req.param("id");
  if (!evaluationRunExists(runId)) return c.json({ error: "Evaluation run not found" }, 404);
  if (!/^\d+$/.test(c.req.param("position")))
    return c.json({ error: "Invalid case position" }, 400);
  const result = getEvaluationRunCase(runId, Number(c.req.param("position")))?.result;
  return result
    ? c.json({ data: { result } })
    : c.json({ error: "Evaluation case result not found" }, 404);
});

routes.get("/:id", (c) => {
  const report = getEvaluationRun(c.req.param("id"));
  return report ? c.json({ data: { report } }) : c.json({ error: "Evaluation run not found" }, 404);
});

export default routes;
