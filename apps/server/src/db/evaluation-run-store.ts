import { createHash } from "node:crypto";
import {
  evaluationRunCaseResultSchema,
  parseEvaluationRunReport,
  serializeEvaluationRunReport,
  type EvaluationRunReport,
} from "@chvor/shared";
import { getDb } from "./database.ts";

export type { EvaluationRunReport } from "@chvor/shared";

export const EVALUATION_RUN_PAGE_MAX = 20;
export const EVALUATION_RUN_CASE_PAGE_MAX = 20;
const COMPARISON_RUN_MAX = 20;

type RunCase = EvaluationRunReport["cases"][number];
type CaseSnapshot = RunCase["snapshot"];
type CaseUsage = RunCase["observation"]["usage"];
type CaseAssertion = RunCase["assertions"][number];

export interface EvaluationRunListCursor {
  completedAt: string;
  id: string;
}

export interface EvaluationRunListRecord {
  id: string;
  schemaVersion: number;
  engine: string;
  provider: string;
  model: string;
  status: EvaluationRunReport["status"];
  passed: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  configSha256: string;
  reportSha256: string;
  caseCount: number;
  passedCaseCount: number;
  failedCaseCount: number;
  assertionCount: number;
  passedAssertionCount: number;
  failedAssertionCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  totalLatencyMs: number;
}

export interface EvaluationRunPage {
  runs: EvaluationRunListRecord[];
  nextCursor: EvaluationRunListCursor | null;
}

export interface EvaluationRunCaseRecord {
  runId: string;
  position: number;
  status: RunCase["observation"]["status"];
  passed: boolean;
  sourceCaseId: string | null;
  sourceCaseRevision: number | null;
  caseSnapshot: CaseSnapshot;
  caseSha256: string;
  result: RunCase;
  assertions: CaseAssertion[];
  assertionCount: number;
  passedAssertionCount: number;
  failedAssertionCount: number;
  usage: CaseUsage;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
}

export interface EvaluationRunCasePage {
  cases: EvaluationRunCaseRecord[];
  nextCursor: number | null;
}

export class EvaluationRunCorruptionError extends Error {}

interface EvaluationRunRow {
  id: string;
  schema_version: number;
  engine: string;
  provider: string;
  model: string;
  status: EvaluationRunReport["status"];
  passed: number;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  config_snapshot?: string;
  config_sha256: string;
  report_metadata?: string;
  report_sha256: string;
  case_count: number;
  passed_case_count: number;
  failed_case_count: number;
  assertion_count: number;
  passed_assertion_count: number;
  failed_assertion_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  total_latency_ms: number;
}

interface EvaluationRunCaseRow {
  run_id: string;
  position: number;
  status: RunCase["observation"]["status"];
  passed: number;
  source_case_id: string | null;
  source_case_revision: number | null;
  case_snapshot: string;
  case_sha256: string;
  result: string;
  assertions: string;
  assertion_count: number;
  passed_assertion_count: number;
  failed_assertion_count: number;
  usage: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  latency_ms: number;
}

interface RunAggregates {
  passedCases: number;
  assertions: number;
  passedAssertions: number;
  inputTokens: number;
  outputTokens: number;
}

function sortedJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = sortedJsonValue((value as Record<string, unknown>)[key]);
  }
  return result;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortedJsonValue(value))}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reportObject(report: EvaluationRunReport): Record<string, unknown> {
  return JSON.parse(serializeEvaluationRunReport(report)) as Record<string, unknown>;
}

function reportDurationMs(report: EvaluationRunReport): number {
  return Math.max(0, Math.round(Date.parse(report.completedAt) - Date.parse(report.startedAt)));
}

