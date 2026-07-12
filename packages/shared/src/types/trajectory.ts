import { z } from "zod";
import { contextAssemblyTraceSchema, type ContextAssemblyTraceV1 } from "./context.js";

// Keep the context contract behind a named type boundary so trajectory's
// generated declarations reference ContextAssemblyTraceV1 instead of expanding
// the complete nested context schema into every trajectory inference site.
const trajectoryContextAssemblyTraceSchema: z.ZodType<ContextAssemblyTraceV1> =
  contextAssemblyTraceSchema;

/** Current persisted/interchange version of the canonical trajectory contract. */
export const CANONICAL_TRAJECTORY_SCHEMA_VERSION = 1 as const;

/** Stable marker used whenever trajectory-safe serialization removes a secret. */
export const TRAJECTORY_REDACTED_VALUE = "[REDACTED]" as const;

/** Defensive limits for payloads accepted at persistence and API boundaries. */
export const TRAJECTORY_PAYLOAD_LIMITS = {
  maxDepth: 64,
  maxNodes: 100_000,
} as const;

/**
 * Forward-compatibility rules for version 1.
 *
 * Additive object fields are preserved so a newer v1 producer does not lose
 * information when data passes through an older consumer. New enum semantics
 * or incompatible field changes require a schema-version bump; unsupported
 * versions are rejected rather than guessed at.
 */
export const CANONICAL_TRAJECTORY_COMPATIBILITY = {
  additiveFields: "preserve",
  unknownEnumValues: "reject",
  unsupportedSchemaVersions: "reject",
} as const;

export type TrajectoryJsonValue =
  | null
  | boolean
  | number
  | string
  | TrajectoryJsonValue[]
  | { [key: string]: TrajectoryJsonValue };

const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "apikey",
  "apitoken",
  "xapikey",
  "xapitoken",
  "xauthtoken",
  "xaccesstoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "privatekey",
  "credentialvalue",
  "token",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizedKey(key));
}

/** Redact common credential shapes that may be embedded in logs or errors. */
export function redactTrajectoryText(input: string): string {
  let value = input;

  // Private-key blocks must be removed before line-oriented replacements.
  value = value.replace(
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
    TRAJECTORY_REDACTED_VALUE
  );

  // Authorization headers and well-known token formats.
  value = value.replace(
    /\b(authorization|proxy[_-]?authorization)\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi,
    (_match, key: string) => `${key}=${TRAJECTORY_REDACTED_VALUE}`
  );
  value = value.replace(
    /\b(set-cookie|cookie)\s*:\s*[^\r\n]+/gi,
    (_match, key: string) => `${key}=${TRAJECTORY_REDACTED_VALUE}`
  );
  value = value.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    (_match, scheme: string) => `${scheme} ${TRAJECTORY_REDACTED_VALUE}`
  );
  value = value.replace(
    /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|chvor_[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g,
    TRAJECTORY_REDACTED_VALUE
  );
  value = value.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    TRAJECTORY_REDACTED_VALUE
  );

  // Secrets in URLs, form bodies, and provider error messages.
  value = value.replace(
    /([?&](?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|authorization[_-]?code)=)[^&#\s]*/gi,
    `$1${TRAJECTORY_REDACTED_VALUE}`
  );
  value = value.replace(
    /\b(authorization|api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|private[_-]?key)\s*[:=]\s*([^\s,;&#]+)/gi,
    (_match, key: string) => `${key}=${TRAJECTORY_REDACTED_VALUE}`
  );

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface JsonValidationState {
  seen: Set<unknown>;
  nodes: number;
}

function isTrajectoryJsonValue(
  value: unknown,
  state: JsonValidationState = { seen: new Set(), nodes: 0 },
  depth = 0
): value is TrajectoryJsonValue {
  state.nodes += 1;
  if (depth > TRAJECTORY_PAYLOAD_LIMITS.maxDepth) return false;
  if (state.nodes > TRAJECTORY_PAYLOAD_LIMITS.maxNodes) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (state.seen.has(value)) return false;
  state.seen.add(value);

  if (Array.isArray(value)) {
    return value.every((entry) => isTrajectoryJsonValue(entry, state, depth + 1));
  }
  if (!isPlainObject(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.entries(descriptors).every(([key, descriptor]) => {
    if (key === "__proto__" || key === "prototype" || key === "constructor") return false;
    if (!("value" in descriptor)) return false;
    return isTrajectoryJsonValue(descriptor.value, state, depth + 1);
  });
}

/**
 * Return a JSON-safe deep copy with sensitive keys and credential-like string
 * fragments removed. The input is never mutated.
 */
function sanitizeValidatedTrajectoryValue(value: TrajectoryJsonValue): TrajectoryJsonValue {
  if (typeof value === "string") return redactTrajectoryText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeValidatedTrajectoryValue(entry));

  const sanitized: Record<string, TrajectoryJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = isSensitiveKey(key)
      ? TRAJECTORY_REDACTED_VALUE
      : sanitizeValidatedTrajectoryValue(entry);
  }
  return sanitized;
}

export function sanitizeTrajectoryValue(value: unknown): TrajectoryJsonValue {
  if (!isTrajectoryJsonValue(value)) {
    throw new TypeError("trajectory payload must be finite, acyclic JSON data");
  }
  return sanitizeValidatedTrajectoryValue(value);
}

/** JSON-only payload schema that redacts secrets as part of successful parsing. */
export const trajectoryValueSchema = z
  .unknown()
  .refine((value): value is TrajectoryJsonValue => isTrajectoryJsonValue(value), {
    message: "trajectory payload must be finite, acyclic JSON data",
  })
  .transform((value) => sanitizeValidatedTrajectoryValue(value));

const idSchema = z.string().min(1).max(256);
const timestampSchema = z.string().datetime({ offset: true });
function redactedTextSchema(maxLength?: number) {
  const schema = maxLength === undefined ? z.string() : z.string().max(maxLength);
  return schema.transform(redactTrajectoryText);
}
const optionalPayloadSchema = trajectoryValueSchema.optional();

export const trajectoryStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "aborted",
  "round-limited",
]);

export const trajectoryStepStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "skipped",
  "aborted",
]);

