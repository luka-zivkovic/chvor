import { describe, expect, it } from "vitest";
import type { Memory, MemoryCategory } from "@chvor/shared";
import {
  contextLayerForGraphMemory,
  mapGraphMemoryToContextCandidate,
} from "../orchestrator/context-memory-adapter.ts";

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "memory-1",
    abstract: "Actual L0 abstract",
    overview: "PRIVATE L1 overview",
    detail: "PRIVATE L2 detail",
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
    content: "PRIVATE compatibility content",
    ...overrides,
  };
}

describe("graph-memory context adapter", () => {
  it("uses the exact migration-free knowledge predicate", () => {
    expect(contextLayerForGraphMemory(memory({ sourceResourceId: "resource-1" }))).toBe(
      "knowledge"
    );
    expect(contextLayerForGraphMemory(memory({ provenance: "resource" }))).toBe("knowledge");
    expect(contextLayerForGraphMemory(memory({ sourceChannel: "knowledge" }))).toBe("knowledge");
    expect(
      contextLayerForGraphMemory(
        memory({
          sourceResourceId: null,
          provenance: "extracted",
          sourceChannel: "web",
        })
      )
    ).toBe("episodic");
  });

  it("maps all non-resource categories to episodic without rewriting the source", () => {
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
        rank: 0,
        normalizedScore: 0.9,
        categoryMatched: true,
      });
      expect(candidate.layer).toBe("episodic");
      expect(candidate.representations).toEqual([
        {
          kind: "full",
          id: "graph-memory.l0",
          version: "1",
          content: "Actual L0 abstract",
        },
      ]);
      expect(original).toEqual(before);
      expect(candidate.inclusionReasons).toEqual([
        { kind: "retrieved", code: "semantic-match", rank: 0, score: 0.9 },
        { kind: "retrieved", code: "category-match", rank: 0, score: 0.9 },
      ]);
      expect(JSON.stringify(candidate.representations)).not.toMatch(/PRIVATE|provenance/);
    }
  });

  it("preserves exact association, prediction, fallback, and resource reasons", () => {
    const associated = mapGraphMemoryToContextCandidate(memory(), {
      source: "associated",
      rank: 2,
      normalizedScore: 0.7,
      relation: "causal",
    });
    expect(associated.inclusionReasons).toEqual([
      {
        kind: "dependency",
        code: "graph-association",
        rank: 2,
        score: 0.7,
        relation: "causal",
      },
    ]);
    expect(associated.ordering).toEqual({
      retrievalScore: 0.7,
      eventTime: "2026-07-02T00:00:00.000Z",
    });

    const predicted = mapGraphMemoryToContextCandidate(memory(), { source: "predicted" });
    expect(predicted.inclusionReasons).toEqual([{ kind: "recent", code: "topic-prediction" }]);

    const fallback = mapGraphMemoryToContextCandidate(memory(), { source: "fallback" });
    expect(fallback.inclusionReasons).toEqual([{ kind: "recent", code: "recency-fallback" }]);

    const knowledge = mapGraphMemoryToContextCandidate(
      memory({ space: "agent", provenance: "resource" }),
      { source: "direct", normalizedScore: 0.6 }
    );
    expect(knowledge).toMatchObject({
      layer: "knowledge",
      owner: "agent",
      mutability: "agent-editable",
      authority: "untrusted-data",
      modelVisibility: "retrieval-only",
    });
    expect(knowledge.inclusionReasons).toEqual([
      { kind: "retrieved", code: "semantic-match", score: 0.6 },
      { kind: "retrieved", code: "resource-match", score: 0.6 },
    ]);
    expect(knowledge.ordering).not.toHaveProperty("canonicalRank");
    expect(knowledge).not.toHaveProperty("accounting");
  });

  it("rejects invalid retrieval metadata before producing a candidate", () => {
    expect(() =>
      mapGraphMemoryToContextCandidate(memory(), { source: "associated" } as never)
    ).toThrow();
    expect(() =>
      mapGraphMemoryToContextCandidate(memory(), {
        source: "direct",
        normalizedScore: Number.NaN,
      })
    ).toThrow();
    expect(() =>
      mapGraphMemoryToContextCandidate(memory(), { source: "fallback", rank: -1 })
    ).toThrow();
    expect(() =>
      mapGraphMemoryToContextCandidate(memory(), {
        source: "direct",
        sourceTokens: 1,
      } as never)
    ).toThrow();
  });
});
