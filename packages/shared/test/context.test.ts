import { describe, expect, it } from "vitest";
import {
  CONTEXT_COMPATIBILITY,
  CONTEXT_LAYER_ORDER,
  CONTEXT_LAYER_POLICIES,
  CONTEXT_PAYLOAD_LIMITS,
  CONTEXT_SCHEMA_VERSION,
  parseContextAssembly,
  parseContextAssemblyTrace,
  projectContextAssemblyTrace,
  safeParseContextAssembly,
  safeParseContextAssemblyTrace,
  serializeContextAssembly,
  serializeContextAssemblyTrace,
} from "../src/index.js";

const tokenRows = [
  { budget: 10, source: 5, included: 5 },
  { budget: 8, source: 12, included: 8 },
  { budget: 8, source: 3, included: 3 },
  { budget: 8, source: 4, included: 4 },
  { budget: 8, source: 9, included: 8 },
  { budget: 8, source: 6, included: 6 },
] as const;

function copyPolicy(index: number) {
  const policy = CONTEXT_LAYER_POLICIES[index];
  return {
    ...policy,
    allowedOwners: [...policy.allowedOwners],
    allowedMutability: [...policy.allowedMutability],
    budgetPolicy: { ...policy.budgetPolicy },
    allowedAuthority: [...policy.allowedAuthority],
  };
}

function validAssembly() {
  const layers = CONTEXT_LAYER_ORDER.map((layer, index) => {
    const policy = copyPolicy(index);
    const row = tokenRows[index];
    const truncatedTokens = row.source - row.included;
    return {
      layer,
      policy,
      tokenBudget: row.budget,
      items: [
        {
          id: `item-${layer}`,
          owner: policy.allowedOwners[0],
          mutability: policy.allowedMutability[0],
          modelVisibility: policy.modelVisibility,
          authority: policy.allowedAuthority[0],
          reference: {
            namespace: "context",
            id: `reference-${layer}`,
            revision: "revision-1",
          },
          source: {
            kind: layer === "procedural" ? "procedure" : layer === "working" ? "runtime" : "memory",
            id: `source-${layer}`,
            revision: "revision-1",
          },
          representation: {
            kind: truncatedTokens > 0 ? "compact" : "full",
            id: truncatedTokens > 0 ? `${layer}.compact` : `${layer}.full`,
            version: "1",
          },
          ordering: {
            canonicalRank: 1,
            ...(layer === "identity" || layer === "human" ? { declaredOrder: index } : {}),
            ...(layer === "working"
              ? {
                  turnIndex: 1,
                  completionState: "unresolved",
                  eventTime: "2026-07-11T00:00:00.000Z",
                }
              : {}),
            ...(layer === "procedural"
              ? { procedurePriority: "required", scopeSpecificity: 1, declaredOrder: 0 }
              : {}),
            ...(layer === "episodic" || layer === "knowledge"
              ? { retrievalScore: 1 - index / 10, eventTime: "2026-07-11T00:00:00.000Z" }
              : {}),
          },
          inclusionReasons: [
            {
              kind: index < 2 ? "required" : "retrieved",
              code:
                index === 0
                  ? "contract-required"
                  : index === 1
                    ? "configured-profile"
                    : "semantic-match",
              score: 1 - index / 10,
              rank: index,
            },
          ],
          accounting: {
            sourceTokens: row.source,
            includedTokens: row.included,
            truncatedTokens,
          },
          content: {
            text: `UNIQUE_RUNTIME_CONTENT_${layer}`,
            secret: `UNIQUE_SECRET_${layer}_9c315d`,
          },
        },
      ],
      accounting: {
        sourceTokens: row.source,
        includedTokens: row.included,
        truncatedTokens,
        overflowTokens: Math.max(0, row.source - row.budget),
      },
    };
  });
  const accounting = layers.reduce(
    (total, layer) => ({
      sourceTokens: total.sourceTokens + layer.accounting.sourceTokens,
      includedTokens: total.includedTokens + layer.accounting.includedTokens,
      truncatedTokens: total.truncatedTokens + layer.accounting.truncatedTokens,
      overflowTokens: total.overflowTokens + layer.accounting.overflowTokens,
    }),
    { sourceTokens: 0, includedTokens: 0, truncatedTokens: 0, overflowTokens: 0 }
  );

  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    id: "assembly-1",
    createdAt: "2026-07-11T00:00:00.000Z",
    configuration: {
      tokenizer: { id: "approximate", version: "1" },
      retrievalScoring: { id: "memory-composite", version: "1" },
      contextWindowTokens: 70,
      systemInstructionTokens: 1,
      developerInstructionTokens: 1,
      currentRequestTokens: 2,
      otherPromptTokens: 0,
      responseReserveTokens: 8,
      toolDefinitionTokens: 8,
      hierarchyBudgetTokens: layers.reduce((total, layer) => total + layer.tokenBudget, 0),
    },
    layers,
    accounting,
  };
}