function reportAggregates(report: EvaluationRunReport): RunAggregates {
  return report.cases.reduce<RunAggregates>(
    (total, result) => ({
      passedCases: total.passedCases + Number(result.passed),
      assertions: total.assertions + result.assertions.length,
      passedAssertions:
        total.passedAssertions +
        result.assertions.filter((assertion) => assertion.status === "passed").length,
      inputTokens: total.inputTokens + (result.observation.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (result.observation.usage?.outputTokens ?? 0),
    }),
    { passedCases: 0, assertions: 0, passedAssertions: 0, inputTokens: 0, outputTokens: 0 }
  );
}

function checkedLimit(limit: number, maximum: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`limit must be between 1 and ${maximum}`);
  }
  return limit;
}

function checkedRunCursor(cursor?: EvaluationRunListCursor): EvaluationRunListCursor | undefined {
  if (cursor === undefined) return undefined;
  if (
    typeof cursor.id !== "string" ||
    cursor.id.length < 1 ||
    cursor.id.length > 256 ||
    typeof cursor.completedAt !== "string" ||
    !Number.isFinite(Date.parse(cursor.completedAt))
  ) {
    throw new RangeError("cursor requires a 1-256 character id and valid completedAt timestamp");
  }
  return cursor;
}

function runListRecord(row: EvaluationRunRow): EvaluationRunListRecord {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    engine: row.engine,
    provider: row.provider,
    model: row.model,
    status: row.status,
    passed: row.passed === 1,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    configSha256: row.config_sha256,
    reportSha256: row.report_sha256,
    caseCount: row.case_count,
    passedCaseCount: row.passed_case_count,
    failedCaseCount: row.failed_case_count,
    assertionCount: row.assertion_count,
    passedAssertionCount: row.passed_assertion_count,
    failedAssertionCount: row.failed_assertion_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    totalLatencyMs: row.total_latency_ms,
  };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new EvaluationRunCorruptionError(`corrupt ${label}`, { cause: error });
  }
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EvaluationRunCorruptionError(`corrupt ${label}: expected an object`);
  }
  return parsed as Record<string, unknown>;
}

function parseCaseRow(row: EvaluationRunCaseRow): EvaluationRunCaseRecord {
  const label = `evaluation case result ${row.run_id}/${row.position}`;
  const parsed = parseObject(row.result, label);
  const validated = evaluationRunCaseResultSchema.safeParse(parsed);
  if (!validated.success) {
    throw new EvaluationRunCorruptionError(`corrupt ${label}`, {
      cause: validated.error,
    });
  }
  const result = validated.data;
  const snapshotJson = canonicalJson(result.snapshot);
  const assertionsJson = canonicalJson(result.assertions);
  const usageJson = canonicalJson(result.observation?.usage);
  const passedAssertions = result.assertions.filter(
    (assertion) => assertion.status === "passed"
  ).length;
  const usage = result.observation.usage;
  if (
    canonicalJson(parseJson(row.case_snapshot, "evaluation case snapshot")) !== snapshotJson ||
    row.case_sha256 !== result.snapshot?.documentHash ||
    canonicalJson(parseJson(row.assertions, "evaluation case assertions")) !== assertionsJson ||
    canonicalJson(parseJson(row.usage, "evaluation case usage")) !== usageJson ||
    row.position !== result.position ||
    row.status !== result.observation?.status ||
    row.passed !== Number(result.passed) ||
    row.source_case_id !== result.snapshot.caseId ||
    row.source_case_revision !== result.snapshot.revision ||
    row.assertion_count !== result.assertions.length ||
    row.passed_assertion_count !== passedAssertions ||
    row.failed_assertion_count !== result.assertions.length - passedAssertions ||
    row.input_tokens !== (usage?.inputTokens ?? 0) ||
    row.output_tokens !== (usage?.outputTokens ?? 0) ||
    row.cost_usd !== result.observation.costUsd ||
    row.latency_ms !== result.observation.latencyMs
  ) {
    throw new EvaluationRunCorruptionError(
      `corrupt evaluation case indexed data ${row.run_id}/${row.position}`
    );
  }
  return {
    runId: row.run_id,
    position: row.position,
    status: row.status,
    passed: row.passed === 1,
    sourceCaseId: row.source_case_id,
    sourceCaseRevision: row.source_case_revision,
    caseSnapshot: result.snapshot,
    caseSha256: row.case_sha256,
    result,
    assertions: result.assertions,
    assertionCount: row.assertion_count,
    passedAssertionCount: row.passed_assertion_count,
    failedAssertionCount: row.failed_assertion_count,
    usage: result.observation.usage,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms,
  };
}

