/**
 * Memory Projections — Context-aware retrieval scoring.
 *
 * Adapts memory retrieval weights based on the current context:
 * channel type, time of day, and whether emotions are enabled.
 *
 * The same memory graph is viewed through different "projection lenses"
 * depending on the situation.
 */

import type { Memory, MemoryCategory } from "@chvor/shared";
import { getPersona } from "../db/config-store.ts";

// ─── Category weights by channel context ────────────────────

type CategoryWeights = Record<MemoryCategory, number>;

const DEFAULT_WEIGHTS: CategoryWeights = {
  profile: 1.0,
  preference: 1.0,
  entity: 1.0,
  event: 1.0,
  pattern: 1.0,
  case: 1.0,
};

const TECHNICAL_WEIGHTS: CategoryWeights = {
  profile: 0.5,
  preference: 0.8,
  entity: 1.4,
  event: 0.8,
  pattern: 1.3,
  case: 1.4,
};

const CASUAL_WEIGHTS: CategoryWeights = {
  profile: 1.4,
  preference: 1.3,
  entity: 0.8,
  event: 1.1,
  pattern: 0.7,
  case: 0.5,
};

/**
 * Get category weight adjustments for the current context.
 */
export function getCategoryWeights(channelType?: string): CategoryWeights {
  if (channelType === "web") return DEFAULT_WEIGHTS;
  if (channelType === "discord" || channelType === "slack") return TECHNICAL_WEIGHTS;
  if (channelType === "telegram" || channelType === "whatsapp") return CASUAL_WEIGHTS;
  return DEFAULT_WEIGHTS;
}

// ─── DRR-style category classification ──────────────────────

export interface CategoryClassification {
  primary: MemoryCategory[];
  fallback: MemoryCategory[];
}

