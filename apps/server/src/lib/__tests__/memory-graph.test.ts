import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Memory, MemoryEdge } from "@chvor/shared";

// Mock DB dependencies
vi.mock("../../db/memory-store.ts", () => ({
  getEdgesForMemory: vi.fn(() => []),
  getNeighborMemories: vi.fn(() => []),
  recordMemoryAccess: vi.fn(),
  createEdge: vi.fn(),
  boostEdgeWeight: vi.fn(),
}));

vi.mock("../../db/database.ts", () => ({
  getDb: vi.fn(() => ({
    transaction: vi.fn((fn: () => void) => fn),
  })),
}));

import { spreadActivation, strengthenCoAccessedEdges, linkBySharedEntities } from "../memory-graph.ts";
import { getEdgesForMemory, getNeighborMemories, recordMemoryAccess, createEdge, boostEdgeWeight } from "../../db/memory-store.ts";

const mockGetEdges = vi.mocked(getEdgesForMemory);
const mockGetNeighbors = vi.mocked(getNeighborMemories);
const mockRecordAccess = vi.mocked(recordMemoryAccess);
const mockCreateEdge = vi.mocked(createEdge);
const mockBoostEdge = vi.mocked(boostEdgeWeight);

function makeMemory(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    space: "user",
    category: "profile",
    abstract: `memory ${id}`,
    overview: null,
    detail: null,
    confidence: 0.8,
    strength: 0.7,
    decayRate: 0.01,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 1,
    emotionalValence: null,
    emotionalIntensity: null,
    provenance: "extracted",
    sourceChannel: "web",
    sourceSessionId: "sess-1",
    sourceMessageId: null,
    sourceResourceId: null,
    content: `memory ${id}`,
    ...overrides,
  };
}

function makeEdge(sourceId: string, targetId: string, relation: string = "semantic", weight: number = 0.5): MemoryEdge {
  return {
    id: `edge-${sourceId}-${targetId}`,
    sourceId,
    targetId,
    relation: relation as MemoryEdge["relation"],
    weight,
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEdges.mockReturnValue([]);
  mockGetNeighbors.mockReturnValue([]);
});

// ── spreadActivation ────────────────────────────────────

describe("spreadActivation", () => {
  it("returns empty for empty input", () => {
    expect(spreadActivation([])).toEqual([]);
  });

  it("scores direct memories with position decay", () => {
    const mems = [makeMemory("a"), makeMemory("b"), makeMemory("c")];
    const result = spreadActivation(mems);
    expect(result).toHaveLength(3);
    expect(result[0].activationScore).toBe(1.0);
    expect(result[1].activationScore).toBe(0.95);
    expect(result[2].activationScore).toBe(0.90);
  });

  it("marks direct memories as source 'direct'", () => {
    const result = spreadActivation([makeMemory("a")]);
    expect(result[0].source).toBe("direct");
  });

  it("calls recordMemoryAccess for each direct memory", () => {
    const mems = [makeMemory("a"), makeMemory("b")];
    spreadActivation(mems, 10, "sess-1", "query text");
    expect(mockRecordAccess).toHaveBeenCalledWith("a", "sess-1", "query text");
    expect(mockRecordAccess).toHaveBeenCalledWith("b", "sess-1", "query text");
  });

  it("spreads to neighbors via edges", () => {
    const memA = makeMemory("a");
    const memB = makeMemory("b", { strength: 0.8 });

    mockGetEdges.mockReturnValue([makeEdge("a", "b", "semantic", 0.6)]);
    mockGetNeighbors.mockReturnValue([memB]);

    const result = spreadActivation([memA]);
    expect(result).toHaveLength(2);
    expect(result[1].source).toBe("associated");
    expect(result[1].memory.id).toBe("b");
    expect(result[1].relation).toBe("semantic");
  });

  it("scores neighbors as edge.weight * strength * RELATION_BONUS", () => {
    const memA = makeMemory("a");
    const memB = makeMemory("b", { strength: 0.9 });

    mockGetEdges.mockReturnValue([makeEdge("a", "b", "causal", 0.8)]);
    mockGetNeighbors.mockReturnValue([memB]);

    const result = spreadActivation([memA]);
    const neighborScore = result[1].activationScore;
    // causal bonus = 1.5, so: 0.8 * 0.9 * 1.5 = 1.08
    expect(neighborScore).toBeCloseTo(1.08, 5);
  });

  it("deduplicates: already-seen memories not added as neighbors", () => {
    const memA = makeMemory("a");
    // Edge points back to 'a' — should be skipped
    mockGetEdges.mockReturnValue([makeEdge("a", "a", "semantic", 0.5)]);
    mockGetNeighbors.mockReturnValue([memA]);

    const result = spreadActivation([memA]);
    expect(result).toHaveLength(1); // only the direct one
  });

  it("caps neighbors to maxNeighbors", () => {
    const memA = makeMemory("a");
    const neighbors = Array.from({ length: 5 }, (_, i) => makeMemory(`n${i}`, { strength: 0.5 + i * 0.1 }));
    const edges = neighbors.map((n) => makeEdge("a", n.id, "semantic", 0.5));

    mockGetEdges.mockReturnValue(edges);
    mockGetNeighbors.mockReturnValue(neighbors);

    const result = spreadActivation([memA], 2); // max 2 neighbors
    const associated = result.filter((r) => r.source === "associated");
    expect(associated).toHaveLength(2);
  });

  it("keeps highest score when neighbor reachable via multiple edges", () => {
    const memA = makeMemory("a");
    const memB = makeMemory("b");
    const memC = makeMemory("c", { strength: 0.8 });

    // c reachable from both a (weak) and b (strong)
    mockGetEdges
      .mockReturnValueOnce([makeEdge("a", "c", "semantic", 0.3)]) // from a
      .mockReturnValueOnce([makeEdge("b", "c", "causal", 0.9)]); // from b
    mockGetNeighbors
      .mockReturnValueOnce([memC])
      .mockReturnValueOnce([memC]);

    const result = spreadActivation([memA, memB]);
    const cResult = result.find((r) => r.memory.id === "c");
    expect(cResult).toBeDefined();
    // Stronger path: 0.9 * 0.8 * 1.5 (causal) = 1.08
    expect(cResult!.activationScore).toBeCloseTo(1.08, 5);
  });

  it("applies relation bonuses correctly", () => {
    const memA = makeMemory("a");
    const bonuses: Array<[string, number]> = [
      ["causal", 1.5],
      ["entity", 1.2],
      ["narrative", 1.2],
      ["supersedes", 1.1],
      ["temporal", 1.0],
      ["semantic", 0.8],
      ["contradiction", 0.3],
    ];

    for (const [relation, expectedBonus] of bonuses) {
      const neighbor = makeMemory(`n-${relation}`, { strength: 1.0 });
      mockGetEdges.mockReturnValueOnce([makeEdge("a", neighbor.id, relation, 1.0)]);
      mockGetNeighbors.mockReturnValueOnce([neighbor]);

      const result = spreadActivation([memA]);
      const associated = result.find((r) => r.source === "associated");
      expect(associated?.activationScore).toBeCloseTo(expectedBonus, 5);

      vi.clearAllMocks();
      mockGetEdges.mockReturnValue([]);
      mockGetNeighbors.mockReturnValue([]);
    }
  });

  it("records access for activated neighbors (priming)", () => {
    const memA = makeMemory("a");
    const memB = makeMemory("b", { strength: 0.8 });

    mockGetEdges.mockReturnValue([makeEdge("a", "b", "semantic", 0.6)]);
    mockGetNeighbors.mockReturnValue([memB]);

    spreadActivation([memA], 10, "sess-1");
    // Called for direct (a) + neighbor (b)
    expect(mockRecordAccess).toHaveBeenCalledTimes(2);
    expect(mockRecordAccess).toHaveBeenCalledWith("b", "sess-1");
  });
});

