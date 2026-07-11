import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import {
  EVALUATION_RUN_MAX_BYTES,
  EVALUATION_RUN_MAX_CASES,
  evaluationRunConfigurationSchema,
  parseEvaluationRunReport,
  serializeEvaluationCaseDocument,
  type EvaluationCaseSnapshot,
  type EvaluationRunConfiguration,
  type EvaluationRunReport,
} from "@chvor/shared";
import { getEvaluationCase, getEvaluationCaseRevision } from "../db/evaluation-case-store.ts";
import { resolveCredential } from "../lib/llm-router.ts";
import { evaluateAssertions } from "./evaluation-assertions.ts";
import { evaluationMessages, UnsupportedEvaluationInputError } from "./evaluation-input.ts";
import { invokeEvaluationSidecar } from "./sidecar-client.ts";

const caseSelectionSchema = z
  .object({
    id: z.string().min(1).max(256),
    revision: z.number().int().positive().optional(),
    critical: z.boolean().default(true),
  })
  .strict();

const publicConfigurationSchema = evaluationRunConfigurationSchema.omit({ promptHash: true });

export const evaluationRunRequestSchema = z
  .object({
    cases: z.array(caseSelectionSchema).min(1).max(EVALUATION_RUN_MAX_CASES),
    configuration: publicConfigurationSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const selections = new Set<string>();
    for (const [index, selection] of request.cases.entries()) {
      const key = `${selection.id}:${selection.revision ?? "current"}`;
      if (selections.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index],
          message: "duplicate evaluation case selection",
        });
      }
      selections.add(key);
    }
  });

export type EvaluationRunRequest = z.input<typeof evaluationRunRequestSchema>;

export class EvaluationCaseSelectionNotFoundError extends Error {}
export class EvaluationToolCoverageError extends Error {}
export class EvaluationRunPayloadTooLargeError extends Error {}
export class EvaluationRunInputError extends Error {}
export class EvaluationRunConfigurationError extends Error {}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function chvorVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")
    ) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((entry) => containsString(entry, needle));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      containsString(entry, needle)
    );
  }
  return false;
}

function snapshots(selections: z.output<typeof caseSelectionSchema>[]): EvaluationCaseSnapshot[] {
  return selections.map((selection) => {
    const record = selection.revision
      ? getEvaluationCaseRevision(selection.id, selection.revision)
      : getEvaluationCase(selection.id);
    if (!record) {
      throw new EvaluationCaseSelectionNotFoundError(
        selection.revision
          ? `evaluation case ${selection.id} revision ${selection.revision} not found`
          : `evaluation case ${selection.id} not found`
      );
    }
    return {
      caseId: record.id,
      revision: record.revision,
      documentHash: hash(serializeEvaluationCaseDocument(record.document)),
      critical: selection.critical,
      document: record.document,
    };
  });
}

function assertToolCoverage(
  cases: EvaluationCaseSnapshot[],
  configuration: EvaluationRunConfiguration
): void {
  const configured = new Set(configuration.tools.map(({ name }) => name));
  const asserted = new Set(
    cases.flatMap(({ document }) => [...document.requiredTools, ...document.forbiddenTools])
  );
  const missing = [...asserted].filter((name) => !configured.has(name));
  if (missing.length) {
    throw new EvaluationToolCoverageError(
      `missing deterministic tool stubs: ${missing.join(", ")}`
    );
  }
}

export interface EvaluationRunnerDependencies {
  now: () => Date;
  id: () => string;
  invoke: typeof invokeEvaluationSidecar;
  credential: typeof resolveCredential;
}

const defaults: EvaluationRunnerDependencies = {
  now: () => new Date(),
  id: randomUUID,
  invoke: invokeEvaluationSidecar,
  credential: resolveCredential,
};

