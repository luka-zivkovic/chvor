import { generateText } from "ai";
import { createModelForRole } from "./llm-router.ts";
import {
  getAllMemoryContents,
  createMemory,
  findTopKSimilarMemories,
  updateMemory,
  updateMemoryOverview,
  createEdge,
  getMemory,
  reduceMemoryStrength,
} from "../db/memory-store.ts";
import type { CreateMemoryOptions } from "../db/memory-store.ts";
import { containsSensitiveData } from "./sensitive-filter.ts";
import { getBrainConfig } from "../db/config-store.ts";
import { getPersona } from "../db/config-store.ts";
import { getLatestEmotion } from "../db/emotion-store.ts";
import { calculateInitialStrength } from "./memory-decay.ts";
import type { ChatMessage, Memory, MemoryCategory, MemoryProvenance } from "@chvor/shared";

const EXTRACTION_WINDOW = 10; // last 10 messages (≈5 turns)

const EXTRACTION_PROMPT = `Extract memorable facts from the conversation as a JSON array of objects.

Each object must have:
- "abstract": one concise sentence summarizing the fact (max 120 chars)
- "overview": a paragraph with context (2-3 sentences, optional, null if simple fact)
- "detail": full narrative if complex (optional, null for simple facts)
- "category": one of "profile", "preference", "entity", "event", "pattern", "case"
- "confidence": 0.0–1.0 how certain you are (1.0 = user stated it directly, 0.5 = inferred)
- "provenance": "stated" if user said it directly, "inferred" if deduced from context
- "relatedEntities": array of entity names mentioned (people, projects, tools, companies)

Categories:
- profile: personal info (name, location, job, age)
- preference: likes, dislikes, communication/tool preferences
- entity: projects, people, companies, tools the user works with
- event: decisions, milestones, incidents
- pattern: recurring behaviors, habits, workflows
- case: specific problems + solutions

Rules:
- Only extract NEW facts from the MOST RECENT user+assistant pair. Use older messages for context only.
- Merge with existing facts: if a fact is already known (see list below), skip it even if worded differently.
- Extract concrete facts, not task ephemera ("User asked about X" is not a fact).
- Do NOT extract general knowledge the assistant already knows.
- NEVER include credentials, API keys, tokens, passwords, or secrets.
- If a new fact CONTRADICTS an existing fact, include it with a note in the overview.
- Return ONLY a JSON array. Empty array [] if nothing new.`;

// Per-session extraction chains — prevents cross-session head-of-line blocking
const extractionChains = new Map<string, Promise<void>>();

// Per-session turn counters for batching — cleaned up when chains complete
const turnCounters = new Map<string, number>();

// Trivial messages that rarely contain memorable facts
const TRIVIAL_PATTERN = /^(hi|hello|hey|yes|no|ok|okay|thanks|thank you|bye|sure|got it|cool|yep|nope|right|hm+|ah+)\b/i;

/**
 * Check if the last user message is trivial (greeting, confirmation, etc.)
 */
function isTrivialMessage(messages: ChatMessage[]): boolean {
  const lastUser = messages.findLast((m) => m.role === "user");
  if (!lastUser) return true;
  const content = lastUser.content.trim();
  return content.length < 20 && TRIVIAL_PATTERN.test(content);
}

interface ExtractedFact {
  abstract: string;
  overview?: string | null;
  detail?: string | null;
  category: MemoryCategory;
  confidence: number;
  provenance: MemoryProvenance;
  relatedEntities?: string[];
}

/**
 * Extract memorable facts from recent conversation messages (sliding window).
 * - Batched: only runs every N turns per session (configurable via brain.memoryBatchSize)
 * - Skips trivial exchanges (greetings, confirmations)
 * - Per-session serialization — no cross-session blocking
 * - Cleans up promise chains when resolved to prevent memory leaks
 */