function assertRunIndexMatchesReport(row: EvaluationRunRow, report: EvaluationRunReport): void {
  const aggregate = reportAggregates(report);
  if (
    row.id !== report.id ||
    row.schema_version !== report.schemaVersion ||
    row.engine !== report.configuration.engineId ||
    row.provider !== report.configuration.providerId ||
    row.model !== report.configuration.modelId ||
    row.status !== report.status ||
    row.passed !== Number(report.passed) ||
    row.started_at !== report.startedAt ||
    row.completed_at !== report.completedAt ||
    row.duration_ms !== reportDurationMs(report) ||
    row.config_sha256 !== report.configurationHash ||
    row.case_count !== report.cases.length ||
    row.passed_case_count !== aggregate.passedCases ||
    row.failed_case_count !== report.cases.length - aggregate.passedCases ||
    row.assertion_count !== aggregate.assertions ||
    row.passed_assertion_count !== aggregate.passedAssertions ||
    row.failed_assertion_count !== aggregate.assertions - aggregate.passedAssertions ||
    row.input_tokens !== aggregate.inputTokens ||
    row.output_tokens !== aggregate.outputTokens ||
    row.cost_usd !== report.summary.totalCostUsd ||
    row.total_latency_ms !== report.summary.totalLatencyMs
  ) {
    throw new EvaluationRunCorruptionError(`corrupt evaluation run indexed data ${report.id}`);
  }
}

const RUN_LIST_COLUMNS = `id, schema_version, engine, provider, model, status, passed,
  started_at, completed_at, duration_ms, config_sha256, report_sha256, case_count,
  passed_case_count, failed_case_count, assertion_count, passed_assertion_count,
  failed_assertion_count, input_tokens, output_tokens, cost_usd, total_latency_ms`;

const CASE_COLUMNS = `run_id, position, status, passed, source_case_id, source_case_revision,
  case_snapshot, case_sha256, result, assertions, assertion_count, passed_assertion_count,
  failed_assertion_count, usage, input_tokens, output_tokens, cost_usd, latency_ms`;

