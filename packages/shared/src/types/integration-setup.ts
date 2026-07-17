import { z } from "zod";
import {
  integrationManifestIdSchema,
  integrationManifestSemverSchema,
} from "./integration-manifest.js";

/** The only manifest-driven setup-flow schema version understood by this reader. */
export const INTEGRATION_SETUP_SCHEMA_VERSION = 1 as const;

export const INTEGRATION_SETUP_LIMITS = Object.freeze({
  id: 128,
  reference: 128,
  name: 200,
  accountLabel: 320,
  failureCode: 128,
  steps: 256,
  duplicateCandidates: 256,
  attempts: 1_000_000,
  revision: 2_147_483_647,
  credentialFields: 128,
  credentialValue: 65_536,
});

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const SAFE_FAILURE_CODE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

const identifierSchema = z
  .string()
  .min(1)
  .max(INTEGRATION_SETUP_LIMITS.id)
  .regex(SAFE_IDENTIFIER_PATTERN, "identifier contains unsafe characters");
const credentialTypeSchema = z
  .string()
  .min(1)
  .max(INTEGRATION_SETUP_LIMITS.reference)
  .regex(SAFE_IDENTIFIER_PATTERN, "credential type contains unsafe characters");
const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(INTEGRATION_SETUP_LIMITS.name)
  .refine((value) => !hasControlCharacter(value), "name contains control characters");
const accountLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(INTEGRATION_SETUP_LIMITS.accountLabel)
  .refine((value) => !hasControlCharacter(value), "account label contains control characters");
const timestampSchema = z.string().datetime({ offset: true });

/** A bounded, machine-readable failure code safe to persist and return publicly. */
export const integrationSetupFailureCodeSchema = z
  .string()
  .min(1)
  .max(INTEGRATION_SETUP_LIMITS.failureCode)
  .regex(SAFE_FAILURE_CODE_PATTERN, "failure code must be a safe machine-readable identifier");

export const integrationSetupModeSchema = z.enum(["setup", "reconfigure", "reauthenticate"]);

export const integrationSetupStatusSchema = z.enum([
  "awaiting-input",
  "awaiting-oauth",
  "awaiting-confirmation",
  "discovering",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export const integrationAuthStatusSchema = z.enum([
  "unknown",
  "active",
  "expired",
  "revoked",
  "reauthentication-required",
  "failed",
]);

/** Mirrors every setup-step kind declared by the C01 integration manifest contract. */
export const integrationSetupStepKindSchema = z.enum([
  "instruction",
  "credential",
  "oauth",
  "diagnostic",
]);

export const integrationSetupStepStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "failed",
]);

export const integrationSetupStepProgressSchema = z
  .object({
    id: integrationManifestIdSchema,
    kind: integrationSetupStepKindSchema,
    status: integrationSetupStepStatusSchema,
    attempts: z.number().int().nonnegative().max(INTEGRATION_SETUP_LIMITS.attempts),
    failureCode: integrationSetupFailureCodeSchema.optional(),
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((step, context) => {
    if (step.completedAt !== undefined && step.startedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt requires startedAt",
      });
    }
    if (
      step.startedAt !== undefined &&
      step.completedAt !== undefined &&
      Date.parse(step.completedAt) < Date.parse(step.startedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt cannot be earlier than startedAt",
      });
    }
  });

/** A deliberately minimal credential summary; credential material is never included. */
export const integrationSetupDuplicateCandidateDecisionSchema = z.enum([
  "reuse-existing",
  "replace-existing",
]);
export const integrationSetupDuplicateCandidateSchema = z
  .object({
    id: identifierSchema,
    name: displayNameSchema,
    type: credentialTypeSchema,
    accountLabel: accountLabelSchema.optional(),
    allowedDecisions: z
      .array(integrationSetupDuplicateCandidateDecisionSchema)
      .min(1)
      .max(2)
      .refine((items) => new Set(items).size === items.length, {
        message: "duplicate candidate decisions must be unique",
      }),
  })
  .strict();