export async function runEvaluation(
  input: unknown,
  signal?: AbortSignal,
  dependencies: EvaluationRunnerDependencies = defaults
): Promise<EvaluationRunReport> {
  const request = evaluationRunRequestSchema.parse(input);
  const configuration = evaluationRunConfigurationSchema.parse({
    ...request.configuration,
    promptHash: hash(request.configuration.prompt),
  });
  const selectedCases = snapshots(request.cases);
  const resolvedSelections = new Set<string>();
  for (const snapshot of selectedCases) {
    const key = `${snapshot.caseId}:${snapshot.revision}:${snapshot.documentHash}`;
    if (resolvedSelections.has(key)) {
      throw new EvaluationRunInputError(
        `evaluation case ${snapshot.caseId} revision ${snapshot.revision} was selected more than once`
      );
    }
    resolvedSelections.add(key);
  }
  assertToolCoverage(selectedCases, configuration);
  for (const snapshot of selectedCases) {
    try {
      evaluationMessages(snapshot.document);
    } catch (error) {
      if (error instanceof UnsupportedEvaluationInputError) {
        throw new EvaluationRunInputError(`${snapshot.document.name}: ${error.message}`);
      }
      throw error;
    }
  }
  if (
    Buffer.byteLength(JSON.stringify({ configuration, cases: selectedCases }), "utf8") >
    EVALUATION_RUN_MAX_BYTES
  ) {
    throw new EvaluationRunPayloadTooLargeError(
      `resolved evaluation dataset exceeds ${EVALUATION_RUN_MAX_BYTES} bytes`
    );
  }
  const startedAt = dependencies.now().toISOString();
  let credential: ReturnType<typeof resolveCredential>;
  try {
    credential = dependencies.credential(configuration.providerId);
  } catch (error) {
    throw new EvaluationRunConfigurationError(
      error instanceof Error ? error.message : "evaluation model configuration is unavailable"
    );
  }
  if (
    credential.apiKey &&
    credential.apiKey !== configuration.providerId &&
    containsString(configuration, credential.apiKey)
  ) {
    throw new EvaluationRunConfigurationError(
      "evaluation configuration must not contain the selected provider credential"
    );
  }
  const response = await dependencies.invoke(
    { configuration, cases: selectedCases, credential },
    signal
  );
  if (response.cases.length !== selectedCases.length) {
    throw new Error("evaluation sidecar returned an incomplete result set");
  }
  const caseResults = selectedCases.map((snapshot, position) => {
    const sidecar = response.cases[position];
    const assertions = evaluateAssertions({
      snapshot,
      configuration,
      observation: sidecar.observation,
      secretDetected: sidecar.secretDetected,
    });
    return {
      position,
      snapshot,
      observation: sidecar.observation,
      assertions,
      passed: assertions.every(({ status }) => status === "passed"),
    };
  });
  const failed = caseResults.filter(({ passed }) => !passed);
  const costs = caseResults.map(({ observation }) => observation.costUsd);
  const completedAt = dependencies.now().toISOString();
  const report = {
    schemaVersion: 1 as const,
    id: dependencies.id(),
    configuration,
    configurationHash: hash(canonical(configuration)),
    startedAt,
    completedAt,
    status: "completed" as const,
    passed: failed.every(({ snapshot }) => !snapshot.critical),
    summary: {
      total: caseResults.length,
      passed: caseResults.length - failed.length,
      failed: failed.length,
      criticalFailed: failed.filter(({ snapshot }) => snapshot.critical).length,
      totalCostUsd: costs.every((value): value is number => value !== null)
        ? costs.reduce((total, value) => total + value, 0)
        : null,
      totalLatencyMs: caseResults.reduce(
        (total, { observation }) => total + observation.latencyMs,
        0
      ),
    },
    environment: {
      runnerVersion: "1",
      chvorVersion: chvorVersion(),
      sourceCommit: process.env.CHVOR_BUILD_SHA ?? null,
      nodeVersion: process.version,
      platform: platform(),
      architecture: arch(),
    },
    cases: caseResults,
    error: null,
  };
  return parseEvaluationRunReport(report);
}
