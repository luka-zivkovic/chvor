import {
  contextAssemblyCandidateSchema,
  type ContextAssemblyCandidate,
  type EdgeRelation,
  type Memory,
} from "@chvor/shared";
import { z } from "zod";

export type GraphMemoryContextLayer = "episodic" | "knowledge";

const retrievalBase = {
  rank: z.number().int().nonnegative().optional(),
  normalizedScore: z.number().finite().optional(),
  categoryMatched: z.boolean().default(false),
};

const graphMemoryRetrievalSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("direct"), ...retrievalBase }).strict(),
  z
    .object({
      source: z.literal("associated"),
      relation: z.enum([
        "temporal",
        "causal",
        "semantic",
        "entity",
        "contradiction",
        "supersedes",
        "narrative",
      ]),
      ...retrievalBase,
    })
    .strict(),
  z.object({ source: z.literal("predicted"), ...retrievalBase }).strict(),
  z.object({ source: z.literal("fallback"), ...retrievalBase }).strict(),
]);

export interface GraphMemoryRetrieval {
  source: "direct" | "associated" | "predicted" | "fallback";
  relation?: EdgeRelation;
  rank?: number;
  normalizedScore?: number;
  categoryMatched?: boolean;
}

/** Apply the B10 migration-free graph-memory classification predicate exactly. */
export function contextLayerForGraphMemory(memory: Memory): GraphMemoryContextLayer {
  return memory.sourceResourceId !== null ||
    memory.provenance === "resource" ||
    memory.sourceChannel === "knowledge"
    ? "knowledge"
    : "episodic";
}

function retrievalReasons(
  layer: GraphMemoryContextLayer,
  retrieval: z.output<typeof graphMemoryRetrievalSchema>
) {
  const shared = {
    ...(retrieval.normalizedScore === undefined ? {} : { score: retrieval.normalizedScore }),
    ...(retrieval.rank === undefined ? {} : { rank: retrieval.rank }),
  };
  const reasons: Array<{
    kind: "recent" | "retrieved" | "dependency";
    code:
      | "semantic-match"
      | "category-match"
      | "graph-association"
      | "topic-prediction"
      | "recency-fallback"
      | "resource-match";
    score?: number;
    rank?: number;
    relation?: EdgeRelation;
  }> = [];

  switch (retrieval.source) {
    case "direct":
      reasons.push({ kind: "retrieved", code: "semantic-match", ...shared });
      break;
    case "associated":
      reasons.push({
        kind: "dependency",
        code: "graph-association",
        relation: retrieval.relation,
        ...shared,
      });
      break;
    case "predicted":
      reasons.push({ kind: "recent", code: "topic-prediction", ...shared });
      break;
    case "fallback":
      reasons.push({ kind: "recent", code: "recency-fallback", ...shared });
      break;
  }
  if (retrieval.categoryMatched) {
    reasons.push({ kind: "retrieved", code: "category-match", ...shared });
  }
  if (layer === "knowledge") {
    reasons.push({ kind: "retrieved", code: "resource-match", ...shared });
  }
  return reasons;
}

/**
 * Adapt a retrieved graph row without exposing its larger tiers or inventing
 * assembly rank/token accounting. The stored L0 abstract is the complete source form.
 */
export function mapGraphMemoryToContextCandidate(
  memory: Memory,
  retrievalInput: GraphMemoryRetrieval
): ContextAssemblyCandidate {
  const retrieval = graphMemoryRetrievalSchema.parse(retrievalInput);
  const layer = contextLayerForGraphMemory(memory);
  const owner = memory.space === "user" ? "user" : "agent";
  const mutability = memory.space === "user" ? "user-editable" : "agent-editable";

  return contextAssemblyCandidateSchema.parse({
    id: `graph-memory:${memory.id}:${memory.updatedAt}`,
    layer,
    owner,
    mutability,
    modelVisibility: "retrieval-only",
    authority: "untrusted-data",
    reference: {
      namespace: "graph-memory",
      id: memory.id,
      revision: memory.updatedAt,
    },
    source: {
      kind: "memory",
      id: memory.id,
      revision: memory.updatedAt,
    },
    ordering: {
      retrievalScore: retrieval.normalizedScore ?? null,
      eventTime: memory.updatedAt,
    },
    inclusionReasons: retrievalReasons(layer, retrieval),
    representations: [
      {
        kind: "full",
        id: "graph-memory.l0",
        version: "1",
        content: memory.abstract,
      },
    ],
  });
}
