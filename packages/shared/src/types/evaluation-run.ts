import { z } from "zod";
import { evaluationCaseDocumentV1Schema, evaluationCaseStatusSchema } from "./evaluation-case.js";
import {
  redactTrajectoryText,
  trajectoryValueSchema,
  type TrajectoryJsonValue,
} from "./trajectory.js";

export const EVALUATION_RUN_SCHEMA_VERSION = 1 as const;
export const EVALUATION_RUN_MAX_CASES = 100 as const;
export const EVALUATION_COMPARISON_MAX_ROWS = EVALUATION_RUN_MAX_CASES * 2;
export const EVALUATION_RUN_MAX_BYTES = 8 * 1024 * 1024;
export const evaluationProviderIdSchema = z.enum([
  "anthropic",
  "google",
  "openai",
  "deepseek",
  "minimax",
  "openrouter",
  "groq",
  "mistral",
  "ollama-cloud",
  "ollama",
  "lmstudio",
  "vllm",
]);

const identifier = z.string().trim().min(1).max(256);
const safeIdentifier = identifier.superRefine((value, context) => {
  if (redactTrajectoryText(value) !== value) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "identifier must not contain credential-like text",
    });
  }
});
const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const safeText = (max: number) =>
  z.string().max(max).transform(redactTrajectoryText).pipe(z.string().max(max));
const safeValue = trajectoryValueSchema.transform((value) => sanitizeRunValue(value));

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sanitizeRunValue(value: TrajectoryJsonValue): TrajectoryJsonValue {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? redactTrajectoryText(value) : value;
  }
  if (Array.isArray(value)) return value.map(sanitizeRunValue);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const normalized = normalizedKey(key);
      if (
        normalized.includes("apikey") ||
        normalized.includes("accesstoken") ||
        normalized.includes("refreshtoken") ||
        normalized.includes("clientsecret") ||
        normalized === "authorization" ||
        normalized === "credential" ||
        normalized === "credentials" ||
        normalized === "password" ||
        normalized === "privatekey" ||
        normalized === "secret"
      ) {
        return [key, "[REDACTED]"];
      }
      return [key, sanitizeRunValue(entry)];
    })
  );
}

function uniqueTools(
  tools: Array<z.infer<typeof evaluationToolStubSchema>>,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (seen.has(tool.name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "name"],
        message: `duplicate evaluation tool: ${tool.name}`,
      });
    }
    seen.add(tool.name);
  }
}

export const evaluationToolStubSchema = z
  .object({
    name: safeIdentifier.pipe(z.string().regex(/^[A-Za-z0-9_-]+$/)),
    description: safeText(2_000).default("Simulated evaluation tool"),
    effect: z.enum(["read", "write"]),
    approval: z.enum(["auto-approve", "auto-deny"]),
    result: safeValue,
  })
  .strict();

export const evaluationRunConfigurationSchema = z
  .object({
    engineId: z.literal("chvor-isolated-v1"),
    providerId: evaluationProviderIdSchema,
    modelId: safeIdentifier,
    prompt: safeText(64_000),
    promptHash: sha256,
    temperature: z.number().min(0).max(2).default(0),
    maxRounds: z.number().int().min(1).max(10).default(4),
    caseTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(10 * 60_000)
      .default(120_000),
    pricing: z
      .object({
        inputUsdPerMillion: z.number().nonnegative().max(1_000),
        outputUsdPerMillion: z.number().nonnegative().max(1_000),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        maxCostUsdPerCase: z.number().positive().max(10_000).optional(),
        maxLatencyMsPerCase: z
          .number()
          .int()
          .positive()
          .max(60 * 60_000)
          .optional(),
      })
      .strict()
      .default({}),
    tools: z
      .array(evaluationToolStubSchema)
      .max(100)
      .superRefine(uniqueTools)
      .transform((tools) => [...tools].sort((left, right) => left.name.localeCompare(right.name))),
  })
  .strict();

export const evaluationCaseSnapshotSchema = z
  .object({
    caseId: identifier.nullable(),
    revision: z.number().int().positive().nullable(),
    documentHash: sha256,
    critical: z.boolean().default(true),
    document: evaluationCaseDocumentV1Schema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if ((snapshot.caseId === null) !== (snapshot.revision === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "caseId and revision must either both be present or both be null",
      });
    }
  });

export const evaluationToolObservationSchema = z
  .object({
    name: identifier,
    approvalRequested: z.boolean(),
    approved: z.boolean().nullable(),
    executed: z.boolean(),
  })
  .strict();

export const evaluationUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();

export const evaluationObservationSchema = z
  .object({
    status: evaluationCaseStatusSchema,
    output: safeValue.optional(),
    toolCalls: z.array(evaluationToolObservationSchema).max(1_000),
    usage: evaluationUsageSchema.nullable(),
    latencyMs: z
      .number()
      .int()
      .nonnegative()
      .max(60 * 60_000),
    costUsd: z.number().nonnegative().max(10_000).nullable(),
    error: safeText(4_000).nullable(),
  })
  .strict();

export const evaluationAssertionKindSchema = z.enum([
  "execution",
  "completion",
  "output",
  "output-contains",
  "required-tools",
  "forbidden-tools",
  "approval-behavior",
  "no-secrets",
  "unapproved-write-tools",
  "cost",
  "latency",
]);

export const evaluationAssertionResultSchema = z
  .object({
    kind: evaluationAssertionKindSchema,
    status: z.enum(["passed", "failed", "unavailable"]),
    message: safeText(2_000),
  })
  .strict();