const flowSnapshotBaseSchema = z
  .object({
    schemaVersion: z.literal(INTEGRATION_SETUP_SCHEMA_VERSION),
    id: identifierSchema,
    integrationId: integrationManifestIdSchema,
    manifestVersion: integrationManifestSemverSchema,
    manifestCredentialId: integrationManifestIdSchema.optional(),
    currentStepId: integrationManifestIdSchema.optional(),
    targetCredentialId: identifierSchema.optional(),
    oauthCredentialId: identifierSchema.optional(),
    oauthCreateAdditional: z.boolean().default(false),
    credentialType: credentialTypeSchema,
    mode: integrationSetupModeSchema,
    status: integrationSetupStatusSchema,
    authStatus: integrationAuthStatusSchema,
    steps: z.array(integrationSetupStepProgressSchema).max(INTEGRATION_SETUP_LIMITS.steps),
    duplicateCandidates: z
      .array(integrationSetupDuplicateCandidateSchema)
      .max(INTEGRATION_SETUP_LIMITS.duplicateCandidates),
    revision: z.number().int().positive().max(INTEGRATION_SETUP_LIMITS.revision),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    expiresAt: timestampSchema,
    failureCode: integrationSetupFailureCodeSchema.optional(),
  })
  .strict();

export const integrationSetupFlowSnapshotSchema = flowSnapshotBaseSchema.superRefine(
  (flow, context) => {
    const stepIds = new Set<string>();
    const activeStepIds: string[] = [];
    flow.steps.forEach((step, index) => {
      if (stepIds.has(step.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "id"],
          message: "step id must be unique within a flow",
        });
      }
      stepIds.add(step.id);
      if (step.status === "active") activeStepIds.push(step.id);

      if (step.startedAt !== undefined && Date.parse(step.startedAt) < Date.parse(flow.createdAt)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "startedAt"],
          message: "step cannot start before the flow was created",
        });
      }
      if (
        step.completedAt !== undefined &&
        Date.parse(step.completedAt) > Date.parse(flow.updatedAt)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "completedAt"],
          message: "step cannot complete after the flow was updated",
        });
      }
    });

    if (flow.currentStepId !== undefined && !stepIds.has(flow.currentStepId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentStepId"],
        message: "currentStepId must reference a step in this flow",
      });
    }
    if (activeStepIds.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: "a flow can have at most one active step",
      });
    }
    if (activeStepIds.length === 1 && flow.currentStepId !== activeStepIds[0]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentStepId"],
        message: "currentStepId must reference the active step",
      });
    }

    const candidateIds = new Set<string>();
    flow.duplicateCandidates.forEach((candidate, index) => {
      if (candidateIds.has(candidate.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["duplicateCandidates", index, "id"],
          message: "duplicate candidate id must be unique within a flow",
        });
      }
      candidateIds.add(candidate.id);
    });

    if (Date.parse(flow.updatedAt) < Date.parse(flow.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt cannot be earlier than createdAt",
      });
    }
    if (Date.parse(flow.expiresAt) <= Date.parse(flow.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be later than createdAt",
      });
    }
  }
);

const requestReferenceShape = {
  schemaVersion: z.literal(INTEGRATION_SETUP_SCHEMA_VERSION),
  flowId: identifierSchema,
  revision: z.number().int().positive().max(INTEGRATION_SETUP_LIMITS.revision),
};

export const integrationSetupStartRequestSchema = z
  .object({
    schemaVersion: z.literal(INTEGRATION_SETUP_SCHEMA_VERSION),
    /** Client-generated replay key; the server reuses it as the durable setup-flow ID. */
    idempotencyKey: identifierSchema.optional(),
    integrationId: integrationManifestIdSchema,
    manifestVersion: integrationManifestSemverSchema,
    manifestCredentialId: integrationManifestIdSchema.optional(),
    targetCredentialId: identifierSchema.optional(),
    oauthCredentialId: identifierSchema.optional(),
    credentialType: credentialTypeSchema,
    mode: integrationSetupModeSchema,
  })
  .strict();

