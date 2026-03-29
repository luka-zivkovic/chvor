import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Memory } from "@chvor/shared";

// Mock config-store before importing the module under test
vi.mock("../../db/config-store.ts", () => ({
  getPersona: vi.fn(() => ({ emotionsEnabled: false })),
}));

import {
  getCategoryWeights,
  classifyQueryCategories,
  computeCompositeScore,
  computeCompositeScoreDetailed,
} from "../memory-projections.ts";
import { getPersona } from "../../db/config-store.ts";

const mockGetPersona = vi.mocked(getPersona);

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    space: "user",
    category: "profile",
    abstract: "test memory",
    overview: "test overview",
    detail: "test detail",
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
    content: "test memory",
    ...overrides,
  };
}

// ── getCategoryWeights ──────────────────────────────────

describe("getCategoryWeights", () => {
  it("returns default weights for web channel", () => {
    const w = getCategoryWeights("web");
    expect(w.profile).toBe(1.0);
    expect(w.entity).toBe(1.0);
  });

  it("returns technical weights for discord", () => {
    const w = getCategoryWeights("discord");
    expect(w.entity).toBe(1.4);
    expect(w.profile).toBe(0.5);
  });

  it("returns technical weights for slack", () => {
    const w = getCategoryWeights("slack");
    expect(w.case).toBe(1.4);
  });

  it("returns casual weights for telegram", () => {
    const w = getCategoryWeights("telegram");
    expect(w.profile).toBe(1.4);
    expect(w.case).toBe(0.5);
  });

  it("returns casual weights for whatsapp", () => {
    const w = getCategoryWeights("whatsapp");
    expect(w.preference).toBe(1.3);
  });

  it("returns default weights for unknown channel", () => {
    const w = getCategoryWeights("unknown");
    expect(w.profile).toBe(1.0);
  });

  it("returns default weights for undefined channel", () => {
    const w = getCategoryWeights(undefined);
    expect(w.profile).toBe(1.0);
  });
});

// ── classifyQueryCategories ─────────────────────────────

describe("classifyQueryCategories", () => {
  it("classifies profile queries", () => {
    const result = classifyQueryCategories("what is my name?");
    expect(result.primary).toContain("profile");
  });

  it("classifies preference queries", () => {
    const result = classifyQueryCategories("I prefer dark mode");
    expect(result.primary).toContain("preference");
  });

  it("classifies entity queries", () => {
    const result = classifyQueryCategories("what framework are we using?");
    expect(result.primary).toContain("entity");
  });

  it("classifies event queries", () => {
    const result = classifyQueryCategories("what happened yesterday?");
    expect(result.primary).toContain("event");
  });

  it("classifies pattern queries", () => {
    const result = classifyQueryCategories("what is my usual workflow?");
    expect(result.primary).toContain("pattern");
  });

  it("classifies case/debugging queries", () => {
    const result = classifyQueryCategories("how did I fix that bug?");
    expect(result.primary).toContain("case");
  });

  it("returns all categories as fallback for generic queries", () => {
    const result = classifyQueryCategories("tell me something interesting");
    expect(result.primary).toHaveLength(0);
    expect(result.fallback).toHaveLength(6);
  });

  it("puts unmatched categories in fallback", () => {
    const result = classifyQueryCategories("my name is Luka");
    expect(result.primary).toContain("profile");
    expect(result.fallback).not.toContain("profile");
    expect(result.fallback.length).toBeGreaterThan(0);
  });
});

// ── computeCompositeScore ───────────────────────────────

describe("computeCompositeScore", () => {
  beforeEach(() => {
    mockGetPersona.mockReturnValue({ emotionsEnabled: false } as ReturnType<typeof getPersona>);
  });

  it("returns a score between 0 and 1", () => {
    const memory = makeMemory({ strength: 0.5 });
    const score = computeCompositeScore(memory, 0.8, {}, false);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("higher vector similarity produces higher score", () => {
    const memory = makeMemory();
    const lowSim = computeCompositeScore(memory, 0.1, {}, false);
    const highSim = computeCompositeScore(memory, 0.9, {}, false);
    expect(highSim).toBeGreaterThan(lowSim);
  });

  it("higher strength produces higher score", () => {
    const weak = makeMemory({ strength: 0.1 });
    const strong = makeMemory({ strength: 0.9 });
    const weakScore = computeCompositeScore(weak, 0.5, {}, false);
    const strongScore = computeCompositeScore(strong, 0.5, {}, false);
    expect(strongScore).toBeGreaterThan(weakScore);
  });

  it("more recent memories score higher", () => {
    const old = makeMemory({
      lastAccessedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days ago
    });
    const recent = makeMemory({
      lastAccessedAt: new Date().toISOString(),
    });
    const oldScore = computeCompositeScore(old, 0.5, {}, false);
    const recentScore = computeCompositeScore(recent, 0.5, {}, false);
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("includes emotional resonance when emotions enabled", () => {
    const memory = makeMemory({ emotionalValence: 0.8 });
    const noEmo = computeCompositeScore(memory, 0.5, { currentEmotionalValence: 0.8 }, false);
    const withEmo = computeCompositeScore(memory, 0.5, { currentEmotionalValence: 0.8 }, true);
    // With emotions enabled, emotional resonance is high (similar valence)
    // Scores differ because weight distribution changes
    expect(noEmo).not.toBe(withEmo);
  });

  it("respects channel-specific category weights", () => {
    const entityMemory = makeMemory({ category: "entity" });
    const webScore = computeCompositeScore(entityMemory, 0.5, { channelType: "web" }, false);
    const discordScore = computeCompositeScore(entityMemory, 0.5, { channelType: "discord" }, false);
    // Discord boosts entity weight (1.4 vs 1.0)
    expect(discordScore).toBeGreaterThan(webScore);
  });
});

// ── computeCompositeScoreDetailed ───────────────────────

describe("computeCompositeScoreDetailed", () => {
  it("returns all score components", () => {
    const memory = makeMemory();
    const breakdown = computeCompositeScoreDetailed(memory, 0.5, {}, false);
    expect(breakdown).toHaveProperty("vector");
    expect(breakdown).toHaveProperty("strength");
    expect(breakdown).toHaveProperty("recency");
    expect(breakdown).toHaveProperty("categoryRelevance");
    expect(breakdown).toHaveProperty("emotionalResonance");
    expect(breakdown).toHaveProperty("composite");
  });

  it("emotionalResonance is null when emotions disabled", () => {
    const memory = makeMemory();
    const breakdown = computeCompositeScoreDetailed(memory, 0.5, {}, false);
    expect(breakdown.emotionalResonance).toBeNull();
  });

  it("emotionalResonance is a number when emotions enabled", () => {
    const memory = makeMemory({ emotionalValence: 0.5 });
    const breakdown = computeCompositeScoreDetailed(memory, 0.5, { currentEmotionalValence: 0.5 }, true);
    expect(breakdown.emotionalResonance).toBeTypeOf("number");
  });

  it("composite matches computeCompositeScore", () => {
    const memory = makeMemory();
    const score = computeCompositeScore(memory, 0.7, { channelType: "web" }, false);
    const breakdown = computeCompositeScoreDetailed(memory, 0.7, { channelType: "web" }, false);
    expect(breakdown.composite).toBeCloseTo(score, 5);
  });
});
