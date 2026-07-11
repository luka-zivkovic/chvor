import { describe, expect, it } from "vitest";
import type { Memory, MemoryCategory } from "@chvor/shared";
import {
  contextLayerForGraphMemory,
  mapGraphMemoryToContextCandidate,
} from "../orchestrator/context-memory-adapter.ts";

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "memory-1",
    abstract: "One-line memory",
    overview: "Overview",
    detail: "Complete detail",
    category: "event",
    space: "user",
    strength: 0.8,
    decayRate: 0.1,
    accessCount: 3,
    lastAccessedAt: "2026-07-01T00:00:00.000Z",
    confidence: 0.9,
    provenance: "stated",
    emotionalValence: null,
    emotionalIntensity: null,
    sourceChannel: "web",
    sourceSessionId: "session-1",
    sourceMessageId: "message-1",
    sourceResourceId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    content: "One-line memory",
    ...overrides,
  };
}

describe("graph-memory context adapter", () => {
  it("maps every independent resource marker to knowledge", () => {
    expect(contextLayerForGraphMemory(memory({ sourceResourceId: "resource-1" }))).toBe(
      "knowledge"
    );
    expect(contextLayerForGraphMemory(memory({ provenance: "resource" }))).toBe("knowledge");
    expect(contextLayerForGraphMemory(memory({ sourceChannel: "knowledge" }))).toBe("knowledge");
    expect(
      contextLayerForGraphMemory(
        memory({
          sourceResourceId: "resource-1",
          provenance: "extracted",
          sourceChannel: "web",
        })
      )
    ).toBe("knowledge");
  });

  it("maps all existing non-resource categories to episodic without rewriting them", () => {
    const categories: MemoryCategory[] = [
      "profile",
      "preference",
      "entity",
      "event",
      "pattern",
      "case",
    ];
    for (const category of categories) {
      const original = memory({ category });
      const before = structuredClone(original);
      const candidate = mapGraphMemoryToContextCandidate(original, {
        source: "direct",
        sourceTokens: 12,
        rank: 0,
        score: 0.9,
        categoryMatched: true,
      });
      expect(candidate.layer).toBe("episodic");
      expect(candidate.item.content).toEqual(before);
      expect(original).toEqual(before);
      expect(candidate.item.inclusionReasons.map(({ code }) => code)).toEqual([
        "semantic-match",
        "category-match",
      ]);
    }
  });

  it("preserves graph association, prediction, fallback, and resource reasons", () => {
    const associated = mapGraphMemoryToContextCandidate(memory(), {
      source: "associated",
      sourceTokens: 8,
      rank: 2,
      score: 0.7,
      relation: "causal",
    });
    expect(associated.item.inclusionReasons).toEqual([
      {
        kind: "dependency",
        code: "graph-association",
        rank: 2,
        score: 0.7,
        relation: "causal",
      },
    ]);

    const predicted = mapGraphMemoryToContextCandidate(memory(), {
      source: "predicted",
      sourceTokens: 5,
    });
    expect(predicted.item.inclusionReasons[0].code).toBe("topic-prediction");

    const fallback = mapGraphMemoryToContextCandidate(memory(), {
      source: "fallback",
      sourceTokens: 5,
    });
    expect(fallback.item.inclusionReasons[0].code).toBe("recency-fallback");

    const knowledge = mapGraphMemoryToContextCandidate(
      memory({ space: "agent", provenance: "resource" }),
      { source: "direct", sourceTokens: 6 }
    );
    expect(knowledge.layer).toBe("knowledge");
    expect(knowledge.item).toMatchObject({
      owner: "agent",
      mutability: "agent-editable",
      authority: "untrusted-data",
      modelVisibility: "retrieval-only",
      accounting: { sourceTokens: 6, includedTokens: 6, truncatedTokens: 0 },
    });
    expect(knowledge.item.inclusionReasons.map(({ code }) => code)).toEqual([
      "semantic-match",
      "resource-match",
    ]);
  });

  it("rejects invalid retrieval metadata before producing a candidate", () => {
    expect(() =>
      mapGraphMemoryToContextCandidate(memory(), {
        source: "associated",
        sourceTokens: 1,
      } as never)
    ).toThrow();
    expect(() =>
      mapGraphMemoryToContextCandidate(memory(), {
        source: "direct",
        sourceTokens: 1,
        score: Number.NaN,
      })
    ).toThrow();
    expect(() =>
      mapGraphMemoryToContextCandidate(memory(), {
        source: "fallback",
        sourceTokens: 1,
        rank: -1,
      })
    ).toThrow();
  });
});