const credentialDataSchema = z
  .record(
    z.string().min(1).max(INTEGRATION_SETUP_LIMITS.id),
    z.string().max(INTEGRATION_SETUP_LIMITS.credentialValue)
  )
  .superRefine((data, context) => {
    if (Object.keys(data).length > INTEGRATION_SETUP_LIMITS.credentialFields) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: INTEGRATION_SETUP_LIMITS.credentialFields,
        inclusive: true,
        path: [],
        message: "credential data contains too many fields",
      });
    }
  });

/**
 * Carries raw credential values to secure credential storage. `data` is request-only:
 * it must never be copied into an integration setup flow snapshot, log, or response.
 */
export const integrationSetupCredentialSubmissionRequestSchema = z
  .object({
    ...requestReferenceShape,
    stepId: integrationManifestIdSchema,
    data: credentialDataSchema,
  })
  .strict();

/** Advances the instruction step that is current at the supplied flow revision. */
export const integrationSetupInstructionAcknowledgementRequestSchema = z
  .object({
    ...requestReferenceShape,
    stepId: integrationManifestIdSchema,
  })
  .strict();

export const integrationSetupDuplicateDecisionSchema = z.enum([
  "reuse-existing",
  "replace-existing",
  "create-additional",
  "cancel",
]);

const duplicateDecisionRequestBase = {
  ...requestReferenceShape,
};
const existingCredentialDecisionSchema = z
  .object({
    ...duplicateDecisionRequestBase,
    decision: z.enum(["reuse-existing", "replace-existing"]),
    credentialId: identifierSchema,
  })
  .strict();
const createAdditionalDecisionSchema = z
  .object({
    ...duplicateDecisionRequestBase,
    decision: z.literal("create-additional"),
  })
  .strict();
const cancelDecisionSchema = z
  .object({
    ...duplicateDecisionRequestBase,
    decision: z.literal("cancel"),
  })
  .strict();

export const integrationSetupDuplicateDecisionRequestSchema = z.union([
  existingCredentialDecisionSchema,
  createAdditionalDecisionSchema,
  cancelDecisionSchema,
]);

/** Requests that the server derive and run the diagnostic for the current step. */
export const integrationSetupDiscoveryRequestSchema = z
  .object({
    ...requestReferenceShape,
    stepId: integrationManifestIdSchema,
  })
  .strict();

export const integrationSetupFlowResponseSchema = z
  .object({ data: integrationSetupFlowSnapshotSchema })
  .strict();

export type IntegrationSetupFailureCode = z.infer<typeof integrationSetupFailureCodeSchema>;
export type IntegrationSetupMode = z.infer<typeof integrationSetupModeSchema>;
export type IntegrationSetupStatus = z.infer<typeof integrationSetupStatusSchema>;
export type IntegrationAuthStatus = z.infer<typeof integrationAuthStatusSchema>;
export type IntegrationSetupStepKind = z.infer<typeof integrationSetupStepKindSchema>;
export type IntegrationSetupStepStatus = z.infer<typeof integrationSetupStepStatusSchema>;
export type IntegrationSetupStepProgress = z.infer<typeof integrationSetupStepProgressSchema>;
export type IntegrationSetupDuplicateCandidate = z.infer<
  typeof integrationSetupDuplicateCandidateSchema
>;
export type IntegrationSetupFlowSnapshot = z.infer<typeof integrationSetupFlowSnapshotSchema>;
export type IntegrationSetupStartRequest = z.infer<typeof integrationSetupStartRequestSchema>;
export type IntegrationSetupCredentialSubmissionRequest = z.infer<
  typeof integrationSetupCredentialSubmissionRequestSchema
>;
export type IntegrationSetupInstructionAcknowledgementRequest = z.infer<
  typeof integrationSetupInstructionAcknowledgementRequestSchema
>;
export type IntegrationSetupDuplicateDecision = z.infer<
  typeof integrationSetupDuplicateDecisionSchema
>;
export type IntegrationSetupDuplicateDecisionRequest = z.infer<
  typeof integrationSetupDuplicateDecisionRequestSchema
>;
export type IntegrationSetupDiscoveryRequest = z.infer<
  typeof integrationSetupDiscoveryRequestSchema
>;
export type IntegrationSetupFlowResponse = z.infer<typeof integrationSetupFlowResponseSchema>;
