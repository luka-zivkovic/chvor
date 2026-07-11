import { z } from "zod";
import {
  redactTrajectoryText,
  trajectoryValueSchema,
  type TrajectoryJsonValue,
} from "./trajectory.js";

/** Current portable evaluation-case document version. */
export const EVALUATION_CASE_SCHEMA_VERSION = 1 as const;
export const EVALUATION_CASE_TRANSIENT_ID_VALUE = "[TRANSIENT_ID]" as const;
export const EVALUATION_CASE_TRANSIENT_TIMESTAMP_VALUE = "[TRANSIENT_TIMESTAMP]" as const;
export const EVALUATION_CASE_DOCUMENT_MAX_BYTES = 512_000 as const;

export const evaluationCaseStatusSchema = z.enum([
  "completed",
  "failed",
  "aborted",
  "round-limited",
]);

export const evaluationCaseSafetyAssertionSchema = z.enum([
  "no-secrets-in-output",
  "forbid-unapproved-write-tools",
  "require-approval-for-required-tools",
]);

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeTextSet(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => redactTrajectoryText(value).trim()).filter(Boolean)),
  ].sort(compareStrings);
}

function normalizedTextSetSchema(maxItems: number, maxLength: number) {
  return z
    .array(z.string().max(maxLength))
    .max(maxItems)
    .transform(normalizeTextSet)
    .pipe(z.array(z.string().max(maxLength)).max(maxItems));
}

const transientIdKeys = new Set([
  "actorid",
  "approvalid",
  "artifactid",
  "channelid",
  "checkpointid",
  "executionid",
  "loopid",
  "messageid",
  "runid",
  "scheduleid",
  "sessionid",
  "snapshotid",
  "stepid",
  "toolcallid",
  "trajectoryid",
  "webhookid",
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isCapturedMessage(value: Record<string, TrajectoryJsonValue>): boolean {
  return (
    (value.role === "user" || value.role === "assistant" || value.role === "system") &&
    (typeof value.content === "string" || typeof value.text === "string")
  );
}

function isCapturedMedia(value: Record<string, TrajectoryJsonValue>): boolean {
  return (
    typeof value.mediaType === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.url === "string"
  );
}

function isCapturedToolAction(value: Record<string, TrajectoryJsonValue>): boolean {
  return typeof value.tool === "string" && typeof value.summary === "string";
}

function isCapturedEmotionSnapshot(value: Record<string, TrajectoryJsonValue>): boolean {
  return (
    typeof value.vad === "object" &&
    value.vad !== null &&
    typeof value.blend === "object" &&
    value.blend !== null &&
    typeof value.displayLabel === "string" &&
    typeof value.timestamp === "string"
  );
}

function isSnapshotTimestampKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    normalized === "timestamp" ||
    normalized.endsWith("since") ||
    normalized.endsWith("interaction") ||
    [
      "createdat",
      "updatedat",
      "startedat",
      "completedat",
      "requestedat",
      "decidedat",
      "resolvedat",
    ].includes(normalized)
  );
}

function redactTransientIdentifiers(
  value: TrajectoryJsonValue,
  insideEmotionSnapshot = false
): TrajectoryJsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactTransientIdentifiers(entry, insideEmotionSnapshot));
  }
  const capturedMessage = isCapturedMessage(value);
  const capturedMedia = isCapturedMedia(value);
  const capturedToolAction = isCapturedToolAction(value);
  const capturedEmotionSnapshot = insideEmotionSnapshot || isCapturedEmotionSnapshot(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      transientIdKeys.has(normalizedKey(key)) ||
      (capturedEmotionSnapshot && normalizedKey(key) === "id")
        ? EVALUATION_CASE_TRANSIENT_ID_VALUE
        : capturedEmotionSnapshot && isSnapshotTimestampKey(key)
          ? EVALUATION_CASE_TRANSIENT_TIMESTAMP_VALUE
          : normalizedKey(key) === "id" && (capturedMessage || capturedMedia)
            ? EVALUATION_CASE_TRANSIENT_ID_VALUE
            : normalizedKey(key) === "url" && capturedMedia
              ? EVALUATION_CASE_TRANSIENT_ID_VALUE
              : normalizedKey(key) === "audiourl" && capturedMessage
                ? EVALUATION_CASE_TRANSIENT_ID_VALUE
                : normalizedKey(key) === "timestamp" && (capturedMessage || capturedToolAction)
                  ? EVALUATION_CASE_TRANSIENT_TIMESTAMP_VALUE
                  : redactTransientIdentifiers(entry, capturedEmotionSnapshot),
    ])
  );
}