const CATEGORY_SIGNALS: Array<{ category: MemoryCategory; patterns: RegExp[] }> = [
  {
    category: "profile",
    patterns: [
      /\b(my name|i am|i'm|my age|i live|i work|my job|my role|my title|about me)\b/i,
      /\b(where (do )?i (live|work)|who am i)\b/i,
    ],
  },
  {
    category: "preference",
    patterns: [
      /\b(i (like|prefer|hate|dislike|want|love|enjoy|avoid))\b/i,
      /\b(my (favorite|preferred|style|taste))\b/i,
    ],
  },
  {
    category: "entity",
    patterns: [
      /\b(project|tool|framework|library|service|team|company|org)\b/i,
      /\b(using|built with|migrated to|switched to)\b/i,
    ],
  },
  {
    category: "event",
    patterns: [
      /\b(happened|decided|yesterday|last (week|month|year)|recently|today)\b/i,
      /\b(milestone|deployed|launched|released|migrated|upgraded)\b/i,
      /\b\d{4}[-/]\d{2}/i, // dates
    ],
  },
  {
    category: "pattern",
    patterns: [
      /\b(usually|always|every time|whenever|tend to|workflow|routine|habit)\b/i,
      /\b(my (approach|process|method|way of))\b/i,
    ],
  },
  {
    category: "case",
    patterns: [
      /\b(error|bug|fixed|solution|problem|issue|crash|broken|failed)\b/i,
      /\b(how (did )?(i|we) (fix|solve|debug|resolve))\b/i,
    ],
  },
];

/**
 * Classify which memory categories are relevant to a query.
 * Uses keyword heuristics (no LLM call) for fast category-first retrieval.
 */
export function classifyQueryCategories(query: string): CategoryClassification {
  const matched: MemoryCategory[] = [];

  for (const { category, patterns } of CATEGORY_SIGNALS) {
    if (patterns.some((p) => p.test(query))) {
      matched.push(category);
    }
  }

  if (matched.length === 0) {
    // No strong signals — all categories are fallback
    return {
      primary: [],
      fallback: ["profile", "preference", "entity", "event", "pattern", "case"],
    };
  }

  const allCategories: MemoryCategory[] = ["profile", "preference", "entity", "event", "pattern", "case"];
  return {
    primary: matched,
    fallback: allCategories.filter((c) => !matched.includes(c)),
  };
}

// ─── Composite scoring ──────────────────────────────────────

export interface ScoringContext {
  channelType?: string;
  currentEmotionalValence?: number | null;
}

/**
 * Compute composite retrieval score for a memory.
 *
 * When emotions enabled (5 signals):
 *   score = vectorSim × 0.35 + strength × 0.25 + recency × 0.15
 *         + categoryRelevance × 0.15 + emotionalResonance × 0.10
 *
 * When emotions disabled (4 signals, weights redistributed):
 *   score = vectorSim × 0.40 + strength × 0.30 + recency × 0.15
 *         + categoryRelevance × 0.15
 */
export function computeCompositeScore(
  memory: Memory,
  vectorSimilarity: number,
  context: ScoringContext,
  emotionsEnabled?: boolean,
): number {
  const useEmotions = emotionsEnabled ?? getPersona().emotionsEnabled === true;
  const categoryWeights = getCategoryWeights(context.channelType);

  // Strength (already decay-adjusted)
  const strength = memory.strength;

  // Recency: exponential decay from last access (days)
  const lastActive = memory.lastAccessedAt ?? memory.createdAt;
  const daysSince = Math.max(0, (Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24));
  const recency = Math.exp(-0.05 * daysSince); // slow decay

  // Category relevance: applied as a multiplier on the final score (not additive)
  // so that cross-channel weights (e.g. entity=1.4 on technical channels) scale
  // the entire score rather than distorting the weighted sum
  const categoryRelevance = categoryWeights[memory.category] ?? 1.0;

  if (useEmotions) {
    // Emotional resonance: boost memories formed in similar emotional states
    let emotionalResonance = 0.5; // neutral default
    if (
      memory.emotionalValence != null &&
      context.currentEmotionalValence != null
    ) {
      // Closer valence = higher resonance (0–1 scale), clamped to [0, 1]
      const valenceDiff = Math.abs(memory.emotionalValence - context.currentEmotionalValence);
      emotionalResonance = Math.max(0, 1.0 - Math.min(valenceDiff, 2.0) / 2.0);
    }

    const baseScore =
      vectorSimilarity * 0.35 +
      strength * 0.25 +
      recency * 0.25 +
      emotionalResonance * 0.15;
    return Math.min(1.0, baseScore * categoryRelevance);
  }

  // Emotions disabled — redistribute emotional weight
  const baseScore =
    vectorSimilarity * 0.40 +
    strength * 0.30 +
    recency * 0.30;
  return Math.min(1.0, baseScore * categoryRelevance);
}

// ─── Detailed scoring (for observability) ───────────────────

export interface ScoreBreakdown {
  vector: number;
  strength: number;
  recency: number;
  categoryRelevance: number;
  emotionalResonance: number | null;
  composite: number;
}

/**
 * Compute composite score with full signal breakdown for observability.
 */
export function computeCompositeScoreDetailed(
  memory: Memory,
  vectorSimilarity: number,
  context: ScoringContext,
  emotionsEnabled?: boolean,
): ScoreBreakdown {
  const useEmotions = emotionsEnabled ?? getPersona().emotionsEnabled === true;
  const categoryWeights = getCategoryWeights(context.channelType);

  const strength = memory.strength;
  const lastActive = memory.lastAccessedAt ?? memory.createdAt;
  const daysSince = (Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24);
  const recency = Math.exp(-0.05 * Math.max(0, daysSince));
  const categoryRelevance = categoryWeights[memory.category] ?? 1.0;

  let emotionalResonance: number | null = null;
  let composite: number;

  if (useEmotions) {
    emotionalResonance = 0.5;
    if (memory.emotionalValence != null && context.currentEmotionalValence != null) {
      const valenceDiff = Math.abs(memory.emotionalValence - context.currentEmotionalValence);
      emotionalResonance = Math.max(0, 1.0 - Math.min(valenceDiff, 2.0) / 2.0);
    }
    const baseScore =
      vectorSimilarity * 0.35 +
      strength * 0.25 +
      recency * 0.25 +
      emotionalResonance * 0.15;
    composite = Math.min(1.0, baseScore * categoryRelevance);
  } else {
    const baseScore =
      vectorSimilarity * 0.40 +
      strength * 0.30 +
      recency * 0.30;
    composite = Math.min(1.0, baseScore * categoryRelevance);
  }

  return { vector: vectorSimilarity, strength, recency, categoryRelevance, emotionalResonance, composite };
}

/**
 * Re-rank a list of memories using composite scoring.
 * Each memory needs a vectorSimilarity score (from the initial retrieval).
 */
export function rerankMemories(
  memories: Array<{ memory: Memory; vectorSimilarity: number }>,
  context: ScoringContext,
): Array<{ memory: Memory; score: number }> {
  const emotionsEnabled = getPersona().emotionsEnabled === true;
  return memories
    .map(({ memory, vectorSimilarity }) => ({
      memory,
      score: computeCompositeScore(memory, vectorSimilarity, context, emotionsEnabled),
    }))
    .sort((a, b) => b.score - a.score);
}
