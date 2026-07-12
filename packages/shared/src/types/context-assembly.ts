import { z } from "zod";
import {
  CONTEXT_LAYER_ORDER,
  CONTEXT_PAYLOAD_LIMITS,
  contextAssemblyConfigurationSchema,
  contextAuthoritySchema,
  contextInclusionReasonSchema,
  contextLayerSchema,
  contextModelVisibilitySchema,
  contextMutabilitySchema,
  contextOrderingSchema,
  contextOwnerSchema,
  contextReferenceSchema,
  contextRepresentationSchema,
  contextRuntimeContentSchema,
  contextSourceSchema,
} from "./context.js";

const tokenSchema = z.number().int().nonnegative().max(CONTEXT_PAYLOAD_LIMITS.maxTokens);

export const contextCandidateRepresentationSchema = z
  .object({
    ...contextRepresentationSchema.shape,
    content: contextRuntimeContentSchema,
  })
  .strict();

const candidateOrderingSchema = contextOrderingSchema.omit({ canonicalRank: true });

export const contextAssemblyCandidateSchema = z
  .object({
    id: z.string().min(1).max(256),
    layer: contextLayerSchema,
    owner: contextOwnerSchema,
    mutability: contextMutabilitySchema,
    modelVisibility: contextModelVisibilitySchema,
    authority: contextAuthoritySchema,
    reference: contextReferenceSchema,
    source: contextSourceSchema,
    ordering: candidateOrderingSchema,
    inclusionReasons: z
      .array(contextInclusionReasonSchema)
      .min(1)
      .max(CONTEXT_PAYLOAD_LIMITS.maxReasonsPerItem),
    representations: z.array(contextCandidateRepresentationSchema).min(1).max(16),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (candidate.representations.filter(({ kind }) => kind === "full").length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["representations"],
        message: "a candidate requires exactly one full representation",
      });
    }
    const representationKeys = new Set<string>();
    for (const [index, representation] of candidate.representations.entries()) {
      const key = `${representation.id}\0${representation.version}`;
      if (representationKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["representations", index],
          message: "candidate representation identifiers must be unique",
        });
      }
      representationKeys.add(key);
    }
    const requiredOrdering = {
      identity: ["declaredOrder"],
      human: ["declaredOrder"],
      working: ["turnIndex", "completionState", "eventTime"],
      procedural: ["procedurePriority", "scopeSpecificity", "declaredOrder"],
      episodic: ["retrievalScore", "eventTime"],
      knowledge: ["retrievalScore", "eventTime"],
    } as const;
    for (const field of requiredOrdering[candidate.layer]) {
      if (candidate.ordering[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ordering", field],
          message: `${field} is required for ${candidate.layer} candidates`,
        });
      }
    }
  });

export const contextLayerCapsSchema = z
  .object({
    identity: tokenSchema,
    human: tokenSchema,
    working: tokenSchema,
    procedural: tokenSchema,
    episodic: tokenSchema,
    knowledge: tokenSchema,
  })
  .strict();

export const contextAssemblyRuntimeInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(256),
    createdAt: z.string().datetime({ offset: true, precision: 3 }),
    configuration: contextAssemblyConfigurationSchema,
    layerCaps: contextLayerCapsSchema,
    scorePrecision: z.number().int().min(0).max(12),
    candidates: z.array(contextAssemblyCandidateSchema).max(CONTEXT_PAYLOAD_LIMITS.maxItems),
  })
  .strict()
  .superRefine((input, ctx) => {
    const capTotal = CONTEXT_LAYER_ORDER.reduce(
      (total, layer) => total + input.layerCaps[layer],
      0
    );
    if (capTotal !== input.configuration.hierarchyBudgetTokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["layerCaps"],
        message: "layer caps must allocate the complete hierarchy budget",
      });
    }
  });

export const contextExclusionReasonSchema = z.enum([
  "layer-budget",
  "no-approved-form",
  "duplicate-reference",
]);

export const contextExclusionDiagnosticSchema = z
  .object({
    layer: contextLayerSchema,
    reference: contextReferenceSchema,
    candidateRank: z.number().int().positive().max(CONTEXT_PAYLOAD_LIMITS.maxItems),
    reason: contextExclusionReasonSchema,
    critical: z.boolean(),
    minimumRequiredTokens: tokenSchema,
    availableTokens: tokenSchema,
  })
  .strict();

export type ContextCandidateRepresentation = z.infer<typeof contextCandidateRepresentationSchema>;
export type ContextAssemblyCandidate = z.infer<typeof contextAssemblyCandidateSchema>;
export type ContextLayerCaps = z.infer<typeof contextLayerCapsSchema>;
export type ContextAssemblyRuntimeInput = z.infer<typeof contextAssemblyRuntimeInputSchema>;
export type ContextExclusionDiagnostic = z.infer<typeof contextExclusionDiagnosticSchema>;

export interface ContextTokenizer {
  id: string;
  version: string;
  countTokens(text: string): number;
}
