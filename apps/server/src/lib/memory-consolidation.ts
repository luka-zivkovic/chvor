/**
 * Memory Consolidation Engine — "Sleep" cycles for the memory system.
 *
 * Runs during idle periods to reorganize, merge, and synthesize memories:
 *
 * Pass 1 — Fragment Merging: combine related memory clusters into coherent narratives
 * Pass 2 — Insight Synthesis: discover higher-order patterns across categories
 * Pass 3 — Narrative Weaving: connect temporal event sequences into stories
 * Pass 4 — Graph Pruning: remove weak edges and stale access logs
 */

import { generateText } from "ai";
import { createModelForRole } from "./llm-router.ts";
import {
  getMemoryClusters,
  getMemoriesSince,
  createMemory,
  createEdge,
  getEdgesForMemory,
  reduceMemoryStrength,
  pruneWeakEdges,
  pruneAccessLog,
} from "../db/memory-store.ts";
import type { CreateMemoryOptions } from "../db/memory-store.ts";
import { containsSensitiveData } from "./sensitive-filter.ts";
import { getCognitiveMemoryConfig, getBrainConfig, getConfig, setConfig } from "../db/config-store.ts";
import type { Memory } from "@chvor/shared";

let consolidationTimer: ReturnType<typeof setInterval> | null = null;
let lastConsolidationAt: string | null = getConfig("memory.lastConsolidationAt") ?? null;
let consolidationInProgress: Promise<unknown> | null = null; // concurrency lock

const CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIN_NEW_MEMORIES_FOR_CONSOLIDATION = 5;

// ─── Pass 1: Fragment Merging ───────────────────────────────

const MERGE_PROMPT = `You are merging a cluster of related memory fragments into a single coherent memory.

Given these fragments (all about the same topic/category), create ONE merged memory.

Return a JSON object with:
- "abstract": one concise sentence (max 120 chars)
- "overview": 2-3 sentence paragraph with full context
- "detail": comprehensive narrative combining all fragments (if needed, otherwise null)

Rules:
- Preserve ALL specific facts, names, numbers, and dates
- Remove redundancy — don't repeat the same fact
- Keep the most recent/accurate version if fragments conflict
- NEVER include credentials, API keys, or secrets
- Return ONLY the JSON object`;

const MAX_CLUSTER_SIZE = 10; // max fragments per merge to stay within token budget
const LLM_TIMEOUT_MS = 30_000; // 30s timeout per LLM call

