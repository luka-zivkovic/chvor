import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route the DB to a throwaway temp dir before anything else loads the singleton.
const tmp = mkdtempSync(join(tmpdir(), "chvor-tool-embed-"));
process.env.CHVOR_DATA_DIR = tmp;

let canonicalToolText: typeof import("../tool-embeddings.ts").canonicalToolText;
let listToolEmbeddingSources: typeof import("../tool-embeddings.ts").listToolEmbeddingSources;
let syncToolEmbeddings: typeof import("../tool-embeddings.ts").syncToolEmbeddings;
let topKBySemantic: typeof import("../tool-embeddings.ts").topKBySemantic;
let semanticScoresFor: typeof import("../tool-embeddings.ts").semanticScoresFor;
let scoreTool: typeof import("../tool-graph.ts").scoreTool;
let isEmbedderAvailable: typeof import("../embedder.ts").isEmbedderAvailable;

beforeAll(async () => {
  ({ canonicalToolText, listToolEmbeddingSources, syncToolEmbeddings, topKBySemantic, semanticScoresFor } =
    await import("../tool-embeddings.ts"));
  ({ scoreTool } = await import("../tool-graph.ts"));
  ({ isEmbedderAvailable } = await import("../embedder.ts"));
});

describe("tool-embeddings — canonicalToolText", () => {
  it("produces a stable, embedder-friendly form for native tools", () => {
    const text = canonicalToolText({
      toolName: "native__web_search",
      description: "Search the web for current information.",
      group: "web",
    });
    expect(text).toContain("tool: web search");
    expect(text).toContain("group: web");
    expect(text).toContain("description: Search the web for current information.");
  });

  it("collapses whitespace + handles missing group", () => {
    const text = canonicalToolText({
      toolName: "github",
      description: "Manage   GitHub  issues\n\nand pull requests.",
      group: undefined,
    });
    expect(text).toContain("description: Manage GitHub issues and pull requests.");
    expect(text).toContain("group: integrations-other");
  });
});

describe("tool-embeddings — listToolEmbeddingSources", () => {
  it("includes every native tool with its description + group", () => {
    const sources = listToolEmbeddingSources();
    const recall = sources.find((s) => s.toolName === "native__recall_detail");
    expect(recall).toBeTruthy();
    expect(recall!.group).toBe("core");
    expect(typeof recall!.description).toBe("string");

    // Every native tool name in the catalog should be present.
    const names = new Set(sources.map((s) => s.toolName));
    expect(names.has("native__web_search") || names.has("native__fetch")).toBe(true);
    expect(names.has("native__shell_execute")).toBe(true);
  });
});

describe("tool-embeddings — syncToolEmbeddings (no-op safety)", () => {
  it("returns gracefully when embedder is unavailable (test env default)", async () => {
    // In CI/test the local embedder isn't loaded; sync is a structured no-op.
    const result = await syncToolEmbeddings(false);
    expect(result.attempted).toBeGreaterThanOrEqual(0);
    expect(result.errors).toBe(0);
    if (!isEmbedderAvailable()) {
      // No model → either skippedNoEmbedder, or attempted-but-nothing-synced
      expect(result.synced).toBe(0);
    }
  });

  it("topKBySemantic returns [] when embedder is unavailable", async () => {
    const hits = await topKBySemantic("post a tweet", { k: 5 });
    if (!isEmbedderAvailable()) {
      expect(hits).toEqual([]);
    } else {
      // If a real embedder is loaded, just sanity-check shape.
      for (const h of hits) {
        expect(h.similarity).toBeGreaterThanOrEqual(0);
        expect(h.similarity).toBeLessThanOrEqual(1);
      }
    }
  });

  it("semanticScoresFor returns empty Map without throwing", async () => {
    const map = await semanticScoresFor("anything", ["native__web_search"]);
    expect(map).toBeInstanceOf(Map);
    if (!isEmbedderAvailable()) {
      expect(map.size).toBe(0);
    }
  });
});

describe("tool-graph — semantic signal in scoreTool", () => {
  it("scoreBreakdown includes the new `semantic` field", () => {
    const breakdown = scoreTool(null, "native__web_search", new Map(), {});
    expect(breakdown).toHaveProperty("semantic");
    expect(breakdown.semantic).toBe(0); // no semanticScores provided
  });

  it("composite increases monotonically with semantic score, all else equal", () => {
    const empty = scoreTool(null, "tool-x", new Map(), {});
    const halfMatch = scoreTool(null, "tool-x", new Map(), {
      semanticScores: new Map([["tool-x", 0.5]]),
    });
    const fullMatch = scoreTool(null, "tool-x", new Map(), {
      semanticScores: new Map([["tool-x", 1]]),
    });
    expect(halfMatch.composite).toBeGreaterThan(empty.composite);
    expect(fullMatch.composite).toBeGreaterThan(halfMatch.composite);
    // Semantic weight is 0.2 — so a unit semantic increase shifts composite by 0.2.
    expect(fullMatch.composite - empty.composite).toBeCloseTo(0.2, 5);
  });

  it("missing tool entry in semanticScores degrades to 0 contribution", () => {
    const map = new Map<string, number>([["other-tool", 1]]);
    const breakdown = scoreTool(null, "tool-x", new Map(), { semanticScores: map });
    expect(breakdown.semantic).toBe(0);
  });

  it("semantic-only cold-start tool ties a ceiling-strength tool with no other signals", () => {
    // tool-A (cold-start, semantic=1):  strength fallback 0.5 * 0.4 + semantic 1 * 0.2 = 0.4
    // tool-B (ceiling node, no signals): strength 1.0 * 0.4                              = 0.4
    // The math is intentional — semantic carries enough mass that a brand-new
    // tool with a strong query match can compete with a learned tool that has
    // no in-context evidence (recent co-use / category match) for this turn.
    const ceilingNode = {
      toolName: "tool-b",
      strength: 2.0,
      invocationCount: 10,
      successCount: 10,
      failureCount: 0,
      trialBoostRemaining: 0,
      installedAt: "now",
      lastUsedAt: null,
      lastDecayedAt: null,
    };
    const a = scoreTool(null, "tool-a", new Map(), {
      semanticScores: new Map([["tool-a", 1]]),
    });
    const b = scoreTool(ceilingNode, "tool-b", new Map(), {});
    expect(a.composite).toBeCloseTo(b.composite, 5);

    // Once tool-B has a non-trivial co-activation OR category match, it
    // overtakes the semantic-only newcomer. That's the desired ordering.
    // Edge key uses canonical (a, b) ordering — "peer" < "tool-b" so the
    // key is "peer|tool-b".
    const bWithCoact = scoreTool(
      ceilingNode,
      "tool-b",
      new Map([
        ["peer|tool-b", { toolA: "peer", toolB: "tool-b", weight: 1, coUseCount: 1, lastCoUsedAt: "x" }],
      ]),
      { recentTools: ["peer"] }
    );
    expect(bWithCoact.composite).toBeGreaterThan(a.composite);
  });
});