export const trajectoryStepKindSchema = z.enum([
  "trajectory.started",
  "context.assembled",
  "model.request",
  "model.response",
  "reasoning",
  "tool.call",
  "tool.result",
  "approval.requested",
  "approval.resolved",
  "memory.read",
  "memory.write",
  "message.output",
  "checkpoint",
  "trajectory.completed",
  "trajectory.failed",
  "custom",
]);

export const trajectoryActorSchema = z
  .object({
    type: z.enum([
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
    ]),
    id: idSchema.nullable(),
    displayName: redactedTextSchema(256).optional(),
  })
  .catchall(trajectoryValueSchema);

export const trajectoryOriginSchema = z
  .object({
    kind: z.enum([
      "web-chat",
      "channel",
      "schedule",
      "webhook",
      "daemon",
      "cognitive-loop",
      "api",
      "system",
      "test",
    ]),
    sessionId: idSchema.nullable().optional(),
    channelType: z.string().min(1).max(64).optional(),
    channelId: idSchema.optional(),
    scheduleId: idSchema.optional(),
    webhookId: idSchema.optional(),
    loopId: idSchema.optional(),
  })
  .catchall(trajectoryValueSchema);

export const trajectoryModelUsageSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    modelId: z.string().min(1).max(256),
    role: z.string().min(1).max(64).optional(),
    wasFallback: z.boolean().default(false),
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    reasoningTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().finite().nonnegative().optional(),
    latencyMs: z.number().int().nonnegative().optional(),
  })
  .catchall(trajectoryValueSchema);

export const trajectoryToolCallSchema = z
  .object({
    toolCallId: idSchema,
    toolName: z.string().min(1).max(256),
    toolKind: z.enum(["native", "mcp", "synthesized", "skill", "system"]),
    credentialRefs: z
      .array(
        z
          .object({
            credentialId: idSchema,
            credentialType: z.string().min(1).max(128),
          })
          .catchall(trajectoryValueSchema)
      )
      .default([]),
  })
  .catchall(trajectoryValueSchema);

export const trajectoryApprovalRefSchema = z
  .object({
    approvalId: idSchema,
    kind: z.string().min(1).max(128),
    risk: z.enum(["low", "medium", "high", "critical"]),
    status: z.enum(["pending", "allowed", "denied", "expired"]),
    decision: z.enum(["allow-once", "allow-session", "deny"]).nullable().optional(),
    requestedAt: timestampSchema,
    resolvedAt: timestampSchema.optional(),
  })
  .catchall(trajectoryValueSchema)
  .superRefine((approval, ctx) => {
    if (approval.status === "pending" && (approval.decision || approval.resolvedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pending approval cannot have a decision or resolution timestamp",
      });
    }
    if (approval.status !== "pending" && !approval.resolvedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolvedAt"],
        message: "resolved approval requires resolvedAt",
      });
    }
    if (approval.status === "allowed" && !approval.decision?.startsWith("allow-")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision"],
        message: "allowed approval requires an allow decision",
      });
    }
    if (approval.status === "denied" && approval.decision !== "deny") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision"],
        message: "denied approval requires a deny decision",
      });
    }
  });