async function mergeFragments(cluster: Memory[]): Promise<CreateMemoryOptions | null> {
  let model;
  try {
    model = createModelForRole("lightweight");
  } catch (err) {
    console.warn("[consolidation] LLM model unavailable for fragment merging:", (err as Error).message);
    return null;
  }

  // Cap cluster size to prevent unbounded prompt
  const capped = cluster.slice(0, MAX_CLUSTER_SIZE);
  // Sanitize stored content to prevent prompt injection via user-controlled memory fields
  const sanitize = (s: string, maxLen: number) => s.replace(/["\n\r]/g, " ").slice(0, maxLen);
  const fragments = capped
    .map((m, i) => {
      const overview = m.overview ? `\n  Context: ${sanitize(m.overview, 500)}` : "";
      return `Fragment ${i + 1} [${m.category}]: ${sanitize(m.abstract, 200)}${overview}`;
    })
    .join("\n\n");

  const result = await generateText({
    model,
    system: MERGE_PROMPT,
    messages: [{ role: "user", content: fragments }],
    maxSteps: 1,
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  let text = result.text.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(text);

    if (typeof parsed?.abstract !== "string" || !parsed.abstract.trim()) {
      console.warn("[consolidation] merge result missing valid abstract");
      return null;
    }

    if (containsSensitiveData(JSON.stringify(parsed))) return null;

    // Confidence = average of source fragments (don't inflate beyond sources)
    const avgConfidence = cluster.reduce((sum, m) => sum + m.confidence, 0) / cluster.length;

    return {
      abstract: parsed.abstract.slice(0, 200),
      overview: typeof parsed.overview === "string" ? parsed.overview.slice(0, 1000) : null,
      detail: typeof parsed.detail === "string" ? parsed.detail.slice(0, 5000) : null,
      category: cluster[0].category,
      space: cluster[0].space,
      confidence: Math.min(0.95, avgConfidence + 0.05), // slight boost for consolidation, capped
      provenance: "consolidated",
      sourceChannel: "consolidation",
      sourceSessionId: "system",
    };
  } catch {
    console.warn("[consolidation] failed to parse merge result");
    return null;
  }
}

// ─── Pass 2: Insight Synthesis ──────────────────────────────

const INSIGHT_PROMPT = `Analyze these memories and identify ONE higher-order pattern or insight that connects them.

Return a JSON object with:
- "abstract": one sentence describing the insight/pattern (max 120 chars)
- "overview": 2-3 sentences explaining the pattern and its evidence

Rules:
- The insight must be genuinely useful — something the AI can reference in future conversations
- Focus on behavioral patterns, preferences, or recurring themes
- Don't state the obvious — find non-trivial connections
- Return ONLY the JSON object, or [] if no meaningful insight exists`;

async function synthesizeInsight(
  memories: Memory[],
): Promise<CreateMemoryOptions | null> {
  let model;
  try {
    model = createModelForRole("lightweight");
  } catch (err) {
    console.warn("[consolidation] LLM model unavailable for insight synthesis:", (err as Error).message);
    return null;
  }

  const facts = memories
    .slice(0, 20) // cap input size
    .map((m) => `[${m.category}] ${m.abstract.slice(0, 200)}`)
    .join("\n");

  const result = await generateText({
    model,
    system: INSIGHT_PROMPT,
    messages: [{ role: "user", content: facts }],
    maxSteps: 1,
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  let text = result.text.trim();
  if (text === "[]" || text === "null") return null;
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(text);

    if (typeof parsed?.abstract !== "string" || !parsed.abstract.trim()) return null;
    if (containsSensitiveData(JSON.stringify(parsed))) return null;

    return {
      abstract: parsed.abstract.slice(0, 200),
      overview: typeof parsed.overview === "string" ? parsed.overview.slice(0, 1000) : null,
      category: "pattern",
      space: "user",
      confidence: 0.6, // lower confidence for synthesized insights
      provenance: "consolidated",
      sourceChannel: "consolidation",
      sourceSessionId: "system",
    };
  } catch {
    return null;
  }
}

// ─── Pass 3: Narrative Weaving ──────────────────────────────

const NARRATIVE_PROMPT = `These are chronologically ordered events about the same topic. Weave them into a single timeline narrative.

Return a JSON object with:
- "abstract": one sentence summarizing the story arc (max 120 chars)
- "overview": the narrative as a coherent paragraph (2-4 sentences)
- "detail": full timeline with specifics (if more than 3 events)

Rules:
- Preserve chronological order and causality
- Highlight decisions, turning points, and outcomes
- Return ONLY the JSON object, or [] if the events don't form a coherent narrative`;

async function weaveNarrative(
  events: Memory[],
): Promise<CreateMemoryOptions | null> {
  if (events.length < 3) return null;

  let model;
  try {
    model = createModelForRole("lightweight");
  } catch (err) {
    console.warn("[consolidation] LLM model unavailable for narrative weaving:", (err as Error).message);
    return null;
  }

  // Sanitize stored content to prevent prompt injection via user-controlled memory fields
  const sanitize = (s: string, maxLen: number) => s.replace(/["\n\r]/g, " ").slice(0, maxLen);
  const timeline = events
    .slice(0, MAX_CLUSTER_SIZE)
    .map((m) => `[${new Date(m.createdAt).toLocaleDateString()}] ${sanitize(m.abstract, 200)}${m.overview ? ` — ${sanitize(m.overview, 300)}` : ""}`)
    .join("\n");

  const result = await generateText({
    model,
    system: NARRATIVE_PROMPT,
    messages: [{ role: "user", content: timeline }],
    maxSteps: 1,
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  let text = result.text.trim();
  if (text === "[]" || text === "null") return null;
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(text);

    if (typeof parsed?.abstract !== "string" || !parsed.abstract.trim()) return null;
    if (containsSensitiveData(JSON.stringify(parsed))) return null;

    return {
      abstract: parsed.abstract.slice(0, 200),
      overview: typeof parsed.overview === "string" ? parsed.overview.slice(0, 1000) : null,
      detail: typeof parsed.detail === "string" ? parsed.detail.slice(0, 5000) : null,
      category: "event",
      space: "user",
      confidence: 0.7,
      provenance: "consolidated",
      sourceChannel: "consolidation",
      sourceSessionId: "system",
    };
  } catch {
    return null;
  }
}

// ─── Main consolidation runner ──────────────────────────────

export async function runConsolidation(): Promise<{
  merged: number;
  insights: number;
  narratives: number;
  pruned: number;
}> {
  // Prevent overlapping runs (timer + manual trigger)
  if (consolidationInProgress) {
    console.log("[consolidation] skipping — previous run still in progress");
    return { merged: 0, insights: 0, narratives: 0, pruned: 0 };
  }

  const run = doConsolidation();
  consolidationInProgress = run;
  try {
    return await run;
  } finally {
    consolidationInProgress = null;
  }
}

async function doConsolidation(): Promise<{
  merged: number;
  insights: number;
  narratives: number;
  pruned: number;
}> {
  const config = getCognitiveMemoryConfig();
  if (!config.consolidationEnabled) {
    return { merged: 0, insights: 0, narratives: 0, pruned: 0 };
  }

  console.log("[consolidation] starting consolidation pass...");
  let merged = 0;
  let insights = 0;
  let narratives = 0;

  // Check if there are enough new memories to justify consolidation
  if (lastConsolidationAt) {
    const newMemories = getMemoriesSince(lastConsolidationAt);
    if (newMemories.length < MIN_NEW_MEMORIES_FOR_CONSOLIDATION) {
      console.log(`[consolidation] skipping — only ${newMemories.length} new memories since last run`);
      lastConsolidationAt = new Date().toISOString();
      setConfig("memory.lastConsolidationAt", lastConsolidationAt);
      return { merged: 0, insights: 0, narratives: 0, pruned: 0 };
    }
  }

  // Build cluster graph once — reuse across passes (H4 fix)
  const allClusters = getMemoryClusters(2);
  const largeClusters = allClusters.filter((c) => c.memories.length >= 3);

  // Pass 1: Fragment merging
  // Skip memories already consolidated (provenance = "consolidated") to prevent re-merging (H2 fix)
  const mergeCandidates = largeClusters
    .map((c) => ({
      ...c,
      memories: c.memories.filter((m) => m.provenance !== "consolidated"),
    }))
    .filter((c) => c.memories.length >= 3);

  for (const cluster of mergeCandidates.slice(0, 5)) { // max 5 clusters per pass
    try {
      const mergedOpts = await mergeFragments(cluster.memories);
      if (!mergedOpts) continue;
      const newMemory = createMemory(mergedOpts);
      // Only reduce originals AFTER confirming merge was persisted
      for (const original of cluster.memories) {
        createEdge(newMemory.id, original.id, "narrative", 0.7);
        reduceMemoryStrength(original.id, 0.5); // halve strength so originals fade over multiple consolidation cycles
      }
      merged++;
      console.log(`[consolidation] merged ${cluster.memories.length} fragments: "${mergedOpts.abstract}"`);
    } catch (err) {
      console.error(`[consolidation] failed to merge cluster, skipping:`, err);
    }
  }

  // Pass 2: Insight synthesis (cross-category patterns)
  // Skipped in low-token mode to reduce LLM calls
  // Exclude consolidated memories to prevent runaway pattern-of-pattern growth
  const { lowTokenMode } = getBrainConfig();
  if (lowTokenMode) {
    console.log("[consolidation] skipping passes 2+3 (low-token mode)");
  } else try {
    const seen = new Set<string>();
    const highAccessMemories = allClusters.flatMap((c) => c.memories)
      .filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return m.accessCount >= 3 && m.provenance !== "consolidated" && m.category !== "pattern";
      })
      .slice(0, 20);

    if (highAccessMemories.length >= 5) {
      // Skip memories already used as insight sources (have inbound causal edge from a consolidated memory)
      const unusedForInsight = highAccessMemories.filter((m) => {
        const edges = getEdgesForMemory(m.id, 20);
        return !edges.some((e) => e.relation === "causal" && e.sourceId !== m.id);
      });

      if (unusedForInsight.length >= 5) {
        const insightOpts = await synthesizeInsight(unusedForInsight);
        if (insightOpts) {
          const newInsight = createMemory(insightOpts);
          // Link insight to source memories
          for (const source of unusedForInsight.slice(0, 5)) {
            createEdge(newInsight.id, source.id, "causal", 0.5);
          }
          insights++;
          console.log(`[consolidation] synthesized insight: "${insightOpts.abstract}"`);
        }
      }
    }
  } catch (err) {
    console.error("[consolidation] insight synthesis failed:", err);
  }

  // Pass 3: Narrative weaving (event timelines) — skipped in low-token mode
  if (!lowTokenMode) {
    const eventClusters = largeClusters
      .filter((c) => c.memories.some((m) => m.category === "event"))
      .map((c) => ({
        ...c,
        memories: c.memories.filter((m) => m.category === "event" && m.provenance !== "consolidated"),
      }))
      .filter((c) => c.memories.length >= 3);

    for (const cluster of eventClusters.slice(0, 3)) {
      try {
        const narrativeOpts = await weaveNarrative(cluster.memories);
        if (!narrativeOpts) continue;
        const newNarrative = createMemory(narrativeOpts);
        for (const event of cluster.memories) {
          createEdge(newNarrative.id, event.id, "narrative", 0.8);
          // Reduce source event strength to prevent re-weaving (consistent with Pass 1)
          reduceMemoryStrength(event.id, 0.5);
        }
        narratives++;
        console.log(`[consolidation] wove narrative: "${narrativeOpts.abstract}"`);
      } catch (err) {
        console.error(`[consolidation] failed to weave narrative, skipping cluster:`, err);
      }
    }
  }

  // Pass 4: Graph pruning
  const prunedEdges = pruneWeakEdges(0.1);
  const prunedLogs = pruneAccessLog(90);
  const pruned = prunedEdges + prunedLogs;
  if (pruned > 0) {
    console.log(`[consolidation] pruned ${prunedEdges} weak edges, ${prunedLogs} old access logs`);
  }

  lastConsolidationAt = new Date().toISOString();
  setConfig("memory.lastConsolidationAt", lastConsolidationAt);
  console.log(`[consolidation] complete — merged: ${merged}, insights: ${insights}, narratives: ${narratives}, pruned: ${pruned}`);

  return { merged, insights, narratives, pruned };
}

/** Start periodic consolidation. */
export function startConsolidation(): void {
  if (consolidationTimer) return;
  consolidationTimer = setInterval(() => {
    runConsolidation().catch((err) =>
      console.error("[consolidation] periodic run failed:", err)
    );
  }, CONSOLIDATION_INTERVAL_MS);
  consolidationTimer.unref();
}

/** Stop periodic consolidation. */
export function stopConsolidation(): void {
  if (consolidationTimer) {
    clearInterval(consolidationTimer);
    consolidationTimer = null;
  }
}
