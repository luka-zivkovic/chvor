import {
  contextAssemblyCandidateSchema,
  type ContextAssemblyCandidate,
  type MemoryBlockRecord,
} from "@chvor/shared";

function mutabilityForBlock(record: MemoryBlockRecord): ContextAssemblyCandidate["mutability"] {
  if (record.document.readOnly) return "immutable";
  return record.document.managedBy === "user" ? "user-editable" : "agent-editable";
}

/** Project one current B11 snapshot into assembly metadata and model-visible content. */
export function mapMemoryBlockToContextCandidate(
  record: MemoryBlockRecord
): ContextAssemblyCandidate {
  const { document } = record;
  const revision = String(record.revision);
  const stableOrdering = { declaredOrder: document.declaredOrder };
  const ordering =
    document.layer === "procedural"
      ? {
          ...stableOrdering,
          procedurePriority: document.proceduralPriority,
          // B11 blocks have no narrower scope declaration, so persisted blocks are global scope.
          scopeSpecificity: 0,
        }
      : stableOrdering;
  const inclusionReason =
    document.layer === "identity"
      ? { kind: "required" as const, code: "contract-required" as const }
      : document.layer === "human"
        ? { kind: "explicit" as const, code: "configured-profile" as const }
        : { kind: "active" as const, code: "capability-enabled" as const };

  return contextAssemblyCandidateSchema.parse({
    id: `memory-block:${record.id}:${revision}`,
    layer: document.layer,
    owner: document.managedBy,
    mutability: mutabilityForBlock(record),
    modelVisibility:
      document.layer === "identity" || document.layer === "human" ? "always" : "conditional",
    authority: document.managedBy === "user" ? "user" : "untrusted-data",
    reference: { namespace: "memory-block", id: record.id, revision },
    source: { kind: "block", id: record.id, revision },
    ordering,
    inclusionReasons: [inclusionReason],
    representations: [
      {
        kind: "full",
        id: "memory-block.content",
        version: "1",
        content: document.content,
      },
    ],
  });
}

/** Preserve the store's canonical selection order while adapting every stable block. */
export function mapMemoryBlocksToContextCandidates(
  records: readonly MemoryBlockRecord[]
): ContextAssemblyCandidate[] {
  return records.map(mapMemoryBlockToContextCandidate);
}