export function extractAndStoreMemories(
  recentMessages: ChatMessage[],
  channelType: string,
  sessionId: string,
): Promise<void> {
  // Batch: increment counter, skip if not at batch boundary
  const brainCfg = getBrainConfig();
  // Low-token mode doubles effective batch size to reduce LLM calls
  const batchSize = brainCfg.lowTokenMode ? brainCfg.memoryBatchSize * 2 : brainCfg.memoryBatchSize;
  const count = (turnCounters.get(sessionId) ?? 0) + 1;
  if (count < batchSize) {
    turnCounters.set(sessionId, count);
    return Promise.resolve();
  }
  turnCounters.set(sessionId, 0);

  // Skip trivial exchanges
  if (isTrivialMessage(recentMessages)) {
    console.log("[memory] skipping extraction — trivial exchange");
    return Promise.resolve();
  }

  // Per-session chain (prevents cross-session head-of-line blocking)
  const prev = extractionChains.get(sessionId) ?? Promise.resolve();
  const next = prev
    .then(() => doExtraction(recentMessages, channelType, sessionId))
    .catch((err) => console.error("[memory] extraction error in chain:", err));

  extractionChains.set(sessionId, next);

  // Clean up resolved chain + turn counter to prevent unbounded growth
  next.then(() => {
    if (extractionChains.get(sessionId) === next) {
      extractionChains.delete(sessionId);
    }
  });

  return next;
}

/** Clean up per-session state when a session is deleted/reset. */
export function cleanupSessionExtractionState(sessionId: string): void {
  turnCounters.delete(sessionId);
  extractionChains.delete(sessionId);
}

async function generateOverview(memoryId: string, abstract: string): Promise<void> {
  try {
    const model = createModelForRole("lightweight");
    const result = await generateText({
      model,
      system: "Expand this one-line fact into a 2-3 sentence context paragraph. Keep it factual and concise. Return ONLY the paragraph text.",
      messages: [{ role: "user", content: abstract }],
      maxSteps: 1,
      abortSignal: AbortSignal.timeout(15_000),
    });
    const overview = result.text.trim();
    if (overview && overview.length > abstract.length && !containsSensitiveData(overview)) {
      updateMemoryOverview(memoryId, overview);
    }
  } catch {
    // Non-critical — memory works fine without L1
  }
}

// ─── 4-action LLM dedup ─────────────────────────────────────

interface DedupDecision {
  action: "CREATE" | "SKIP" | "MERGE" | "DELETE";
  targetId?: string;
  mergedAbstract?: string;
  reason?: string;
}

/**
 * Ask a lightweight LLM to decide how to handle a new fact vs. similar existing memories.
 * Returns one of CREATE / SKIP / MERGE / DELETE with optional merge text.
 */