/** Atomically persist one validated, completed report and all of its case results. */
export function insertEvaluationRun(report: unknown): EvaluationRunReport {
  const normalized = parseEvaluationRunReport(report);
  const fullReportJson = serializeEvaluationRunReport(normalized);
  const configJson = canonicalJson(normalized.configuration);
  const metadata = reportObject(normalized);
  delete metadata.cases;
  const metadataJson = canonicalJson(metadata);
  const aggregate = reportAggregates(normalized);
  const db = getDb();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO evaluation_runs (
         id, schema_version, engine, provider, model, status, passed, started_at, completed_at,
         duration_ms, config_snapshot, config_sha256, report_metadata, report_sha256,
         case_count, passed_case_count, failed_case_count, assertion_count,
         passed_assertion_count, failed_assertion_count, input_tokens, output_tokens,
         cost_usd, total_latency_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      normalized.id,
      normalized.schemaVersion,
      normalized.configuration.engineId,
      normalized.configuration.providerId,
      normalized.configuration.modelId,
      normalized.status,
      Number(normalized.passed),
      normalized.startedAt,
      normalized.completedAt,
      reportDurationMs(normalized),
      configJson,
      normalized.configurationHash,
      metadataJson,
      sha256(fullReportJson),
      normalized.cases.length,
      aggregate.passedCases,
      normalized.cases.length - aggregate.passedCases,
      aggregate.assertions,
      aggregate.passedAssertions,
      aggregate.assertions - aggregate.passedAssertions,
      aggregate.inputTokens,
      aggregate.outputTokens,
      normalized.summary.totalCostUsd,
      normalized.summary.totalLatencyMs
    );

    const insertCase = db.prepare(
      `INSERT INTO evaluation_run_cases (
         run_id, position, status, passed, source_case_id, source_case_revision,
         case_snapshot, case_sha256, result, assertions, assertion_count,
         passed_assertion_count, failed_assertion_count, usage, input_tokens,
         output_tokens, cost_usd, latency_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const result of normalized.cases) {
      const passedAssertions = result.assertions.filter(
        (assertion) => assertion.status === "passed"
      ).length;
      insertCase.run(
        normalized.id,
        result.position,
        result.observation.status,
        Number(result.passed),
        result.snapshot.caseId,
        result.snapshot.revision,
        canonicalJson(result.snapshot),
        result.snapshot.documentHash,
        canonicalJson(result),
        canonicalJson(result.assertions),
        result.assertions.length,
        passedAssertions,
        result.assertions.length - passedAssertions,
        canonicalJson(result.observation.usage),
        result.observation.usage?.inputTokens ?? 0,
        result.observation.usage?.outputTokens ?? 0,
        result.observation.costUsd,
        result.observation.latencyMs
      );
    }
  })();
  return normalized;
}

/** Load and verify a complete report. Prefer bounded list/case APIs for browsing. */
export function getEvaluationRun(id: string): EvaluationRunReport | null {
  const db = getDb();
  const run = db
    .prepare(
      `SELECT ${RUN_LIST_COLUMNS}, config_snapshot, report_metadata
         FROM evaluation_runs WHERE id = ?`
    )
    .get(id) as EvaluationRunRow | undefined;
  if (!run || !run.report_metadata || !run.config_snapshot) return null;
  const cases = db
    .prepare(`SELECT ${CASE_COLUMNS} FROM evaluation_run_cases WHERE run_id = ? ORDER BY position`)
    .all(id) as EvaluationRunCaseRow[];
  if (cases.length !== run.case_count || cases.some((row, index) => row.position !== index)) {
    throw new EvaluationRunCorruptionError(`corrupt evaluation run case sequence ${id}`);
  }

  const metadata = parseObject(run.report_metadata, `evaluation report metadata ${id}`);
  metadata.cases = cases.map((row) => parseCaseRow(row).result);
  let report: EvaluationRunReport;
  try {
    report = parseEvaluationRunReport(metadata);
  } catch (error) {
    throw new EvaluationRunCorruptionError(`corrupt evaluation run report ${id}`, {
      cause: error,
    });
  }
  if (
    canonicalJson(parseJson(run.config_snapshot, `evaluation config ${id}`)) !==
      canonicalJson(report.configuration) ||
    sha256(serializeEvaluationRunReport(report)) !== run.report_sha256
  ) {
    throw new EvaluationRunCorruptionError(`corrupt evaluation report hash ${id}`);
  }
  assertRunIndexMatchesReport(run, report);
  return report;
}

/** Check local identity without loading report JSON. */
export function evaluationRunExists(id: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM evaluation_runs WHERE id = ?").get(id));
}

/** Read one normalized case row without reconstructing the complete report. */
export function getEvaluationRunCase(
  runId: string,
  position: number
): EvaluationRunCaseRecord | null {
  if (!Number.isSafeInteger(position) || position < 0 || position > 99) return null;
  const row = getDb()
    .prepare(`SELECT ${CASE_COLUMNS} FROM evaluation_run_cases WHERE run_id = ? AND position = ?`)
    .get(runId, position) as EvaluationRunCaseRow | undefined;
  return row ? parseCaseRow(row) : null;
}

/** List run summaries only; no config, report, case, assertion, or usage JSON is loaded. */
export function listEvaluationRuns(
  limit = EVALUATION_RUN_PAGE_MAX,
  cursor?: EvaluationRunListCursor
): EvaluationRunPage {
  const boundedLimit = checkedLimit(limit, EVALUATION_RUN_PAGE_MAX);
  const boundedCursor = checkedRunCursor(cursor);
  const rows = boundedCursor
    ? (getDb()
        .prepare(
          `SELECT ${RUN_LIST_COLUMNS} FROM evaluation_runs
            WHERE completed_at < ? OR (completed_at = ? AND id < ?)
            ORDER BY completed_at DESC, id DESC LIMIT ?`
        )
        .all(
          boundedCursor.completedAt,
          boundedCursor.completedAt,
          boundedCursor.id,
          boundedLimit + 1
        ) as EvaluationRunRow[])
    : (getDb()
        .prepare(
          `SELECT ${RUN_LIST_COLUMNS} FROM evaluation_runs
            ORDER BY completed_at DESC, id DESC LIMIT ?`
        )
        .all(boundedLimit + 1) as EvaluationRunRow[]);
  const pageRows = rows.slice(0, boundedLimit);
  const last = pageRows.at(-1);
  return {
    runs: pageRows.map(runListRecord),
    nextCursor:
      rows.length > boundedLimit && last ? { completedAt: last.completed_at, id: last.id } : null,
  };
}

/** List case details in stable ascending position order, bounded to 20 rows. */
export function listEvaluationRunCases(
  runId: string,
  limit = EVALUATION_RUN_CASE_PAGE_MAX,
  afterPosition?: number
): EvaluationRunCasePage {
  const boundedLimit = checkedLimit(limit, EVALUATION_RUN_CASE_PAGE_MAX);
  if (
    afterPosition !== undefined &&
    (!Number.isSafeInteger(afterPosition) || afterPosition < 0 || afterPosition > 99)
  ) {
    throw new RangeError("case cursor must be an integer position between 0 and 99");
  }
  const rows = (
    afterPosition === undefined
      ? getDb()
          .prepare(
            `SELECT ${CASE_COLUMNS} FROM evaluation_run_cases
              WHERE run_id = ? ORDER BY position ASC LIMIT ?`
          )
          .all(runId, boundedLimit + 1)
      : getDb()
          .prepare(
            `SELECT ${CASE_COLUMNS} FROM evaluation_run_cases
              WHERE run_id = ? AND position > ? ORDER BY position ASC LIMIT ?`
          )
          .all(runId, afterPosition, boundedLimit + 1)
  ) as EvaluationRunCaseRow[];
  const pageRows = rows.slice(0, boundedLimit);
  const last = pageRows.at(-1);
  return {
    cases: pageRows.map(parseCaseRow),
    nextCursor: rows.length > boundedLimit && last ? last.position : null,
  };
}

/** Fetch bounded, metadata-only records in caller order for comparison. */
export function getEvaluationRunsForComparison(ids: readonly string[]): EvaluationRunListRecord[] {
  if (ids.length === 0) return [];
  if (ids.length > COMPARISON_RUN_MAX) {
    throw new RangeError(`comparison supports at most ${COMPARISON_RUN_MAX} runs`);
  }
  if (ids.some((id) => typeof id !== "string" || id.length < 1 || id.length > 256)) {
    throw new RangeError("comparison ids must be between 1 and 256 characters");
  }
  const uniqueIds = [...new Set(ids)];
  const rows = getDb()
    .prepare(
      `SELECT ${RUN_LIST_COLUMNS} FROM evaluation_runs
        WHERE id IN (${uniqueIds.map(() => "?").join(", ")})`
    )
    .all(...uniqueIds) as EvaluationRunRow[];
  const byId = new Map(rows.map((row) => [row.id, runListRecord(row)]));
  return ids.flatMap((id) => {
    const record = byId.get(id);
    return record ? [record] : [];
  });
}