export const trajectoryErrorSchema = z
  .object({
    code: z.string().min(1).max(128),
    category: z.string().min(1).max(128),
    message: redactedTextSchema(),
    retryable: z.boolean().default(false),
    details: optionalPayloadSchema,
  })
  .catchall(trajectoryValueSchema);

export const trajectoryArtifactRefSchema = z
  .object({
    artifactId: idSchema,
    kind: z.enum(["media", "file", "log", "trace", "ui", "other"]),
    name: redactedTextSchema(512).optional(),
    mediaType: z.string().min(1).max(256).optional(),
    locator: redactedTextSchema(2048).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .catchall(trajectoryValueSchema);

const terminalStepStatuses = new Set(["completed", "failed", "skipped", "aborted"]);
const canonicalTrajectoryStepKeys = new Set([
  "id",
  "trajectoryId",
  "sequence",
  "parentStepId",
  "kind",
  "customType",
  "status",
  "name",
  "actor",
  "startedAt",
  "completedAt",
  "durationMs",
  "input",
  "output",
  "modelUsage",
  "toolCall",
  "approval",
  "contextAssembly",
  "error",
  "artifacts",
  "attributes",
]);

export const canonicalTrajectoryStepV1Schema = z
  .object({
    id: idSchema,
    trajectoryId: idSchema,
    sequence: z.number().int().nonnegative(),
    parentStepId: idSchema.nullable().optional(),
    kind: trajectoryStepKindSchema,
    customType: z.string().min(1).max(256).optional(),
    status: trajectoryStepStatusSchema,
    name: redactedTextSchema(256).optional(),
    actor: trajectoryActorSchema.optional(),
    startedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    input: optionalPayloadSchema,
    output: optionalPayloadSchema,
    modelUsage: trajectoryModelUsageSchema.optional(),
    toolCall: trajectoryToolCallSchema.optional(),
    approval: trajectoryApprovalRefSchema.optional(),
    contextAssembly: trajectoryContextAssemblyTraceSchema.optional(),
    error: trajectoryErrorSchema.optional(),
    artifacts: z.array(trajectoryArtifactRefSchema).default([]),
    attributes: trajectoryValueSchema.default({}),
  })
  .catchall(trajectoryValueSchema)
  .superRefine((step, ctx) => {
    if (terminalStepStatuses.has(step.status) && !step.completedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: `terminal step status ${step.status} requires completedAt`,
      });
    }
    if (step.status === "failed" && !step.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "failed step requires error details",
      });
    }
    if (step.kind.startsWith("tool.") && !step.toolCall) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolCall"],
        message: `${step.kind} requires a toolCall reference`,
      });
    }
    if (step.kind.startsWith("approval.") && !step.approval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval"],
        message: `${step.kind} requires an approval reference`,
      });
    }
    if (step.kind.startsWith("model.") && !step.modelUsage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelUsage"],
        message: `${step.kind} requires model usage`,
      });
    }
    // B10 already admitted generic context.assembled steps under schema v1.
    // Preserve those persisted rows for reads, but apply the body-free B12
    // restrictions whenever the dedicated trace field is present. The B12
    // runtime producer always supplies contextAssembly.
    if (step.kind === "context.assembled" && step.contextAssembly) {
      for (const field of ["input", "output"] as const) {
        if (step[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `context.assembled does not allow a generic ${field} payload`,
          });
        }
      }
      if (!isPlainObject(step.attributes) || Object.keys(step.attributes).length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["attributes"],
          message: "context.assembled requires empty attributes",
        });
      }
      if (
        step.status !== "completed" ||
        step.name !== "Context assembled" ||
        step.completedAt === undefined ||
        step.durationMs !== 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "traced context.assembled requires the canonical completed runtime shape",
        });
      }
      for (const field of [
        "customType",
        "actor",
        "modelUsage",
        "toolCall",
        "approval",
        "error",
      ] as const) {
        if (step[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `traced context.assembled does not allow ${field}`,
          });
        }
      }
      if (step.artifacts.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts"],
          message: "traced context.assembled requires empty artifacts",
        });
      }
      for (const key of Object.keys(step)) {
        if (!canonicalTrajectoryStepKeys.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: "context.assembled does not allow extension payload fields",
          });
        }
      }
    }
    if (step.kind === "custom" && !step.customType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customType"],
        message: "custom trajectory step requires customType",
      });
    }
    if (step.completedAt && Date.parse(step.completedAt) < Date.parse(step.startedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt cannot precede startedAt",
      });
    }
  });