// ── strengthenCoAccessedEdges ───────────────────────────

describe("strengthenCoAccessedEdges", () => {
  it("does nothing for fewer than 2 IDs", () => {
    strengthenCoAccessedEdges([]);
    strengthenCoAccessedEdges(["a"]);
    expect(mockBoostEdge).not.toHaveBeenCalled();
  });

  it("boosts all pairs for 3 IDs", () => {
    strengthenCoAccessedEdges(["a", "b", "c"]);
    expect(mockBoostEdge).toHaveBeenCalledTimes(3);
    expect(mockBoostEdge).toHaveBeenCalledWith("a", "b", 0.05);
    expect(mockBoostEdge).toHaveBeenCalledWith("a", "c", 0.05);
    expect(mockBoostEdge).toHaveBeenCalledWith("b", "c", 0.05);
  });

  it("caps at 30 IDs", () => {
    const ids = Array.from({ length: 35 }, (_, i) => `id-${i}`);
    strengthenCoAccessedEdges(ids);
    // 30 * 29 / 2 = 435 pairs
    expect(mockBoostEdge).toHaveBeenCalledTimes(435);
  });
});

// ── linkBySharedEntities ────────────────────────────────

describe("linkBySharedEntities", () => {
  it("does nothing for empty entities", () => {
    linkBySharedEntities("new-id", [], [makeMemory("a")]);
    expect(mockCreateEdge).not.toHaveBeenCalled();
  });

  it("filters entities shorter than 3 chars", () => {
    linkBySharedEntities("new-id", ["AI", "Go"], [makeMemory("a", { abstract: "I use AI and Go" })]);
    expect(mockCreateEdge).not.toHaveBeenCalled();
  });

  it("creates edge on word-boundary match", () => {
    const existing = makeMemory("x", { abstract: "I use React for frontend" });
    linkBySharedEntities("new-id", ["React"], [existing]);
    expect(mockCreateEdge).toHaveBeenCalledWith("new-id", "x", "entity", 0.6);
  });

  it("rejects partial match (no word boundary)", () => {
    const existing = makeMemory("x", { abstract: "Reactionary views are dangerous" });
    linkBySharedEntities("new-id", ["React"], [existing]);
    // "React" shouldn't match "Reactionary" due to \b
    expect(mockCreateEdge).not.toHaveBeenCalled();
  });

  it("creates only one edge per existing memory pair", () => {
    const existing = makeMemory("x", { abstract: "TypeScript and React project" });
    linkBySharedEntities("new-id", ["TypeScript", "React"], [existing]);
    // Should break after first match
    expect(mockCreateEdge).toHaveBeenCalledTimes(1);
  });

  it("handles special regex characters without crashing", () => {
    // C++ with \b word boundary: the + chars mean \b falls between + and space,
    // which doesn't match as a word boundary. This is expected — no crash, no edge.
    const existing = makeMemory("x", { abstract: "I know C++ well" });
    expect(() => linkBySharedEntities("new-id", ["C++"], [existing])).not.toThrow();
  });

  it("matches case-insensitively", () => {
    const existing = makeMemory("x", { abstract: "using typescript daily" });
    linkBySharedEntities("new-id", ["TypeScript"], [existing]);
    expect(mockCreateEdge).toHaveBeenCalledWith("new-id", "x", "entity", 0.6);
  });
});
