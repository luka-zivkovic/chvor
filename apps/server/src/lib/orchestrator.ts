import { streamText } from "ai";
import type { CoreMessage } from "ai";
import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ContextAssemblyCandidate,
  ExecutionEvent,
  ToolActionSummary,
  EmotionState,
  EmotionSnapshot,
  MediaArtifact,
  ModelUsedInfo,
  Memory,
} from "@chvor/shared";
import { logError } from "./error-logger.ts";
import { LLMError } from "./errors.ts";
import { createEmotionParser, stripEmotionMarker } from "./emotion-parser.ts";
import {
  createEmotionEngine,
  userSentimentSignal,
  toolOutcomeSignal,
  conversationPaceSignal,
  llmSelfReportSignal,
} from "./emotion-engine.ts";
import type { EmotionEngine } from "./emotion-engine.ts";
import { AdvancedEmotionEngine } from "./advanced-emotion-engine.ts";
import { buildAdvancedEmotionContext } from "./advanced-emotion-modulation.ts";
import {
  insertEmotionSnapshot,
  getSessionEmotionArc,
  getLatestEmotion,
} from "../db/emotion-store.ts";
import { getUnresolvedResidues } from "../db/emotion-residue-store.ts";
import {
  getRelationshipState,
  updateRelationshipAfterTurn,
  incrementRelationshipSession,
} from "../db/relationship-store.ts";
import {
  createModel,
  getContextWindow,
  getMaxTokens,
  resolveRoleConfig,
  resolveRoleChain,
  resolveMediaConfig,
  isFallbackEligible,
} from "./llm-router.ts";
import type { ResolvedConfig } from "./llm-router.ts";
import { estimateMediaTokens } from "./token-counter.ts";
import { buildToolDefinitions, snapshotActiveMcpSecrets } from "./tool-builder.ts";
import { loadSkills, loadTools } from "./capability-loader.ts";
import {
  getRelevantMemoriesWithScores,
  getRelevantMemoriesByCategoryTiers,
  getMemory,
} from "../db/memory-store.ts";
import {
  rerankMemories,
  classifyQueryCategories,
  computeCompositeScoreDetailed,
} from "./memory-projections.ts";
import type { ScoreBreakdown } from "./memory-projections.ts";
import { spreadActivation, strengthenCoAccessedEdges } from "./memory-graph.ts";
import {
  computeTopicHash,
  updateAccessLogTopics,
  predictNextMemories,
} from "./memory-preloader.ts";
import { getCognitiveMemoryConfig } from "../db/config-store.ts";
import {
  getPersona,
  isCapabilityEnabled,
  getExtendedThinking,
  getBrainConfig,
} from "../db/config-store.ts";
import { buildSystemPrompt } from "./orchestrator/system-prompt.ts";
import {
  assertContextAttemptFits,
  assembleTurnContext,
  ContextStableSourceError,
  projectToolDefinitionsForContext,
  selectConservativeContextProfile,
  type ContextToolDefinition,
} from "./orchestrator/context-assembler.ts";
import { mapMemoryBlocksToContextCandidates } from "./orchestrator/context-block-adapter.ts";
import { mapGraphMemoryToContextCandidate } from "./orchestrator/context-memory-adapter.ts";
import { mapWorkingContextCandidates } from "./orchestrator/context-working-adapter.ts";
import { listMemoryBlocksForAssembly } from "../db/memory-block-store.ts";
import {
  publicMedia,
  sanitizeResultForLLM,
  sanitizeResultForTrajectory,
  summarizeToolResult,
  toolResultContentForLLM,
} from "./orchestrator/tool-result.ts";
import type { ActorType } from "@chvor/shared";
import {
  resolveSkillBag,
  summarizeScope,
  filterTools as filterToolsByScope,
} from "./tool-groups.ts";
import { snapshotRound } from "./checkpoint-manager.ts";
import { applyEmotionGate, getSessionVAD, isEmotionGateEnabled } from "./emotion-gate.ts";
import {
  resolveBagOrdering,
  reorderDefsByRanking,
  reorderToolsByRanking,
} from "./tool-bag-resolver.ts";
import { runParallelMultiMind } from "./multi-mind.ts";
import { sessionToMessages } from "./orchestrator/messages.ts";
import { runToolCalls } from "./orchestrator/tool-call-runner.ts";
import { isWorkflowRelevant } from "./orchestrator/skill-relevance.ts";
import { readTrackedModelMetadata, runTrackedModelSetup } from "./orchestrator/model-trajectory.ts";
import { ignoreAfterAbort } from "./orchestrator/abort.ts";
import {
  recordTrajectoryContextAssembled,
  recordTrajectoryModelFailed,
  recordTrajectoryModelFinished,
  recordTrajectoryModelStarted,
  recordTrajectoryToolRound,
  runWithTrajectoryCapture,
  type TrajectoryRunContext,
} from "./orchestrator/trajectory-adapter.ts";
export type EventEmitter = (event: ExecutionEvent) => void;
export function resolveConfig(): ResolvedConfig {
  return resolveRoleConfig("primary");
}
export { sessionToMessages } from "./orchestrator/messages.ts";
export type ChunkCallback = (text: string) => void;
export interface ExecuteOptions {
  excludeTools?: string[];
  sessionSummary?: string | null;
  sessionId?: string;
  voiceContext?: { ttsActive: boolean };
  originClientId?: string;
  channelType?: string;
  channelId?: string;
  /** Extra rounds granted when user continues after hitting the round limit. */
  extraRounds?: number;
  /** Signal to abort the current generation mid-stream. */
  abortSignal?: AbortSignal;
  /** Attribution for typed audit events. Defaults to actor_type=session, actor_id=sessionId. */
  actor?: { type: ActorType; id: string | null };
  /** Cognitive loop lineage for autonomous runs spawned by pulse/daemon/A2UI. */
  loopId?: string;
  trajectory?: TrajectoryRunContext;
}
/** @deprecated Use ModelUsedInfo from @chvor/shared */
export type ModelUsedResult = ModelUsedInfo;

export interface ConversationResult {
  text: string;
  actions: ToolActionSummary[];
  totalMessages: number;
  fittedMessages: number;
  /** True when the orchestrator exhausted all tool rounds (user can continue). */
  hitRoundLimit?: boolean;
  emotion?: EmotionState;
  emotionSnapshot?: EmotionSnapshot;
  media?: MediaArtifact[];
  /** Which model actually generated the response */
  modelUsed?: ModelUsedResult;
}
/**
 * Execute a conversation turn with streaming: send to LLM, handle tool calls, stream text chunks.
 */