function cloneAssembly() {
  return structuredClone(validAssembly());
}

describe("shared context hierarchy v1", () => {
  it("declares exactly six fixed policies with unique ordered precedence", () => {
    expect(CONTEXT_LAYER_ORDER).toEqual([
      "identity",
      "human",
      "working",
      "procedural",
      "episodic",
      "knowledge",
    ]);
    expect(CONTEXT_LAYER_POLICIES.map((policy) => policy.layer)).toEqual(CONTEXT_LAYER_ORDER);
    expect(CONTEXT_LAYER_POLICIES.map((policy) => policy.precedence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(CONTEXT_LAYER_POLICIES.map((policy) => policy.precedence)).size).toBe(6);

    for (const policy of CONTEXT_LAYER_POLICIES) {
      expect(policy.allowedOwners.length).toBeGreaterThan(0);
      expect(policy.allowedMutability.length).toBeGreaterThan(0);
      expect(policy.modelVisibility).toBeTruthy();
      expect(policy.budgetPolicy).toEqual(
        expect.objectContaining({ allocation: expect.any(String), overflow: expect.any(String) })
      );
      expect(policy.allowedAuthority.length).toBeGreaterThan(0);
    }
  });

  it("parses and serializes a complete assembly without changing runtime content", () => {
    const parsed = parseContextAssembly(validAssembly());
    expect(parsed.layers.map((layer) => layer.layer)).toEqual(CONTEXT_LAYER_ORDER);
    expect(parsed.layers[1].items[0].accounting.truncatedTokens).toBe(4);
    expect(parsed.layers[1].accounting.overflowTokens).toBe(4);
    expect(parsed.layers[5].items[0].content).toEqual({
      text: "UNIQUE_RUNTIME_CONTENT_knowledge",
      secret: "UNIQUE_SECRET_knowledge_9c315d",
    });

    const serialized = serializeContextAssembly(parsed);
    expect(parseContextAssembly(JSON.parse(serialized))).toEqual(parsed);
  });

  it("projects a valid trace with references, reasons, and accounting but no content", () => {
    const trace = projectContextAssemblyTrace(validAssembly());
    const json = JSON.stringify(trace);

    expect(trace.layers[4].items[0]).toEqual(
      expect.objectContaining({
        reference: { namespace: "context", id: "reference-episodic", revision: "revision-1" },
        source: { kind: "memory", id: "source-episodic", revision: "revision-1" },
        inclusionReasons: [{ kind: "retrieved", code: "semantic-match", score: 0.6, rank: 4 }],
        representation: { kind: "compact", id: "episodic.compact", version: "1" },
        ordering: {
          canonicalRank: 1,
          retrievalScore: 0.6,
          eventTime: "2026-07-11T00:00:00.000Z",
        },
        accounting: { sourceTokens: 9, includedTokens: 8, truncatedTokens: 1 },
      })
    );
    expect(json).not.toContain('"content"');
    for (const layer of CONTEXT_LAYER_ORDER) {
      expect(json).not.toContain(`UNIQUE_RUNTIME_CONTENT_${layer}`);
      expect(json).not.toContain(`UNIQUE_SECRET_${layer}_9c315d`);
    }

    const traceJson = serializeContextAssemblyTrace(validAssembly());
    expect(parseContextAssemblyTrace(JSON.parse(traceJson))).toEqual(trace);
  });

  it("rejects content in the trace schema rather than silently stripping it", () => {
    const trace = projectContextAssemblyTrace(validAssembly());
    const unsafeTrace = structuredClone(trace) as unknown as {
      layers: Array<{ items: Array<Record<string, unknown>> }>;
    };
    unsafeTrace.layers[0].items[0].content = "must-not-enter-a-trace";
    expect(safeParseContextAssemblyTrace(unsafeTrace).success).toBe(false);
  });

  it("rejects missing, extra, duplicated, and reordered layers", () => {
    const missing = cloneAssembly();
    missing.layers.pop();
    expect(safeParseContextAssembly(missing).success).toBe(false);

    const extra = cloneAssembly();
    extra.layers.push(structuredClone(extra.layers[5]));
    expect(safeParseContextAssembly(extra).success).toBe(false);

    const duplicated = cloneAssembly();
    duplicated.layers[5] = structuredClone(duplicated.layers[4]);
    expect(safeParseContextAssembly(duplicated).success).toBe(false);

    const reordered = cloneAssembly();
    [reordered.layers[0], reordered.layers[1]] = [reordered.layers[1], reordered.layers[0]];
    expect(safeParseContextAssembly(reordered).success).toBe(false);
  });

  it("rejects duplicate item ids across different layers", () => {
    const input = cloneAssembly();
    input.layers[5].items[0].id = input.layers[0].items[0].id;
    expect(safeParseContextAssembly(input).success).toBe(false);

    const duplicateReference = cloneAssembly();
    duplicateReference.layers[5].items[0].reference = structuredClone(
      duplicateReference.layers[0].items[0].reference
    );
    expect(safeParseContextAssembly(duplicateReference).success).toBe(false);
  });

  it("rejects any fixed policy change and every item-policy incompatibility", () => {
    const changedPolicy = cloneAssembly();
    changedPolicy.layers[2].policy.precedence = 5;
    expect(safeParseContextAssembly(changedPolicy).success).toBe(false);

    const badOwner = cloneAssembly();
    badOwner.layers[0].items[0].owner = "agent";
    expect(safeParseContextAssembly(badOwner).success).toBe(false);

    const badMutability = cloneAssembly();
    badMutability.layers[0].items[0].mutability = "agent-editable";
    expect(safeParseContextAssembly(badMutability).success).toBe(false);

    const badVisibility = cloneAssembly();
    badVisibility.layers[0].items[0].modelVisibility = "conditional";
    expect(safeParseContextAssembly(badVisibility).success).toBe(false);

    const badAuthority = cloneAssembly();
    badAuthority.layers[0].items[0].authority = "agent";
    expect(safeParseContextAssembly(badAuthority).success).toBe(false);
  });

  it("rejects missing reasons and non-finite or invalid scores and ranks", () => {
    const missingReasons = cloneAssembly();
    missingReasons.layers[0].items[0].inclusionReasons = [];
    expect(safeParseContextAssembly(missingReasons).success).toBe(false);

    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const input = cloneAssembly();
      input.layers[0].items[0].inclusionReasons[0].score = score;
      expect(safeParseContextAssembly(input).success).toBe(false);
    }

    for (const rank of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const input = cloneAssembly();
      input.layers[0].items[0].inclusionReasons[0].rank = rank;
      expect(safeParseContextAssembly(input).success).toBe(false);
    }
  });

  it("rejects item, layer, and assembly token sum mismatches", () => {
    const badItem = cloneAssembly();
    badItem.layers[2].items[0].accounting.sourceTokens += 1;
    expect(safeParseContextAssembly(badItem).success).toBe(false);

    const badLayer = cloneAssembly();
    badLayer.layers[2].accounting.includedTokens += 1;
    expect(safeParseContextAssembly(badLayer).success).toBe(false);

    const badAssembly = cloneAssembly();
    badAssembly.accounting.truncatedTokens += 1;
    expect(safeParseContextAssembly(badAssembly).success).toBe(false);

    const badBudgetTotal = cloneAssembly();
    badBudgetTotal.configuration.contextWindowTokens += 1;
    badBudgetTotal.configuration.hierarchyBudgetTokens += 1;
    expect(safeParseContextAssembly(badBudgetTotal).success).toBe(false);
  });

  it("reserves every out-of-hierarchy prompt input in the model window", () => {
    for (const field of [
      "systemInstructionTokens",
      "developerInstructionTokens",
      "currentRequestTokens",
      "otherPromptTokens",
    ] as const) {
      const input = cloneAssembly();
      input.configuration[field] += 1;
      expect(safeParseContextAssembly(input).success).toBe(false);
    }
  });

  it("requires representation and canonical layer-specific ordering inputs", () => {
    const noRepresentation = cloneAssembly();
    delete (noRepresentation.layers[0].items[0] as unknown as { representation?: unknown })
      .representation;
    expect(safeParseContextAssembly(noRepresentation).success).toBe(false);

    const wrongRank = cloneAssembly();
    wrongRank.layers[4].items[0].ordering.canonicalRank = 2;
    expect(safeParseContextAssembly(wrongRank).success).toBe(false);

    const missingInput = cloneAssembly();
    delete missingInput.layers[4].items[0].ordering.retrievalScore;
    expect(safeParseContextAssembly(missingInput).success).toBe(false);

    const falseFull = cloneAssembly();
    falseFull.layers[4].items[0].representation.kind = "full";
    expect(safeParseContextAssembly(falseFull).success).toBe(false);
  });

  it("rejects items that contradict canonical ordering and ranks missing scores last", () => {
    const input = cloneAssembly();
    const layer = input.layers[4];
    const second = structuredClone(layer.items[0]);
    second.id = "item-episodic-second";
    second.reference.id = "reference-episodic-second";
    second.source.id = "source-episodic-second";
    second.ordering.canonicalRank = 2;
    second.ordering.retrievalScore = 0.9;
    second.accounting = { sourceTokens: 1, includedTokens: 1, truncatedTokens: 0 };
    second.representation = { kind: "full", id: "episodic.full", version: "1" };
    layer.items.push(second);
    layer.tokenBudget += 1;
    layer.accounting.sourceTokens += 1;
    layer.accounting.includedTokens += 1;
    layer.accounting.overflowTokens = Math.max(
      0,
      layer.accounting.sourceTokens - layer.tokenBudget
    );
    input.configuration.contextWindowTokens += 1;
    input.configuration.hierarchyBudgetTokens += 1;
    input.accounting.sourceTokens += 1;
    input.accounting.includedTokens += 1;
    input.accounting.overflowTokens = input.layers.reduce(
      (total, current) => total + current.accounting.overflowTokens,
      0
    );
    expect(safeParseContextAssembly(input).success).toBe(false);

    layer.items[0].ordering.retrievalScore = 0.9;
    second.ordering.retrievalScore = null;
    second.ordering.eventTime = null;
    expect(safeParseContextAssembly(input).success).toBe(true);
  });

  it("rejects an oversized aggregate before serializing the full assembly", () => {
    const input = cloneAssembly();
    const layer = input.layers[2];
    for (let index = 0; index < 6; index += 1) {
      const item = structuredClone(layer.items[0]);
      item.id = `large-item-${index}`;
      item.reference.id = `z-large-reference-${index}`;
      item.source.id = `large-source-${index}`;
      item.ordering.canonicalRank = index + 2;
      item.content = "x".repeat(800_000) as unknown as typeof item.content;
      item.accounting = { sourceTokens: 1, includedTokens: 1, truncatedTokens: 0 };
      layer.items.push(item);
    }
    layer.tokenBudget += 6;
    layer.accounting.sourceTokens += 6;
    layer.accounting.includedTokens += 6;
    input.configuration.contextWindowTokens += 6;
    input.configuration.hierarchyBudgetTokens += 6;
    input.accounting.sourceTokens += 6;
    input.accounting.includedTokens += 6;

    expect(safeParseContextAssembly(input).success).toBe(false);
  });

  it("rejects incorrect overflow, budget excess, and reject-policy truncation", () => {
    const wrongOverflow = cloneAssembly();
    wrongOverflow.layers[1].accounting.overflowTokens = 3;
    expect(safeParseContextAssembly(wrongOverflow).success).toBe(false);

    const overIncluded = cloneAssembly();
    overIncluded.layers[2].tokenBudget = 2;
    overIncluded.layers[2].accounting.overflowTokens = 1;
    overIncluded.accounting.overflowTokens += 1;
    expect(safeParseContextAssembly(overIncluded).success).toBe(false);

    const rejectedTruncation = cloneAssembly();
    rejectedTruncation.layers[0].items[0].accounting = {
      sourceTokens: 5,
      includedTokens: 4,
      truncatedTokens: 1,
    };
    rejectedTruncation.layers[0].accounting = {
      sourceTokens: 5,
      includedTokens: 4,
      truncatedTokens: 1,
      overflowTokens: 0,
    };
    rejectedTruncation.accounting.includedTokens -= 1;
    rejectedTruncation.accounting.truncatedTokens += 1;
    expect(safeParseContextAssembly(rejectedTruncation).success).toBe(false);

    const compactIdentity = cloneAssembly();
    compactIdentity.layers[0].items[0].representation = {
      kind: "compact",
      id: "identity.compact",
      version: "1",
    };
    compactIdentity.layers[0].items[0].accounting = {
      sourceTokens: 15,
      includedTokens: 10,
      truncatedTokens: 5,
    };
    compactIdentity.layers[0].accounting = {
      sourceTokens: 15,
      includedTokens: 10,
      truncatedTokens: 5,
      overflowTokens: 5,
    };
    compactIdentity.accounting.sourceTokens += 10;
    compactIdentity.accounting.includedTokens += 5;
    compactIdentity.accounting.truncatedTokens += 5;
    compactIdentity.accounting.overflowTokens += 5;
    expect(safeParseContextAssembly(compactIdentity).success).toBe(true);
  });

  it("rejects unsupported versions, enums, and additive fields", () => {
    const version = cloneAssembly();
    version.schemaVersion = 2;
    expect(safeParseContextAssembly(version).success).toBe(false);

    const enumValue = cloneAssembly();
    enumValue.layers[0].items[0].owner = "future-owner";
    expect(safeParseContextAssembly(enumValue).success).toBe(false);

    const additive = cloneAssembly() as ReturnType<typeof validAssembly> & {
      futureField?: boolean;
    };
    additive.futureField = true;
    expect(safeParseContextAssembly(additive).success).toBe(false);
    expect(CONTEXT_COMPATIBILITY.unsupportedSchemaVersions).toBe("reject");
    expect(CONTEXT_COMPATIBILITY.unknownEnumValues).toBe("reject");
  });

  it("rejects non-JSON, cyclic, unsafe, and bounded-limit payloads", () => {
    const nonFinite = cloneAssembly();
    nonFinite.layers[0].items[0].content = { score: Number.POSITIVE_INFINITY };
    expect(safeParseContextAssembly(nonFinite).success).toBe(false);

    const cyclicValue: Record<string, unknown> = {};
    cyclicValue.self = cyclicValue;
    const cyclic = cloneAssembly();
    cyclic.layers[0].items[0].content = cyclicValue;
    expect(safeParseContextAssembly(cyclic).success).toBe(false);

    const unsafe = cloneAssembly();
    unsafe.layers[0].items[0].content = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(safeParseContextAssembly(unsafe).success).toBe(false);

    const sparse = cloneAssembly();
    sparse.layers[0].items[0].content = Array(1);
    expect(safeParseContextAssembly(sparse).success).toBe(false);

    const customArray = cloneAssembly();
    const arrayWithExtra = ["safe"] as unknown[] & { extra?: unknown };
    arrayWithExtra.extra = () => "not JSON";
    customArray.layers[0].items[0].content = arrayWithExtra;
    expect(safeParseContextAssembly(customArray).success).toBe(false);

    let accessorInvoked = false;
    const accessorArray = ["safe"];
    Object.defineProperty(accessorArray, "toJSON", {
      get() {
        accessorInvoked = true;
        return () => ["changed"];
      },
    });
    const unsafeAccessor = cloneAssembly();
    unsafeAccessor.layers[0].items[0].content = accessorArray;
    expect(safeParseContextAssembly(unsafeAccessor).success).toBe(false);
    expect(accessorInvoked).toBe(false);

    const impossibleOffset = cloneAssembly();
    impossibleOffset.layers[2].items[0].ordering.eventTime = "2026-07-11T00:00:00.000+99:99";
    expect(safeParseContextAssembly(impossibleOffset).success).toBe(false);

    const subMillisecond = cloneAssembly();
    subMillisecond.layers[2].items[0].ordering.eventTime = "2026-07-11T00:00:00.000001Z";
    expect(safeParseContextAssembly(subMillisecond).success).toBe(false);

    const oversized = cloneAssembly();
    oversized.layers[0].items[0].content = "x".repeat(
      CONTEXT_PAYLOAD_LIMITS.maxContentCharacters + 1
    );
    expect(safeParseContextAssembly(oversized).success).toBe(false);

    const tooManyReasons = cloneAssembly();
    tooManyReasons.layers[0].items[0].inclusionReasons = Array.from(
      { length: CONTEXT_PAYLOAD_LIMITS.maxReasonsPerItem + 1 },
      (_, rank) => ({ kind: "required", code: "contract-required", score: 1, rank })
    );
    expect(safeParseContextAssembly(tooManyReasons).success).toBe(false);
  });
});