export const evaluationRunCaseResultSchema = z
  .object({
    position: z.number().int().nonnegative(),
    snapshot: evaluationCaseSnapshotSchema,
    observation: evaluationObservationSchema,
    assertions: z.array(evaluationAssertionResultSchema).min(1).max(500),
    passed: z.boolean(),
  })
  .strict();

export const evaluationRunReportSchema = z
  .object({
    schemaVersion: z.literal(EVALUATION_RUN_SCHEMA_VERSION),
    id: identifier,
    configuration: evaluationRunConfigurationSchema,
    configurationHash: sha256,
    startedAt: timestamp,
    completedAt: timestamp,
    status: z.enum(["completed", "failed"]),
    passed: z.boolean(),
    summary: z
      .object({
        total: z.number().int().nonnegative().max(EVALUATION_RUN_MAX_CASES),
        passed: z.number().int().nonnegative().max(EVALUATION_RUN_MAX_CASES),
        failed: z.number().int().nonnegative().max(EVALUATION_RUN_MAX_CASES),
        criticalFailed: z.number().int().nonnegative().max(EVALUATION_RUN_MAX_CASES),
        totalCostUsd: z.number().nonnegative().max(1_000_000).nullable(),
        totalLatencyMs: z
          .number()
          .int()
          .nonnegative()
          .max(100 * 60 * 60_000),
      })
      .strict(),
    environment: z
      .object({
        runnerVersion: safeText(64),
        chvorVersion: safeText(64),
        sourceCommit: safeText(128).nullable(),
        nodeVersion: safeText(64),
        platform: safeText(64),
        architecture: safeText(64),
      })
      .strict(),
    cases: z.array(evaluationRunCaseResultSchema).min(1).max(EVALUATION_RUN_MAX_CASES),
    error: safeText(4_000).nullable(),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.summary.total !== report.cases.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "summary total does not match cases",
      });
    }
    const positions = report.cases.map((entry) => entry.position);
    if (positions.some((position, index) => position !== index)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "case positions must be contiguous",
      });
    }
    const passed = report.cases.filter((entry) => entry.passed).length;
    const criticalFailed = report.cases.filter(
      (entry) => entry.snapshot.critical && !entry.passed
    ).length;
    if (
      report.summary.passed !== passed ||
      report.summary.failed !== report.cases.length - passed ||
      report.summary.criticalFailed !== criticalFailed ||
      report.passed !== (criticalFailed === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "summary pass counts are inconsistent",
      });
    }
    const totalLatency = report.cases.reduce(
      (total, entry) => total + entry.observation.latencyMs,
      0
    );
    if (report.summary.totalLatencyMs !== totalLatency) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "summary latency is inconsistent" });
    }
    const costs = report.cases.map((entry) => entry.observation.costUsd);
    const expectedCost = costs.every((value): value is number => value !== null)
      ? costs.reduce((total, value) => total + value, 0)
      : null;
    if (
      (expectedCost === null) !== (report.summary.totalCostUsd === null) ||
      (expectedCost !== null &&
        Math.abs(expectedCost - (report.summary.totalCostUsd ?? 0)) > Number.EPSILON * 100)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "summary cost is inconsistent" });
    }
    if (Date.parse(report.completedAt) < Date.parse(report.startedAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "completedAt precedes startedAt" });
    }
    if (new TextEncoder().encode(JSON.stringify(report)).byteLength > EVALUATION_RUN_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `evaluation run report exceeds ${EVALUATION_RUN_MAX_BYTES} bytes`,
      });
    }
  });

export const evaluationComparisonRowSchema = z
  .object({
    position: z.number().int().nonnegative(),
    caseName: safeText(512),
    classification: z.enum([
      "unchanged-passed",
      "unchanged-failed",
      "regression",
      "improvement",
      "baseline-only",
      "candidate-only",
    ]),
    baselinePassed: z.boolean().nullable(),
    candidatePassed: z.boolean().nullable(),
    costDeltaUsd: z.number().finite().nullable(),
    latencyDeltaMs: z.number().int().nullable(),
  })
  .strict();

export const evaluationComparisonSchema = z
  .object({
    baselineRunId: identifier,
    candidateRunId: identifier,
    regressions: z.number().int().nonnegative(),
    improvements: z.number().int().nonnegative(),
    rows: z.array(evaluationComparisonRowSchema).max(EVALUATION_COMPARISON_MAX_ROWS),
  })
  .strict();

export type EvaluationRunConfiguration = z.infer<typeof evaluationRunConfigurationSchema>;
export type EvaluationCaseSnapshot = z.infer<typeof evaluationCaseSnapshotSchema>;
export type EvaluationToolObservation = z.infer<typeof evaluationToolObservationSchema>;
export type EvaluationObservation = z.infer<typeof evaluationObservationSchema>;
export type EvaluationAssertionResult = z.infer<typeof evaluationAssertionResultSchema>;
export type EvaluationRunCaseResult = z.infer<typeof evaluationRunCaseResultSchema>;
export type EvaluationRunReport = z.infer<typeof evaluationRunReportSchema>;
export type EvaluationComparison = z.infer<typeof evaluationComparisonSchema>;

export function parseEvaluationRunConfiguration(value: unknown): EvaluationRunConfiguration {
  return evaluationRunConfigurationSchema.parse(value);
}

export function parseEvaluationRunReport(value: unknown): EvaluationRunReport {
  return evaluationRunReportSchema.parse(value);
}

function sortKeys(value: TrajectoryJsonValue): TrajectoryJsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])])
  );
}

export function serializeEvaluationRunReport(value: unknown): string {
  const report = parseEvaluationRunReport(value);
  return `${JSON.stringify(sortKeys(report as unknown as TrajectoryJsonValue))}\n`;
}