async function decideMemoryAction(
  newAbstract: string,
  candidates: Array<{ memory: Memory; similarity: number }>,
): Promise<DedupDecision> {
  try {
    const model = createModelForRole("lightweight");
    // Sanitize inputs to prevent prompt injection via conversation content
    const sanitize = (s: string) => s.replace(/["\n\r]/g, " ").slice(0, 200);
    const candidateList = candidates
      .map((c, i) => `${i + 1}. [${c.memory.category}] ${sanitize(c.memory.abstract)}`)
      .join("\n");

    const result = await generateText({
      model,
      system: `You are deciding how to handle a new memory fact relative to existing similar memories.

New fact: ${sanitize(newAbstract)}

Existing similar memories:
${candidateList}

Decide ONE action:
- CREATE: The new fact is genuinely different. Store it.
- SKIP: The new fact is redundant — an existing memory already captures this.
- MERGE: Combine with an existing memory. Provide the merged text.
- DELETE: The new fact contradicts an existing memory. The old one is wrong.

Return JSON: { "action": "CREATE"|"SKIP"|"MERGE"|"DELETE", "targetId": "..." (for MERGE/DELETE, use the number 1-3), "mergedAbstract": "..." (for MERGE only), "reason": "..." }`,
      messages: [{ role: "user", content: "Decide the action." }],
      maxSteps: 1,
      abortSignal: AbortSignal.timeout(15_000),
    });

    let text = result.text.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(text) as DedupDecision;

    // Validate action
    if (!["CREATE", "SKIP", "MERGE", "DELETE"].includes(parsed.action)) {
      return { action: "CREATE", reason: "invalid action from LLM, defaulting to CREATE" };
    }

    // Resolve numeric targetId to actual memory ID
    if (parsed.targetId && (parsed.action === "MERGE" || parsed.action === "DELETE")) {
      const idx = parseInt(parsed.targetId as string, 10) - 1;
      if (idx >= 0 && idx < candidates.length) {
        parsed.targetId = candidates[idx].memory.id;
      } else {
        // Invalid target — fall back to CREATE
        return { action: "CREATE", reason: "invalid targetId from LLM, defaulting to CREATE" };
      }
    }

    return parsed;
  } catch {
    // LLM call failed — default to CREATE so we don't lose the fact
    return { action: "CREATE", reason: "LLM dedup call failed, defaulting to CREATE" };
  }
}

async function doExtraction(
  recentMessages: ChatMessage[],
  channelType: string,
  sessionId: string,
): Promise<void> {
  if (recentMessages.length === 0) return;

  let model;
  try {
    model = createModelForRole("lightweight");
  } catch {
    // No LLM configured — silently skip extraction
    return;
  }

  // Take last N messages as sliding window
  const window = recentMessages.slice(-EXTRACTION_WINDOW);

  // Skip extraction if any message in the window contains sensitive data
  for (const msg of window) {
    if (containsSensitiveData(msg.content)) {
      console.log(`[memory] skipping extraction — ${msg.role} message contains sensitive data`);
      return;
    }
  }

  // Cap per-message length to avoid exceeding lightweight model context window
  const exchange = window
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 2000)}`)
    .join("\n\n");

  // Inject existing facts so the LLM doesn't re-extract them.
  // Sanitize stored abstracts to prevent prompt injection via user-controlled content.
  const existingFacts = getAllMemoryContents();
  let systemPrompt = EXTRACTION_PROMPT;
  if (existingFacts.length > 0) {
    const sanitizedFacts = existingFacts.map(
      (f) => f.replace(/["\n\r]/g, " ").slice(0, 200)
    );
    systemPrompt += `\n\nFacts already stored (do NOT re-extract these or similar facts):\n${sanitizedFacts.map((f) => `- ${f}`).join("\n")}`;
  }

  const result = await generateText({
    model,
    system: systemPrompt,
    messages: [{ role: "user", content: exchange }],
    maxSteps: 1,
    abortSignal: AbortSignal.timeout(30_000),
  });

  // Parse JSON response — strip markdown fences and preamble if present
  let text = result.text.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  // Robust extraction: find the first [ and last ] to handle LLM preamble/postamble
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    text = text.slice(firstBracket, lastBracket + 1);
  }

  let facts: unknown[];
  try {
    facts = JSON.parse(text);
  } catch {
    // The sliding window will re-extract any real facts in the next pass.
    console.warn("[memory] failed to parse extraction result as JSON, skipping batch");
    return;
  }

  if (!Array.isArray(facts)) return;

  // Get current emotion state if emotions are enabled
  const persona = getPersona();
  const emotionSnapshot = persona.emotionsEnabled ? getLatestEmotion(sessionId) : null;

  const initialStrength = calculateInitialStrength(
    persona.emotionsEnabled ?? false,
    emotionSnapshot?.blend.intensity ?? null,
  );

  const createdIds: string[] = [];
  let llmDedupCalls = 0;
  const MAX_LLM_DEDUP_PER_BATCH = 3;

  for (const fact of facts) {
    // Handle both structured (new) and string (legacy) formats
    let extracted: ExtractedFact;
    if (typeof fact === "string") {
      if (!fact.trim()) continue;
      extracted = {
        abstract: fact.trim(),
        category: "profile",
        confidence: 0.7,
        provenance: "extracted",
      };
    } else if (typeof fact === "object" && fact !== null && "abstract" in fact) {
      extracted = fact as ExtractedFact;
    } else {
      continue;
    }

    // Filter out sensitive data
    const textToCheck = [extracted.abstract, extracted.overview, extracted.detail]
      .filter(Boolean)
      .join(" ");
    if (containsSensitiveData(textToCheck)) {
      console.log(`[memory] blocked sensitive fact: "${extracted.abstract.slice(0, 30)}..."`);
      continue;
    }

    // 4-action LLM-based deduplication
    const candidates = await findTopKSimilarMemories(extracted.abstract, 3, 0.5);

    let shouldCreate = true;
    let deleteTargetId: string | undefined;

    if (candidates.length > 0) {
      const topSimilarity = candidates[0].similarity;

      if (topSimilarity > 0.95) {
        // Fast-path: near-exact duplicate — skip without LLM call
        console.log(`[memory] skipped duplicate (sim=${topSimilarity.toFixed(2)}): "${extracted.abstract.slice(0, 60)}"`);
        shouldCreate = false;
      } else if (topSimilarity >= 0.8 && llmDedupCalls >= MAX_LLM_DEDUP_PER_BATCH) {
        // Budget exhausted but high similarity — default to SKIP to prevent duplicates
        console.log(`[memory] skipped (budget exhausted, sim=${topSimilarity.toFixed(2)}): "${extracted.abstract.slice(0, 60)}"`);
        shouldCreate = false;
      } else if (topSimilarity >= 0.5 && llmDedupCalls < MAX_LLM_DEDUP_PER_BATCH) {
        // Medium similarity — ask LLM to decide
        llmDedupCalls++;
        const decision = await decideMemoryAction(extracted.abstract, candidates);

        switch (decision.action) {
          case "SKIP":
            console.log(`[memory] dedup SKIP: "${extracted.abstract.slice(0, 60)}" — ${decision.reason ?? "redundant"}`);
            shouldCreate = false;
            break;

          case "MERGE":
            if (decision.targetId && decision.mergedAbstract) {
              // Normalize LLM output: trim, collapse whitespace, cap length
              const normalizedMerge = decision.mergedAbstract.replace(/\s+/g, " ").trim().slice(0, 200);
              if (!normalizedMerge) break;
              // Check merged output for sensitive data before persisting
              if (containsSensitiveData(normalizedMerge)) {
                console.log(`[memory] blocked sensitive MERGE output, falling through to CREATE`);
                break;
              }
              updateMemory(decision.targetId, normalizedMerge);
              console.log(`[memory] dedup MERGE into ${decision.targetId.slice(0, 8)}: "${normalizedMerge.slice(0, 60)}"`);
              shouldCreate = false;
            }
            // If merge data is missing, fall through to CREATE
            break;

          case "DELETE":
            if (decision.targetId) {
              // Accelerate decay on the contradicted memory
              reduceMemoryStrength(decision.targetId, 0.1);
              console.log(`[memory] dedup DELETE (decay) ${decision.targetId.slice(0, 8)} — ${decision.reason ?? "contradicted"}`);
              // shouldCreate stays true — the new fact will be stored below,
              // and we'll add a "supersedes" edge after creation
              deleteTargetId = decision.targetId;
            }
            break;

          case "CREATE":
          default:
            // shouldCreate stays true
            break;
        }
      }
    }

    if (!shouldCreate) continue;

    // Create new memory with full metadata
    const opts: CreateMemoryOptions = {
      abstract: extracted.abstract,
      overview: extracted.overview ?? null,
      detail: extracted.detail ?? null,
      category: extracted.category ?? "profile",
      confidence: extracted.confidence ?? 0.7,
      provenance: extracted.provenance ?? "extracted",
      emotionalValence: emotionSnapshot?.vad?.valence ?? null,
      emotionalIntensity: emotionSnapshot?.blend.intensity ?? null,
      initialStrength,
      sourceChannel: channelType,
      sourceSessionId: sessionId,
    };

    const stored = createMemory(opts);
    createdIds.push(stored.id);
    console.log(`[memory] stored [${extracted.category}]: "${extracted.abstract}"`);

    // If this was a DELETE action, link the new memory to the superseded one
    if (typeof deleteTargetId === "string" && deleteTargetId) {
      createEdge(stored.id, deleteTargetId, "supersedes", 0.9);
      console.log(`[memory] edge: ${stored.id.slice(0, 8)} supersedes ${deleteTargetId.slice(0, 8)}`);
    }

    // Fire-and-forget L1 overview generation
    if (!opts.overview && opts.abstract.length >= 30) {
      generateOverview(stored.id, opts.abstract).catch(() => {});
    }

    // Create entity edges to earlier batch memories that share related entities
    if (extracted.relatedEntities?.length) {
      const entityPatterns = extracted.relatedEntities
        .filter((e) => e.length >= 3 && e.length <= 100)
        .slice(0, 10) // Cap to prevent unbounded RegExp compilation from LLM output
        .map((e) => new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
      for (const prevId of createdIds.slice(0, -1)) {
        // Only link if the previous memory mentioned a shared entity (word-boundary match)
        const prev = getMemory(prevId);
        if (prev && entityPatterns.some((re) => re.test(prev.abstract))) {
          createEdge(stored.id, prevId, "entity", 0.6);
        }
      }
    }
  }

  // Create temporal edges between all memories extracted in the same batch
  if (createdIds.length > 1) {
    for (let i = 0; i < createdIds.length - 1; i++) {
      createEdge(createdIds[i], createdIds[i + 1], "temporal", 0.3);
    }
  }
}