export type CanonicalTrajectoryStepV1 = z.infer<typeof canonicalTrajectoryStepV1Schema>;

// As with the context trace itself, keep the nested step array behind a named
// output type so declaration generation does not recursively inline the trace.
const trajectoryStepForEnvelopeSchema = canonicalTrajectoryStepV1Schema as z.ZodType<
  CanonicalTrajectoryStepV1,
  z.ZodTypeDef,
  unknown
>;

const terminalTrajectoryStatuses = new Set(["completed", "failed", "aborted", "round-limited"]);

export const canonicalTrajectoryV1Schema = z
  .object({
    schemaVersion: z.literal(CANONICAL_TRAJECTORY_SCHEMA_VERSION),
    id: idSchema,
    origin: trajectoryOriginSchema,
    actor: trajectoryActorSchema,
    status: trajectoryStatusSchema,
    title: redactedTextSchema(512).optional(),
    summary: redactedTextSchema(4000).optional(),
    startedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    input: optionalPayloadSchema,
    output: optionalPayloadSchema,
    modelUsage: z.array(trajectoryModelUsageSchema).default([]),
    steps: z.array(trajectoryStepForEnvelopeSchema),
    artifacts: z.array(trajectoryArtifactRefSchema).default([]),
    error: trajectoryErrorSchema.optional(),
    labels: z.array(redactedTextSchema(128).pipe(z.string().min(1))).default([]),
    attributes: trajectoryValueSchema.default({}),
  })
  .catchall(trajectoryValueSchema)
  .superRefine((trajectory, ctx) => {
    if (terminalTrajectoryStatuses.has(trajectory.status) && !trajectory.completedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: `terminal trajectory status ${trajectory.status} requires completedAt`,
      });
    }
    if (trajectory.status === "failed" && !trajectory.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "failed trajectory requires error details",
      });
    }
    if (
      trajectory.completedAt &&
      Date.parse(trajectory.completedAt) < Date.parse(trajectory.startedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt cannot precede startedAt",
      });
    }

    let previousSequence = -1;
    const stepIds = new Set<string>();
    for (let index = 0; index < trajectory.steps.length; index += 1) {
      const step = trajectory.steps[index];
      if (step.trajectoryId !== trajectory.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "trajectoryId"],
          message: "step trajectoryId must match its containing trajectory",
        });
      }
      if (step.sequence <= previousSequence) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "sequence"],
          message: "step sequence values must be strictly increasing",
        });
      }
      previousSequence = step.sequence;
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "id"],
          message: "step ids must be unique within a trajectory",
        });
      }
      stepIds.add(step.id);

      if (step.parentStepId) {
        if (step.parentStepId === step.id || !stepIds.has(step.parentStepId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "parentStepId"],
            message: "parentStepId must reference an earlier step in the trajectory",
          });
        }
      }
    }
  });

export type TrajectoryStatus = z.infer<typeof trajectoryStatusSchema>;
export type TrajectoryStepStatus = z.infer<typeof trajectoryStepStatusSchema>;
export type TrajectoryStepKind = z.infer<typeof trajectoryStepKindSchema>;
export type TrajectoryActor = z.infer<typeof trajectoryActorSchema>;
export type TrajectoryOrigin = z.infer<typeof trajectoryOriginSchema>;
export type TrajectoryModelUsage = z.infer<typeof trajectoryModelUsageSchema>;
export type TrajectoryToolCall = z.infer<typeof trajectoryToolCallSchema>;
export type TrajectoryApprovalRef = z.infer<typeof trajectoryApprovalRefSchema>;
export type TrajectoryError = z.infer<typeof trajectoryErrorSchema>;
export type TrajectoryArtifactRef = z.infer<typeof trajectoryArtifactRefSchema>;
export type CanonicalTrajectoryV1 = z.infer<typeof canonicalTrajectoryV1Schema>;
export const canonicalTrajectorySchema = canonicalTrajectoryV1Schema as z.ZodType<
  CanonicalTrajectoryV1,
  z.ZodTypeDef,
  unknown
>;
export type CanonicalTrajectory = CanonicalTrajectoryV1;

/** Parse and sanitize a version-1 trajectory. Unsupported versions fail closed. */
export function parseCanonicalTrajectory(value: unknown): CanonicalTrajectoryV1 {
  return canonicalTrajectoryV1Schema.parse(value);
}

/** Safe-parse counterpart for API and persistence boundaries. */
export function safeParseCanonicalTrajectory(value: unknown) {
  return canonicalTrajectoryV1Schema.safeParse(value);
}
