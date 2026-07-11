import {
  contextAssemblyItemSchema,
  type ContextAssemblyItem,
  type EdgeRelation,
  type Memory,
} from "@chvor/shared";
import { z } from "zod";

export type GraphMemoryContextLayer = "episodic" | "knowledge";

const retrievalBase = {
  rank: z.number().int().nonnegative().optional(),
  score: z.number().finite().optional(),
  categoryMatched: z.boolean().default(false),
  sourceTokens: z.number().int().nonnegative(),
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

export type GraphMemoryRetrieval = z.input<typeof graphMemoryRetrievalSchema>;

export interface GraphMemoryContextCandidate {
  layer: GraphMemoryContextLayer;
  item: ContextAssemblyItem;
}

/**
 * Project existing graph-memory provenance into the B10 hierarchy without
 * rewriting the node or using its category as a classification shortcut.
 */
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
    ...(retrieval.score === undefined ? {} : { score: retrieval.score }),
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

/** Build a policy-compatible, lossless candidate while leaving persistence untouched. */
export function mapGraphMemoryToContextCandidate(
  memory: Memory,
  retrievalInput: GraphMemoryRetrieval
): GraphMemoryContextCandidate {
  const retrieval = graphMemoryRetrievalSchema.parse(retrievalInput);
  const layer = contextLayerForGraphMemory(memory);
  const owner = memory.space === "user" ? "user" : "agent";
  const mutability = memory.space === "user" ? "user-editable" : "agent-editable";
  const content = structuredClone(memory);
  const item = contextAssemblyItemSchema.parse({
    id: `graph-memory:${memory.id}`,
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
    representation: {
      kind: "full",
      id: "graph-memory.full",
      version: "1",
    },
    ordering: {
      canonicalRank: 1,
      retrievalScore: retrieval.score ?? null,
      eventTime: memory.updatedAt,
    },
    inclusionReasons: retrievalReasons(layer, retrieval),
    accounting: {
      sourceTokens: retrieval.sourceTokens,
      includedTokens: retrieval.sourceTokens,
      truncatedTokens: 0,
    },
    content,
  });
  return { layer, item };
}