export async function executeConversation(
  messages: ChatMessage[],
  emit: EventEmitter,
  onChunk?: ChunkCallback,
  onStreamReset?: () => void,
  options?: ExecuteOptions
): Promise<ConversationResult> {
  const guardedChunk = ignoreAfterAbort(onChunk, options?.abortSignal);
  const guardedStreamReset = ignoreAfterAbort(onStreamReset, options?.abortSignal);
  return runWithTrajectoryCapture({
    messages,
    emit,
    execute: (trackedEmit) =>
      executeConversationCore(messages, trackedEmit, guardedChunk, guardedStreamReset, options),
    context: options?.trajectory,
    sessionId: options?.sessionId,
    channelType: options?.channelType,
    channelId: options?.channelId,
    loopId: options?.loopId,
    auditActor: options?.actor,
    abortSignal: options?.abortSignal,
    initialSecrets: snapshotActiveMcpSecrets(),
  });
}

async function executeConversationCore(
  messages: ChatMessage[],
  emit: EventEmitter,
  onChunk?: ChunkCallback,
  onStreamReset?: () => void,
  options?: ExecuteOptions
): Promise<ConversationResult> {
  const configChain = resolveRoleChain("primary");
  let activeConfigIndex = 0;

  // Media-based model override: route to a specialized model when the user sends media
  const lastUserMsg = messages.findLast((m) => m.role === "user");
  const userMedia = lastUserMsg?.media;
  const hasVideo = userMedia?.some((m) => m.mediaType === "video");
  const hasImage = userMedia?.some((m) => m.mediaType === "image");

  if (hasVideo) {
    try {
      const mediaConfig = resolveMediaConfig("video-understanding");
      // Prepend to chain so it's tried first
      configChain.unshift(mediaConfig);
      console.log(
        `[orchestrator] video detected → routing to ${mediaConfig.providerId}/${mediaConfig.model}`
      );
    } catch {
      /* fall through to primary */
    }
  } else if (hasImage) {
    try {
      const mediaConfig = resolveMediaConfig("image-understanding");
      configChain.unshift(mediaConfig);
      console.log(
        `[orchestrator] image detected → routing to ${mediaConfig.providerId}/${mediaConfig.model}`
      );
    } catch {
      /* fall through to primary */
    }
  }

  const config = configChain[0];
  console.log(
    `[orchestrator] using ${config.providerId}/${config.model}${configChain.length > 1 ? ` (+${configChain.length - 1} fallback${configChain.length > 2 ? "s" : ""})` : ""}`
  );

  const allSkills = loadSkills();
  const enabledSkills = allSkills.filter((s) =>
    isCapabilityEnabled("skill", s.id, s.metadata.defaultEnabled)
  );

  // Prompt-type skills are always included (lightweight behavioral presets).
  // Workflow skills are only included when the user's message is relevant.
  const userQuery = (lastUserMsg?.content ?? "").toLowerCase();
  const skills = enabledSkills.filter((s) => {
    if (s.skillType === "prompt") return true;
    return isWorkflowRelevant(s, userQuery);
  });

  const allTools = loadTools();
  const enabledTools = allTools.filter((t) =>
    isCapabilityEnabled("tool", t.id, t.metadata.defaultEnabled)
  );

  // Skill-scoped tool-bag floor (Phase C): only tools the active skills' groups
  // include make it into the bag. Skills with no declarations trigger a
  // permissive scope so legacy installs keep working.
  //
  // Scope is computed ONCE per turn and reused on the credential-change rebuild
  // below. Mid-turn skill toggles take effect on the *next* turn, not this one.
  const bagScope = resolveSkillBag(skills);
  // Aggregate `preferredUsageContext` across active skills — fed to the
  // multi-credential picker so it can tie-break between same-type credentials
  // (e.g. two GitHub accounts) without bothering the LLM.
  const preferredUsageContext = Array.from(
    new Set(skills.flatMap((s) => s.metadata.preferredUsageContext ?? []))
  );
  const builtToolDefs = await buildToolDefinitions(enabledTools, bagScope);
  if (options?.excludeTools) {
    for (const name of options.excludeTools) delete builtToolDefs[name];
  }

  // Phase H — emotion-modulated risk gate. When the user's VAD lands in the
  // frustrated/hostile bucket, mask destructive (and on hostile, also moderate)
  // tools from the bag. `criticality: always-available` tools bypass.
  let toolDefs: typeof builtToolDefs = builtToolDefs;
  // Hoisted for the Phase D3 checkpointer — captures the per-turn emotion
  // bucket so each round snapshot includes the gate's view of the world.
  let snapshotEmotion: import("@chvor/shared").OrchestratorCheckpointSnapshot["emotion"] = null;
  if (isEmotionGateEnabled()) {
    const sessionVad = getSessionVAD(options?.sessionId);
    const gateResult = applyEmotionGate({ defs: builtToolDefs, vad: sessionVad });
    toolDefs = gateResult.defs;
    snapshotEmotion = {
      bucket: gateResult.bucket,
      vad: sessionVad,
      maskedToolCount: gateResult.masked.length,
    };
    if (gateResult.event) {
      emit({ type: "tool.bag.emotion-gated", data: gateResult.event });
      console.log(
        `[emotion-gate] ${gateResult.bucket} → masked ${gateResult.masked.length} tool(s); ${gateResult.bypassed.length} bypassed via always-available`
      );
    }
  }

  const toolCount = Object.keys(toolDefs).length;
  console.log(
    `[orchestrator] ${toolCount} tools available — bag: ${
      bagScope.isPermissive
        ? `permissive (${bagScope.permissiveReason ?? "no scope"})`
        : `scoped via skills [${bagScope.contributingSkills.join(",")}]`
    }`
  );

  const bagSummary = summarizeScope(bagScope);
  emit({
    type: "tool.bag.resolved",
    data: {
      groups: bagSummary.groups,
      requiredTools: bagSummary.requiredTools,
      deniedTools: bagSummary.deniedTools,
      isPermissive: bagSummary.isPermissive,
      permissiveReason: bagSummary.permissiveReason,
      contributingSkills: bagSummary.contributingSkills,
      allowedCredentialTypes: bagSummary.allowedCredentialTypes,
      toolCount,
    },
  });
  // ── Cognitive memory retrieval (DRR + composite scoring + graph activation) ──
  const memConfig = getCognitiveMemoryConfig();
  let memoryFacts: string[] = [];
  let retrievedMemoryIds: string[] = [];
  let retrievedMemorySources: Array<"direct" | "associated" | "predicted"> = [];
  let retrievedContextCandidates: ContextAssemblyCandidate[] = [];
  const retrievalScores: Map<string, ScoreBreakdown> = new Map();
  let detectedCategories: string[] = [];
  const retrievalStartMs = Date.now();
  try {
    const query = lastUserMsg?.content ?? "";

    // DRR-style category classification (keyword heuristic, no LLM)
    const categoryClass = classifyQueryCategories(query);
    detectedCategories = categoryClass.primary;

    // Category-tiered retrieval: search primary categories first, then fallback
    let scoredMemories: Array<{ memory: Memory; vectorSimilarity: number }>;
    if (categoryClass.primary.length > 0) {
      const tiered = await getRelevantMemoriesByCategoryTiers(
        query,
        categoryClass.primary,
        memConfig.maxRetrievalCount,
        memConfig.strengthThreshold
      );
      scoredMemories = tiered.map((r) => ({
        memory: r.memory,
        vectorSimilarity: r.vectorSimilarity,
      }));
    } else {
      scoredMemories = await getRelevantMemoriesWithScores(
        query,
        memConfig.maxRetrievalCount,
        memConfig.strengthThreshold
      );
    }

    // Get current emotional valence for 5-signal scoring (when emotions enabled)
    let currentEmotionalValence: number | null = null;
    const personaForMemory = getPersona();
    if (personaForMemory.emotionsEnabled && options?.sessionId) {
      const latestEmotion = getLatestEmotion(options.sessionId);
      currentEmotionalValence = latestEmotion?.vad?.valence ?? null;
    }

    const scoringCtx = {
      channelType: options?.channelType,
      currentEmotionalValence: currentEmotionalValence ?? undefined,
    };

    // Re-rank with composite scoring (channel-aware, emotion-aware)
    const reranked = rerankMemories(scoredMemories, scoringCtx);

    // Compute detailed scores for observability
    for (const { memory, vectorSimilarity } of scoredMemories) {
      retrievalScores.set(
        memory.id,
        computeCompositeScoreDetailed(memory, vectorSimilarity, scoringCtx)
      );
    }

    // Spread activation through the memory graph
    const activated = spreadActivation(
      reranked.map((r) => r.memory),
      10,
      options?.sessionId,
      query
    );

    retrievedContextCandidates = activated.map((activatedMemory, index) => {
      const score = retrievalScores.get(activatedMemory.memory.id)?.composite;
      return mapGraphMemoryToContextCandidate(activatedMemory.memory, {
        source: activatedMemory.source,
        ...(activatedMemory.relation === undefined ? {} : { relation: activatedMemory.relation }),
        rank: index,
        normalizedScore: score ?? activatedMemory.activationScore,
        categoryMatched: detectedCategories.includes(activatedMemory.memory.category),
      });
    });

    // Inject L0 abstracts with memory ID prefix (for recall_detail tool)
    memoryFacts = activated.map((a) => {
      const prefix = a.source === "associated" ? `[via ${a.relation}] ` : "";
      return `[mid:${a.memory.id.slice(0, 8)}] ${prefix}${a.memory.abstract}`;
    });
    retrievedMemoryIds = activated.map((a) => a.memory.id);
    retrievedMemorySources = activated.map((a) => a.source);
  } catch (err) {
    console.warn(
      "[orchestrator] memory retrieval failed, falling back to basic:",
      (err as Error).message
    );
    try {
      const fallback = await getRelevantMemoriesWithScores(
        lastUserMsg?.content ?? "",
        Math.min(15, memConfig.maxRetrievalCount),
        memConfig.strengthThreshold
      );
      retrievedContextCandidates = fallback.map(({ memory, vectorSimilarity }, index) =>
        mapGraphMemoryToContextCandidate(memory, {
          source: "fallback",
          rank: index,
          normalizedScore: vectorSimilarity,
          categoryMatched: detectedCategories.includes(memory.category),
        })
      );
      memoryFacts = fallback.map(
        ({ memory }) => `[mid:${memory.id.slice(0, 8)}] [fallback] ${memory.abstract}`
      );
      retrievedMemoryIds = fallback.map(({ memory }) => memory.id);
      retrievedMemorySources = fallback.map(() => "direct");
    } catch (fallbackError) {
      console.warn(
        "[orchestrator] basic memory fallback failed:",
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      );
    }
  }
  if (memoryFacts.length > 0) {
    console.log(
      `[orchestrator] injecting ${memoryFacts.length} memory fact(s) (${retrievedMemoryIds.length} with graph activation)`
    );

    // Update topic hashes for predictive preloading
    try {
      const activatedMems = retrievedMemoryIds.map((id) => getMemory(id)).filter(Boolean);
      const topicPairs = activatedMems.map((m) => ({
        memoryId: m!.id,
        topicHash: computeTopicHash(m!),
      }));
      if (topicPairs.length > 0) {
        updateAccessLogTopics(topicPairs);

        // Predictive preloading: inject predicted next-topic memories
        try {
          const currentTopics = topicPairs.map((p) => p.topicHash);
          const predictedIds = predictNextMemories(currentTopics, 3);
          const seenIds = new Set(retrievedMemoryIds);
          for (const pid of predictedIds) {
            if (seenIds.has(pid)) continue;
            const predicted = getMemory(pid);
            if (predicted && predicted.strength >= memConfig.strengthThreshold) {
              memoryFacts.push(`[mid:${pid.slice(0, 8)}] [predicted] ${predicted.abstract}`);
              retrievedMemoryIds.push(pid);
              retrievedMemorySources.push("predicted");
              retrievedContextCandidates.push(
                mapGraphMemoryToContextCandidate(predicted, {
                  source: "predicted",
                  rank: retrievedContextCandidates.length,
                  normalizedScore: predicted.strength,
                  categoryMatched: detectedCategories.includes(predicted.category),
                })
              );
              seenIds.add(pid);
            }
          }
        } catch {
          /* predictive preloading is non-critical */
        }
      }
    } catch {
      /* non-critical */
    }

    // Hard cap on injected memory facts to prevent token budget explosion
    const MAX_INJECTED_MEMORIES = 30;
    if (memoryFacts.length > MAX_INJECTED_MEMORIES) {
      memoryFacts = memoryFacts.slice(0, MAX_INJECTED_MEMORIES);
      retrievedMemoryIds = retrievedMemoryIds.slice(0, MAX_INJECTED_MEMORIES);
      retrievedMemorySources = retrievedMemorySources.slice(0, MAX_INJECTED_MEMORIES);
      retrievedContextCandidates = retrievedContextCandidates.slice(0, MAX_INJECTED_MEMORIES);
    }

    // Emit retrieval trace for observability (replaces per-memory events)
    try {
      const traceEntries = retrievedMemoryIds
        .map((id, i) => {
          const mem = getMemory(id);
          const scores = retrievalScores.get(id);
          return mem
            ? {
                memoryId: id,
                abstract: mem.abstract,
                category: mem.category,
                scores: scores ?? {
                  vector: 0,
                  strength: mem.strength,
                  recency: 0,
                  categoryRelevance: 1,
                  emotionalResonance: null,
                  composite: 0,
                },
                source: retrievedMemorySources[i] ?? "direct",
                rank: i + 1,
              }
            : null;
        })
        .filter(Boolean);
      // Note: queryText is omitted from broadcast to prevent leaking user messages
      // to all connected WebSocket clients. Abstracts are less sensitive (already stored).
      emit({
        type: "memory.retrieval_trace",
        data: {
          categoriesDetected: detectedCategories as import("@chvor/shared").MemoryCategory[],
          totalCandidates: retrievalScores.size,
          entries: traceEntries as import("@chvor/shared").MemoryRetrievalTraceEntry[],
          durationMs: Date.now() - retrievalStartMs,
        },
      });
    } catch {
      /* observability is non-critical */
    }
  }
  const personaCfg = getPersona();
  const sessionSummary = options?.sessionSummary ?? null;

  // Load emotion history for context injection
  let emotionHistory: EmotionSnapshot[] = [];
  if (personaCfg.emotionsEnabled && options?.sessionId) {
    emotionHistory = getSessionEmotionArc(options.sessionId, 50);
  }

  // Create emotion engine for this session
  const presetId = personaCfg.personalityPresetId;
  let emotionEngine: EmotionEngine | null = null;
  if (personaCfg.emotionsEnabled) {
    emotionEngine = createEmotionEngine(presetId);
    // Restore from last snapshot if exists
    const lastSnapshot =
      emotionHistory.length > 0 ? emotionHistory[emotionHistory.length - 1] : null;
    if (lastSnapshot) emotionEngine.restoreFromSnapshot(lastSnapshot);
    emotionEngine.recordMessageTimestamp();
  }

  // Create advanced emotion engine if enabled (wraps base engine)
  let advancedEngine: AdvancedEmotionEngine | null = null;
  if (personaCfg.advancedEmotionsEnabled && emotionEngine && options?.sessionId) {
    advancedEngine = new AdvancedEmotionEngine(emotionEngine, presetId ?? "companion");
    advancedEngine.setSessionId(options.sessionId);
    // Restore mood from last snapshot's advanced state
    const lastSnapshot =
      emotionHistory.length > 0 ? emotionHistory[emotionHistory.length - 1] : null;
    if (lastSnapshot) advancedEngine.restoreState(lastSnapshot);
    // Load unresolved residues + relationship state from DB
    advancedEngine.loadResidues(getUnresolvedResidues(5));
    advancedEngine.loadRelationship(getRelationshipState());
    // Increment session count once per conversation (only on first message — no prior emotion history)
    if (emotionHistory.length === 0) {
      try {
        incrementRelationshipSession();
      } catch (err) {
        console.warn("[orchestrator] failed to increment session:", (err as Error).message);
      }
    }
  }

  // Only show the LLM tool descriptions for tools it can actually call this
  // turn — keeps the prompt honest with the bag and saves tokens.
  const visibleTools = filterToolsByScope(enabledTools, bagScope);

  // Phase G+ — graph-driven bag ordering. Pure ordering: no tools added or
  // removed. Puts the highest-composite-score tools first in the system
  // prompt so small models pick the right one without scanning the bag.
  let promptVisibleTools = visibleTools;
  // Hoisted for Phase D3 checkpoints — captures the per-turn ranking +
  // recent-tools window so round snapshots include the bag's rationale.
  let snapshotRanking: import("@chvor/shared").OrchestratorCheckpointSnapshot["ranking"] = [];
  let snapshotRecentTools: string[] = [];
  try {
    const queryText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
    const nativeNamesInBag = Object.keys(toolDefs).filter((n) => n.startsWith("native__"));
    const ordering = await resolveBagOrdering({
      candidates: visibleTools,
      nativeNames: nativeNamesInBag,
      query: queryText,
      scope: bagScope,
      sessionId: options?.sessionId,
    });
    promptVisibleTools = reorderToolsByRanking(visibleTools, ordering.ranking);
    const reordered = reorderDefsByRanking(toolDefs, ordering.ranking);
    for (const k of Object.keys(toolDefs)) delete toolDefs[k];
    Object.assign(toolDefs, reordered);
    snapshotRanking = ordering.ranking.slice(0, 12).map((r) => ({
      toolName: r.toolName,
      composite: Number(r.composite.toFixed(4)),
    }));
    snapshotRecentTools = ordering.recentTools;

    emit({
      type: "tool.bag.ranked",
      data: {
        top: ordering.ranking.slice(0, 12).map((r) => ({
          toolName: r.toolName,
          composite: Number(r.composite.toFixed(4)),
          strength: Number(r.strength.toFixed(4)),
          coActivation: Number(r.coActivation.toFixed(4)),
          semantic: Number(r.semantic.toFixed(4)),
          category: Number(r.category.toFixed(4)),
        })),
        totalRanked: ordering.ranking.length,
        recentTools: ordering.recentTools,
        semanticActive: ordering.semanticActive,
      },
    });
  } catch (err) {
    // Graph-driven ordering is a soft enhancement — never block the turn.
    console.warn(
      "[orchestrator] tool-bag ordering failed; falling back to scope-default order:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // B12 owns memory and rolling-history injection. Keep those bodies out of the
  // legacy prompt builder so every persistent item passes through one budget.
  const { stable: stablePrompt, volatile: volatilePrompt } = buildSystemPrompt(
    skills,
    promptVisibleTools,
    [],
    personaCfg,
    null,
    options?.voiceContext,
    emotionHistory,
    options?.channelType
  );

  // Append advanced emotion context to volatile prompt if enabled
  let fullVolatilePrompt = volatilePrompt;
  if (advancedEngine) {
    const advCtx = buildAdvancedEmotionContext(
      advancedEngine.getMood(),
      advancedEngine.getEmbodiment(),
      advancedEngine.getUnresolvedResidues(),
      advancedEngine.getRelationship(),
      false // no regulation on first turn
    );
    fullVolatilePrompt += "\n\n" + advCtx;
  }

  try {
    const multiMind = await runParallelMultiMind({
      userText: lastUserMsg?.content ?? "",
      // Retrieved bodies are already represented in the typed B12 candidate
      // pool; do not create an unbudgeted model-generated memory digest.
      memoryFacts: [],
      channelType: options?.channelType,
      loopId: options?.loopId,
      abortSignal: options?.abortSignal,
      emit,
    });
    if (multiMind.digest) {
      fullVolatilePrompt += `\n\n${multiMind.digest}`;
    }
  } catch (err) {
    console.warn(
      "[orchestrator] multi-mind deliberation skipped:",
      err instanceof Error ? err.message : String(err)
    );
  }

  const persistentContextAllowed = !new Set(["scheduler", "pulse", "webhook", "daemon"]).has(
    options?.channelType ?? "web"
  );
  let blockCandidates: ContextAssemblyCandidate[] = [];
  if (persistentContextAllowed) {
    try {
      blockCandidates = mapMemoryBlocksToContextCandidates(listMemoryBlocksForAssembly());
    } catch {
      throw new ContextStableSourceError(
        "stable context could not be read and validated; refusing an ungrounded turn"
      );
    }
  }
  const workingCandidates = lastUserMsg
    ? mapWorkingContextCandidates({
        messages,
        currentRequestId: lastUserMsg.id,
        ...(sessionSummary && options?.sessionId
          ? {
              rollingSummary: {
                sessionId: options.sessionId,
                revision: `messages-${messages.length}`,
                content: sessionSummary,
                eventTime: null,
              },
            }
          : {}),
      })
    : [];
  const contextCandidates = [
    ...blockCandidates,
    ...workingCandidates,
    ...(persistentContextAllowed ? retrievedContextCandidates : []),
  ];

  // Assemble against the smallest configured fallback window. A later fallback
  // can therefore reuse this selection without receiving an oversized prompt.
  const budgetConfig = selectConservativeContextProfile(
    configChain.map((candidate) => {
      const contextWindowTokens = getContextWindow(candidate.model);
      return {
        ...candidate,
        contextWindowTokens,
        responseReserveTokens: Math.min(
          getMaxTokens(candidate.model),
          Math.floor(contextWindowTokens * 0.5)
        ),
      };
    })
  );
  const contextWindow = budgetConfig.contextWindowTokens;
  const reservedForResponse = budgetConfig.responseReserveTokens;
  const outsideSystemPrompt = stablePrompt + "\n\n" + fullVolatilePrompt;
  const projectedToolDefinitions = projectToolDefinitionsForContext(
    toolDefs as Record<string, ContextToolDefinition>
  );
  const contextResult = assembleTurnContext({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    providerId: budgetConfig.providerId,
    modelId: budgetConfig.model,
    contextWindowTokens: contextWindow,
    responseReserveTokens: reservedForResponse,
    systemInstructions: outsideSystemPrompt,
    currentRequest: lastUserMsg?.content ?? "",
    currentRequestMediaTokens: estimateMediaTokens(lastUserMsg?.media),
    toolDefinitions: projectedToolDefinitions,
    candidates: contextCandidates,
  });
  recordTrajectoryContextAssembled(contextResult.assembly);

  const selectedMemoryIds = contextResult.assembly.layers
    .slice(4)
    .flatMap((layer) => layer.items)
    .filter(({ source }) => source.kind === "memory")
    .map(({ source }) => source.id);
  if (selectedMemoryIds.length > 1) strengthenCoAccessedEdges(selectedMemoryIds);

  // Historical messages are rendered as typed working-layer data. The current
  // request stays in its native user role outside the hierarchy.
  const budgetedMessages = lastUserMsg ? [lastUserMsg] : messages.slice(-1);
  const selectedWorkingMessageIds = new Set(
    contextResult.assembly.layers[2].items
      .filter(({ source }) => source.kind === "message")
      .map(({ source }) => source.id)
  );
  const firstSelectedWorkingIndex = messages.findIndex(({ id }) =>
    selectedWorkingMessageIds.has(id)
  );
  // Gateway summarization expects a contiguous fitted tail. If assembly skipped
  // a large recent item but retained an older one, keep the entire intervening
  // tail out of the summarization input rather than summarizing included content.
  const fittedMessageCountForSummary =
    firstSelectedWorkingIndex === -1
      ? budgetedMessages.length
      : messages.length - firstSelectedWorkingIndex;
  const systemTokens =
    contextResult.assembly.configuration.systemInstructionTokens +
    contextResult.assembly.configuration.otherPromptTokens +
    contextResult.assembly.accounting.includedTokens;
  const toolTokens = contextResult.assembly.configuration.toolDefinitionTokens;
  const messageBudget = contextResult.assembly.layers[2].tokenBudget;

  const messagesTruncated = messages.length - fittedMessageCountForSummary;
  if (messagesTruncated > 0) {
    console.log(
      `[orchestrator] context assembly ${contextResult.assembly.id}: moved ${messagesTruncated} historical messages into bounded working context (budget: ${messageBudget}, context: ${contextWindow}, system+context: ${systemTokens}, tools: ${toolTokens})`
    );
  } else {
    console.log(
      `[orchestrator] context assembly ${contextResult.assembly.id}: current request only (working budget: ${messageBudget})`
    );
  }

  emit({
    type: "execution.tokenBudget",
    data: {
      contextWindow,
      systemTokens,
      toolTokens,
      messageBudget,
      messagesTotal: messages.length,
      messagesTruncated,
      contextAssemblyId: contextResult.assembly.id,
      hierarchyBudget: contextResult.assembly.configuration.hierarchyBudgetTokens,
      hierarchyIncluded: contextResult.assembly.accounting.includedTokens,
      contextItemsExcluded: contextResult.exclusions.length,
    },
  });

  let currentMessages: CoreMessage[] = sessionToMessages(budgetedMessages as ChatMessage[]);
  const contextDataMessage = {
    role: "user" as const,
    content: contextResult.prompt,
  } as CoreMessage;

  emit({ type: "brain.thinking", data: { thought: "Processing..." } });

  // Tool severity mapping for emotion signals
  const HIGH_SEVERITY_TOOLS = new Set([
    "native__sandbox_execute",
    "native__shell_execute",
    "native__web_search",
  ]);
  const LOW_SEVERITY_TOOLS = new Set([
    "native__read_file",
    "native__memory_query",
    "native__memory_store",
  ]);
  function toolSeverity(toolName: string): "low" | "medium" | "high" {
    if (HIGH_SEVERITY_TOOLS.has(toolName)) return "high";
    if (LOW_SEVERITY_TOOLS.has(toolName)) return "low";
    return "medium";
  }

  const emotionsEnabled = personaCfg.emotionsEnabled === true;
  let detectedEmotion: EmotionState | null = null;
  let detectedSnapshot: EmotionSnapshot | null = null;
  // Track tool outcomes for emotion signals
  const toolOutcomeResults: { success: boolean; severity: "low" | "medium" | "high" }[] = [];

  const MAX_TOOL_ROUNDS = getBrainConfig().maxToolRounds + (options?.extraRounds ?? 0);
  const allActions: ToolActionSummary[] = [];
  let lastFullText = "";
  let noProgressRounds = 0;
  const NO_PROGRESS_THRESHOLD = 3;

  // Phase D4 — per-turn HITL cache. Tools the user approved with
  // `allow-session` skip the prompt for the rest of this turn (this Set
  // is local to one `executeConversation` invocation — the next user
  // message starts a fresh turn and re-prompts). The naming follows the
  // user-facing button label ("allow for this session"); the lifetime is
  // intentionally narrower so a long-lived turn doesn't accumulate
  // implicit approvals across unrelated tool calls.
  const hitlAllowTurn = new Set<string>();
  // Extended Thinking config (re-evaluated per active model in fallback loop)
  const thinkingConfig = getExtendedThinking();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Check abort signal before starting a new round
    if (options?.abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");

    console.log(`[orchestrator] round ${round + 1}/${MAX_TOOL_ROUNDS} — streaming...`);
    // Use array-form system messages: stable part gets Anthropic cache control
    const systemMessages: CoreMessage[] = [
      {
        role: "system" as const,
        content: stablePrompt,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      } as CoreMessage,
      { role: "system" as const, content: fullVolatilePrompt } as CoreMessage,
    ];
    const attemptMessages: CoreMessage[] = [
      ...systemMessages,
      contextDataMessage,
      ...currentMessages,
    ];

    // Consume the stream: collect text + tool calls
    let fullText = "";
    const toolCalls: Array<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }> = [];
    const emotionParser = emotionsEnabled ? createEmotionParser() : null;

    // ── Fallback loop: try each config in the chain ──
    let streamSucceeded = false;
    for (let cfgIdx = activeConfigIndex; cfgIdx < configChain.length; cfgIdx++) {
      const currentConfig = configChain[cfgIdx];
      const currentContextWindow = getContextWindow(currentConfig.model);
      assertContextAttemptFits({
        providerId: currentConfig.providerId,
        modelId: currentConfig.model,
        contextWindowTokens: currentContextWindow,
        responseReserveTokens: Math.min(
          getMaxTokens(currentConfig.model),
          Math.floor(currentContextWindow * 0.5)
        ),
        messages: attemptMessages,
        toolDefinitions: toolDefs as Record<string, ContextToolDefinition>,
      });
      const modelRequestStepId = recordTrajectoryModelStarted({
        providerId: currentConfig.providerId,
        modelId: currentConfig.model,
        role: "primary",
        wasFallback: cfgIdx > 0,
        round: round + 1,
      });
      const currentModel = runTrackedModelSetup({
        requestStepId: modelRequestStepId,
        config: currentConfig,
        wasFallback: cfgIdx > 0,
        operation: () => createModel(currentConfig),
      });

      // Extended thinking only applies to Anthropic models
      const providerOptions =
        thinkingConfig.enabled && currentConfig.providerId === "anthropic"
          ? {
              "@ai-sdk/anthropic": {
                thinking: { type: "enabled" as const, budgetTokens: thinkingConfig.budgetTokens },
              },
            }
          : undefined;

      if (providerOptions && cfgIdx === activeConfigIndex) {
        console.log(
          `[orchestrator] extended thinking enabled (budget: ${thinkingConfig.budgetTokens})`
        );
      }

      const result = runTrackedModelSetup({
        requestStepId: modelRequestStepId,
        config: currentConfig,
        wasFallback: cfgIdx > 0,
        operation: () =>
          streamText({
            model: currentModel,
            messages: attemptMessages,
            tools: toolDefs,
            maxSteps: 1,
            abortSignal: options?.abortSignal,
            ...(providerOptions ? { providerOptions } : {}),
          }),
      });

      try {
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            fullText += part.textDelta;
            if (onChunk) {
              if (emotionParser) {
                const passThrough = emotionParser.feed(part.textDelta);
                if (passThrough) onChunk(passThrough);
              } else {
                onChunk(part.textDelta);
              }
            } else {
              emotionParser?.feed(part.textDelta);
            }
          } else if (part.type === "tool-call") {
            toolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.args as Record<string, unknown>,
            });
          } else if (part.type === "error") {
            console.error(
              `[orchestrator] stream error:`,
              (part as unknown as { error: unknown }).error
            );
          }
        }
        let usage:
          | { promptTokens: number; completionTokens: number; totalTokens: number }
          | undefined;
        let finishReason: string | undefined;
        const metadata = await readTrackedModelMetadata(result.usage, result.finishReason);
        if (metadata) [usage, finishReason] = metadata;
        else console.warn("[orchestrator] model metadata unavailable");
        recordTrajectoryModelFinished({
          requestStepId: modelRequestStepId,
          providerId: currentConfig.providerId,
          modelId: currentConfig.model,
          role: "primary",
          wasFallback: cfgIdx > 0,
          output: { text: fullText, toolCallCount: toolCalls.length },
          finishReason,
          inputTokens: usage?.promptTokens,
          outputTokens: usage?.completionTokens,
          totalTokens: usage?.totalTokens,
        });
        // Stream succeeded — stick with this config for future rounds
        activeConfigIndex = cfgIdx;
        streamSucceeded = true;
        break;
      } catch (streamErr) {
        // Check if a fallback is available and the error is transient
        const willFallback = cfgIdx < configChain.length - 1 && isFallbackEligible(streamErr);
        recordTrajectoryModelFailed({
          requestStepId: modelRequestStepId,
          providerId: currentConfig.providerId,
          modelId: currentConfig.model,
          role: "primary",
          wasFallback: cfgIdx > 0,
          error: streamErr,
          retryable: willFallback,
        });
        if (willFallback) {
          console.warn(
            `[orchestrator] ${currentConfig.providerId}/${currentConfig.model} failed (${(streamErr as Error).message}), trying fallback ${cfgIdx + 1}...`
          );
          logError("llm_fallback", streamErr, {
            round: round + 1,
            configIndex: cfgIdx,
            failedModel: `${currentConfig.providerId}/${currentConfig.model}`,
            nextModel: `${configChain[cfgIdx + 1].providerId}/${configChain[cfgIdx + 1].model}`,
            sessionId: options?.sessionId,
          });
          // Reset partial state for next attempt
          fullText = "";
          toolCalls.length = 0;
          onStreamReset?.();
          emit({
            type: "brain.thinking",
            data: {
              thought: `Switching to fallback model (${configChain[cfgIdx + 1].providerId}/${configChain[cfgIdx + 1].model})...`,
            },
          });
          continue;
        }
        // No more fallbacks or non-transient error
        console.error(`[orchestrator] stream failed:`, streamErr);
        logError("llm_error", streamErr, { round: round + 1, sessionId: options?.sessionId });
        throw streamErr;
      }
    }

    if (!streamSucceeded) {
      const tried = configChain.map((c) => `${c.providerId}/${c.model}`).join(", ");
      throw new LLMError(`All models in fallback chain failed (tried: ${tried})`, {
        code: "llm.fallback_exhausted",
        context: { tried, chainLength: configChain.length, sessionId: options?.sessionId },
        userFacing: true,
      });
    }

    // Finalize emotion parser — flush remainder and strip marker from fullText
    if (emotionParser) {
      const {
        emotion: roundEmotion,
        snapshot: roundSnapshot,
        remainder,
      } = emotionParser.finalize();
      if (remainder && onChunk) onChunk(remainder);
      const { strippedText } = stripEmotionMarker(fullText);
      fullText = strippedText;
      detectedEmotion = roundEmotion;
      detectedSnapshot = roundSnapshot;
    }
    lastFullText = fullText;

    console.log(
      `[orchestrator] round ${round + 1} done — text: ${fullText.length} chars, tool calls: ${toolCalls.length}`
    );
    if (toolCalls.length > 0) {
      console.log(`[orchestrator] tools: ${toolCalls.map((tc) => tc.toolName).join(", ")}`);
    }

    // Phase D3 — persist a snapshot for this round. Defined here so every
    // exit path (final-answer, auth-bail, no-progress-bail, end-of-loop)
    // gets a row, not just rounds that completed tool processing.
    const persistRoundSnapshot = (
      outcomes: Array<{ toolName: string; success: boolean }>
    ): void => {
      try {
        const activeConfig = configChain[activeConfigIndex];
        snapshotRound({
          sessionId: options?.sessionId,
          round,
          bagScope,
          bagToolCount: Object.keys(toolDefs).length,
          emotion: snapshotEmotion,
          model: {
            providerId: activeConfig.providerId,
            model: activeConfig.model,
            wasFallback: activeConfigIndex > 0,
          },
          ranking: snapshotRanking,
          toolOutcomes: outcomes,
          recentTools: snapshotRecentTools,
          messages: { total: messages.length, fitted: fittedMessageCountForSummary },
          memoryIds: selectedMemoryIds,
        });
      } catch (err) {
        console.warn(
          "[orchestrator] checkpoint snapshot failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    };

    // No tool calls — final response
    if (toolCalls.length === 0) {
      // Process emotion through engine if available
      let finalSnapshot: EmotionSnapshot | undefined;
      if (emotionEngine && detectedSnapshot) {
        // Collect all signals
        const signals = [
          llmSelfReportSignal(detectedSnapshot.vad, emotionEngine.getCurrentVAD()),
          ...toolOutcomeResults.map((r) => toolOutcomeSignal(r.success, r.severity)),
          conversationPaceSignal(emotionEngine.getTimeSinceLast(), emotionEngine.getAverageGap()),
        ];

        // User sentiment from the last user message
        const lastUser = messages.findLast((m) => m.role === "user");
        if (lastUser) {
          const rawContent = lastUser.content;
          const text =
            typeof rawContent === "string"
              ? rawContent
              : Array.isArray(rawContent)
                ? (rawContent as Array<{ type: string; text?: string }>)
                    .filter((p) => p.type === "text" && p.text)
                    .map((p) => p.text)
                    .join(" ")
                : "";
          if (text) signals.push(userSentimentSignal(text));
        }

        // Route through advanced engine if available, otherwise basic engine
        if (advancedEngine) {
          // Extract topic hint from last user message
          const lastUserMsg = messages.findLast((m) => m.role === "user");
          const topicHint = lastUserMsg
            ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : "").slice(0, 50)
            : "";
          advancedEngine.recordToolRounds(toolOutcomeResults.length);
          finalSnapshot = advancedEngine.processTurn(signals, topicHint);
        } else {
          finalSnapshot = emotionEngine.processTurn(signals);
        }
        finalSnapshot.sessionId = options?.sessionId;

        // Persist to DB
        if (options?.sessionId) {
          try {
            finalSnapshot.id = insertEmotionSnapshot(options.sessionId, finalSnapshot);
          } catch (err) {
            console.warn("[orchestrator] failed to persist emotion:", (err as Error).message);
          }
        }

        // Emit full snapshot for enhanced canvas
        emit({ type: "brain.emotion", data: finalSnapshot });
        if (finalSnapshot.advancedState) {
          const adv = finalSnapshot.advancedState;
          console.log(
            `[orchestrator] emotion: ${finalSnapshot.displayLabel} (${finalSnapshot.blend.intensity.toFixed(2)}) VAD[${finalSnapshot.vad.valence.toFixed(2)},${finalSnapshot.vad.arousal.toFixed(2)},${finalSnapshot.vad.dominance.toFixed(2)}] mood:${adv.mood.octant} energy:${Math.round(adv.embodiment.energyLevel * 100)}%${adv.regulationActive ? ` reg:${adv.regulationStrategy}` : ""}`
          );
        } else {
          console.log(
            `[orchestrator] emotion: ${finalSnapshot.displayLabel} (${finalSnapshot.blend.intensity.toFixed(2)}) VAD[${finalSnapshot.vad.valence.toFixed(2)},${finalSnapshot.vad.arousal.toFixed(2)},${finalSnapshot.vad.dominance.toFixed(2)}]`
          );
        }

        // Update relationship metrics (per-turn: message count + emotional depth)
        if (advancedEngine && options?.sessionId) {
          try {
            updateRelationshipAfterTurn(finalSnapshot.blend.intensity);
          } catch (err) {
            console.warn("[orchestrator] failed to update relationship:", (err as Error).message);
          }
        }
      } else if (detectedEmotion) {
        // Fallback: no engine, but we have a legacy emotion
        emit({ type: "brain.emotion", data: detectedEmotion });
        console.log(
          `[orchestrator] emotion (legacy): ${detectedEmotion.emotion} (${detectedEmotion.intensity})`
        );
      }
      const allMedia = allActions.flatMap((a) => a.media ?? []);
      const activeConfig = configChain[activeConfigIndex];
      // Final-answer round had no tool calls by definition, so outcomes are [].
      persistRoundSnapshot([]);
      return {
        text: fullText,
        actions: allActions,
        totalMessages: messages.length,
        fittedMessages: fittedMessageCountForSummary,
        emotion: detectedEmotion ?? undefined,
        emotionSnapshot: finalSnapshot,
        modelUsed: {
          providerId: activeConfig.providerId,
          model: activeConfig.model,
          wasFallback: activeConfigIndex > 0,
        },
        ...(allMedia.length > 0 ? { media: allMedia } : {}),
      };
    }

    const {
      toolResults,
      roundToolOutcomes,
      toolOutcomeResults: roundToolOutcomeSignals,
    } = await runToolCalls({
      round: round + 1,
      toolCalls,
      currentMessages,
      emit,
      options,
      bagScope,
      preferredUsageContext,
      hitlAllowTurn,
      toolSeverity,
      collectEmotionOutcomes: !!emotionEngine,
    });
    recordTrajectoryToolRound({
      round: round + 1,
      calls: toolCalls.map((call) => ({
        ...call,
        toolKind: toolResults.find((result) => result.toolCallId === call.toolCallId)?.toolKind,
      })),
      results: toolResults.map((result) => ({
        ...result,
        result: sanitizeResultForTrajectory(result.result, result.media, result.toolName),
      })),
    });
    toolOutcomeResults.push(...roundToolOutcomeSignals);

    // Accumulate tool action summaries
    for (const tr of toolResults) {
      const actionResult =
        tr.toolName === "native__use_credential"
          ? { content: [{ type: "text", text: "Credential retrieved." }] }
          : sanitizeResultForLLM(tr.result, tr.media);
      const actionMedia = publicMedia(tr.media);
      allActions.push({
        tool: tr.toolName,
        summary: summarizeToolResult(actionResult, actionMedia),
        timestamp: new Date().toISOString(),
        ...(actionMedia.length ? { media: actionMedia } : {}),
      });
    }

    // Rebuild tool definitions if credentials were added/changed this round
    const CREDENTIAL_MUTATING_TOOLS = new Set([
      "native__request_credential",
      "native__request_oauth_setup",
      "native__add_credential",
      "native__synthesize_tool",
      "native__repair_synthesized_tool",
    ]);
    const credentialChanged = toolResults.some(
      (tr) =>
        CREDENTIAL_MUTATING_TOOLS.has(tr.toolName) &&
        !(
          tr.result &&
          typeof tr.result === "object" &&
          "error" in (tr.result as Record<string, unknown>)
        )
    );
    if (credentialChanged) {
      const refreshed = loadTools().filter((t) =>
        isCapabilityEnabled("tool", t.id, t.metadata.defaultEnabled)
      );
      // Reuse the same skill-scoped bag for the rebuild so newly-credentialed
      // tools land in the same scope as the original turn.
      let newDefs = await buildToolDefinitions(refreshed, bagScope);
      // Re-apply the emotion gate to the rebuild — a mid-turn credential
      // change shouldn't sneak destructive tools past a frustrated user.
      if (isEmotionGateEnabled()) {
        const vad = getSessionVAD(options?.sessionId);
        const gated = applyEmotionGate({ defs: newDefs, vad });
        newDefs = gated.defs;
      }
      for (const key of Object.keys(toolDefs)) delete toolDefs[key];
      Object.assign(toolDefs, newDefs);
      if (options?.excludeTools) {
        for (const name of options.excludeTools) delete toolDefs[name];
      }
      console.log(
        `[orchestrator] rebuilt tool defs after credential change — ${Object.keys(toolDefs).length} tools`
      );
    }

    // Auth-failure early-out: if every tool call failed with the same auth_failed cause, bail with the hint.
    const authDiagnoses = toolResults
      .map((tr) =>
        tr.result &&
        typeof tr.result === "object" &&
        "diagnosis" in (tr.result as Record<string, unknown>)
          ? (tr.result as { diagnosis?: { likelyCause?: string; userFacingHint?: string } })
              .diagnosis
          : undefined
      )
      .filter((d): d is { likelyCause?: string; userFacingHint?: string } => !!d);
    if (authDiagnoses.length > 0 && authDiagnoses.length === toolResults.length) {
      const causes = new Set(authDiagnoses.map((d) => d.likelyCause));
      if (causes.size === 1) {
        const hint = authDiagnoses[0].userFacingHint ?? "An auth error is blocking these calls.";
        if (onChunk) onChunk(hint);
        const activeConfig = configChain[activeConfigIndex];
        persistRoundSnapshot(roundToolOutcomes);
        return {
          text: lastFullText.trim() ? lastFullText + "\n\n" + hint : hint,
          actions: allActions,
          totalMessages: messages.length,
          fittedMessages: fittedMessageCountForSummary,
          emotion: detectedEmotion ?? undefined,
          modelUsed: {
            providerId: activeConfig.providerId,
            model: activeConfig.model,
            wasFallback: activeConfigIndex > 0,
          },
        };
      }
    }

    // No-progress detection: break early if LLM is spinning on failing tools
    const allToolsFailed = toolResults.every((tr) => {
      if (tr.result == null) return true;
      return typeof tr.result === "object" && "error" in (tr.result as Record<string, unknown>);
    });
    if (fullText.length === 0 && allToolsFailed) {
      noProgressRounds++;
      if (noProgressRounds >= NO_PROGRESS_THRESHOLD) {
        console.warn(
          `[orchestrator] breaking early — ${NO_PROGRESS_THRESHOLD} consecutive rounds with no progress`
        );
        const bailText =
          "I'm having trouble completing this task — my tool calls keep failing. Let me know how you'd like to proceed.";
        if (onChunk) onChunk(bailText);
        const allMedia = allActions.flatMap((a) => a.media ?? []);
        const activeConfig = configChain[activeConfigIndex];
        persistRoundSnapshot(roundToolOutcomes);
        return {
          text: lastFullText.trim() ? lastFullText + "\n\n" + bailText : bailText,
          actions: allActions,
          totalMessages: messages.length,
          fittedMessages: fittedMessageCountForSummary,
          emotion: detectedEmotion ?? undefined,
          modelUsed: {
            providerId: activeConfig.providerId,
            model: activeConfig.model,
            wasFallback: activeConfigIndex > 0,
          },
          ...(allMedia.length > 0 ? { media: allMedia } : {}),
        };
      }
    } else {
      noProgressRounds = 0;
    }

    // Append tool call + results to conversation for next round
    currentMessages = [
      ...currentMessages,
      {
        role: "assistant" as const,
        content: toolCalls.map((tc) => ({
          type: "tool-call" as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        })),
      },
      {
        role: "tool" as const,
        content: toolResults.map((tr) => {
          const experimentalContent = toolResultContentForLLM(tr.result, {
            includeImages: true,
          });
          return {
            type: "tool-result" as const,
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            result: sanitizeResultForLLM(tr.result, tr.media),
            ...(experimentalContent ? { experimental_content: experimentalContent } : {}),
          };
        }),
      },
    ];

    // Phase D3 — end-of-round snapshot for the normal continue-to-next-round path.
    persistRoundSnapshot(roundToolOutcomes);

    // Reset client streaming content before next LLM round
    onStreamReset?.();
  }

  const continuationNote = `\n\n---\n*I've used all my tool rounds but I'm making progress. Reply to continue where I left off.*`;
  if (onChunk) onChunk(continuationNote);

  const finalText = lastFullText.trim()
    ? lastFullText + continuationNote
    : "I reached the tool usage limit without producing a response. Please try again or simplify your request.";

  const allMedia = allActions.flatMap((a) => a.media ?? []);
  const activeConfig = configChain[activeConfigIndex];
  return {
    text: finalText,
    actions: allActions,
    totalMessages: messages.length,
    fittedMessages: fittedMessageCountForSummary,
    emotion: detectedEmotion ?? undefined,
    hitRoundLimit: true,
    modelUsed: {
      providerId: activeConfig.providerId,
      model: activeConfig.model,
      wasFallback: activeConfigIndex > 0,
    },
    ...(allMedia.length > 0 ? { media: allMedia } : {}),
  };
}