const evaluationCasePayloadSchema = trajectoryValueSchema.transform((value) =>
  redactTransientIdentifiers(value)
);

const normalizedSafetyAssertionsSchema = z
  .array(evaluationCaseSafetyAssertionSchema)
  .max(evaluationCaseSafetyAssertionSchema.options.length)
  .transform((values) => [...new Set(values)].sort(compareStrings));

export const evaluationCaseExpectedSchema = z
  .object({
    status: evaluationCaseStatusSchema.optional(),
    output: evaluationCasePayloadSchema.optional(),
    outputContains: normalizedTextSetSchema(100, 4_000),
  })
  .strict()
  .superRefine((expected, context) => {
    if (
      expected.status === undefined &&
      expected.output === undefined &&
      expected.outputContains.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one expected status, output, or output substring is required",
      });
    }
  });

export const evaluationCaseDocumentV1Schema = z
  .object({
    schemaVersion: z.literal(EVALUATION_CASE_SCHEMA_VERSION),
    name: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .transform(redactTrajectoryText)
      .pipe(z.string().min(1).max(512)),
    input: evaluationCasePayloadSchema,
    expected: evaluationCaseExpectedSchema,
    requiredTools: normalizedTextSetSchema(100, 256),
    forbiddenTools: normalizedTextSetSchema(100, 256),
    safetyAssertions: normalizedSafetyAssertionsSchema,
  })
  .strict()
  .superRefine((document, context) => {
    const forbidden = new Set(document.forbiddenTools);
    const overlap = document.requiredTools.filter((tool) => forbidden.has(tool));
    if (overlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forbiddenTools"],
        message: `tools cannot be both required and forbidden: ${overlap.join(", ")}`,
      });
    }
    const serializedBytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
    if (serializedBytes > EVALUATION_CASE_DOCUMENT_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `evaluation case document exceeds ${EVALUATION_CASE_DOCUMENT_MAX_BYTES} bytes`,
      });
    }
  });

export const evaluationCaseDocumentSchema = evaluationCaseDocumentV1Schema;

const localIdSchema = z.string().min(1).max(256);
const localRevisionSchema = z.number().int().positive();
const localTimestampSchema = z.string().datetime({ offset: true });

/** Local metadata is intentionally separate from the portable document. */
export const evaluationCaseRecordSchema = z
  .object({
    id: localIdSchema,
    revision: localRevisionSchema,
    document: evaluationCaseDocumentV1Schema,
    createdAt: localTimestampSchema,
    updatedAt: localTimestampSchema,
  })
  .strict();

/** Input for an optimistic-concurrency revision update. */
export const evaluationCaseUpdateSchema = z
  .object({
    expectedRevision: localRevisionSchema,
    document: evaluationCaseDocumentV1Schema,
  })
  .strict();

export type EvaluationCaseStatus = z.infer<typeof evaluationCaseStatusSchema>;
export type EvaluationCaseSafetyAssertion = z.infer<typeof evaluationCaseSafetyAssertionSchema>;
export type EvaluationCaseExpected = z.infer<typeof evaluationCaseExpectedSchema>;
export type EvaluationCaseDocumentV1 = z.infer<typeof evaluationCaseDocumentV1Schema>;
export type EvaluationCaseDocument = EvaluationCaseDocumentV1;
export type EvaluationCaseRecord = z.infer<typeof evaluationCaseRecordSchema>;
export type EvaluationCaseUpdate = z.infer<typeof evaluationCaseUpdateSchema>;

export function parseEvaluationCaseDocument(value: unknown): EvaluationCaseDocumentV1 {
  return evaluationCaseDocumentV1Schema.parse(value);
}

export function safeParseEvaluationCaseDocument(value: unknown) {
  return evaluationCaseDocumentV1Schema.safeParse(value);
}

function recursivelySortObjectKeys(value: TrajectoryJsonValue): TrajectoryJsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(recursivelySortObjectKeys);

  const sorted: Record<string, TrajectoryJsonValue> = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    sorted[key] = recursivelySortObjectKeys(value[key]);
  }
  return sorted;
}

/** Serialize only the portable document as stable, recursively key-sorted JSON. */
export function serializeEvaluationCaseDocument(value: unknown): string {
  const document = parseEvaluationCaseDocument(value);
  return `${JSON.stringify(recursivelySortObjectKeys(document))}\n`;
}

/** Parse, validate, redact, and normalize a portable JSON document. */
export function parseEvaluationCaseDocumentJson(json: string): EvaluationCaseDocumentV1 {
  return parseEvaluationCaseDocument(JSON.parse(json) as unknown);
}
