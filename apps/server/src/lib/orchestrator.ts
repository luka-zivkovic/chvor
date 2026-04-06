import { streamText } from "ai";
import type { CoreMessage, TextPart, ImagePart, FilePart } from "ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMediaDir } from "./media-store.ts";
import type { ChatMessage, ExecutionEvent, Skill, Tool, PersonaConfig, ToolActionSummary, SkillType, EmotionState, EmotionSnapshot, MediaArtifact, ModelUsedInfo, Memory } from "@chvor/shared";
import { logError } from "./error-logger.ts";
import { createEmotionParser, stripEmotionMarker } from "./emotion-parser.ts";
import { buildEmotionInstructions, buildPersonalityEmotionBridge, buildEmotionContext } from "./emotion-modulation.ts";
import { createEmotionEngine, userSentimentSignal, toolOutcomeSignal, conversationPaceSignal, llmSelfReportSignal } from "./emotion-engine.ts";
import type { EmotionEngine } from "./emotion-engine.ts";
import { AdvancedEmotionEngine } from "./advanced-emotion-engine.ts";
import { buildAdvancedEmotionContext } from "./advanced-emotion-modulation.ts";
import { insertEmotionSnapshot, getSessionEmotionArc, getLatestEmotion } from "../db/emotion-store.ts";
import { getUnresolvedResidues } from "../db/emotion-residue-store.ts";
import { getRelationshipState, updateRelationshipAfterTurn, incrementRelationshipSession } from "../db/relationship-store.ts";
import { PERSONALITY_GRAVITIES } from "@chvor/shared";
import { createModel, getContextWindow, getMaxTokens, resolveRoleConfig, resolveRoleChain, resolveMediaConfig, isFallbackEligible } from "./llm-router.ts";
import type { ResolvedConfig } from "./llm-router.ts";
import { estimateTokens, fitMessagesToBudget } from "./token-counter.ts";
import { mcpManager } from "./mcp-manager.ts";
import { buildToolDefinitions } from "./tool-builder.ts";
import { isNativeTool, callNativeTool, getNativeToolTarget } from "./native-tools.ts";
import { listConnectedAgents as listPcAgents, localBackendAvailable as localPcAvailable } from "./pc-control.ts";
import { loadSkills, loadTools, reloadAll } from "./capability-loader.ts";
import { listCredentials } from "../db/credential-store.ts";
import { LLM_CRED_TYPES, CHANNEL_CRED_TYPES } from "./provider-registry.ts";
import { redactSensitiveData } from "./sensitive-filter.ts";
import { getRelevantMemories, getRelevantMemoriesWithScores, getRelevantMemoriesByCategoryTiers, getMemory } from "../db/memory-store.ts";
import { rerankMemories, classifyQueryCategories, computeCompositeScoreDetailed } from "./memory-projections.ts";
import type { ScoreBreakdown } from "./memory-projections.ts";
import { spreadActivation, strengthenCoAccessedEdges } from "./memory-graph.ts";
import { computeTopicHash, updateAccessLogTopics, predictNextMemories } from "./memory-preloader.ts";
import { getCognitiveMemoryConfig } from "../db/config-store.ts";
import { getPersona, isCapabilityEnabled, getExtendedThinking, getBrainConfig, getSelfHealingEnabled, getPcControlEnabled, getAllInstructionOverrides } from "../db/config-store.ts";
import { storeMediaFromBase64 } from "./media-store.ts";

export type EventEmitter = (event: ExecutionEvent) => void;

/** PC control tools whose media (screenshots) should not be shown in the chat UI */
const PC_INTERNAL_MEDIA_TOOLS = new Set(["native__pc_do", "native__pc_observe"]);

/** @deprecated Use resolveRoleConfig from llm-router instead */
export function resolveConfig(): ResolvedConfig {
  return resolveRoleConfig("primary");
}

function getCoreIdentity(aiName: string): string {
  return `You are ${aiName}, a personal AI assistant. Your reasoning and tool use are visible on the user's Brain Canvas.

## Behavior

- Be direct. Say "I don't know" when uncertain rather than guessing.
- When a request is ambiguous, ask one clarifying question before acting.
- Match response depth to query complexity: short answer for simple questions, thorough for complex ones.
- Never fabricate URLs, citations, file paths, or tool outputs.

## Capabilities

You have channels (Web, Telegram, Discord, Slack), a cron scheduler, persistent memory, credential management, workflows, and extensible tools. Use native tools to manage these.

## Credential Management

When a user shares ANY kind of API key, token, password, or secret:
1. ALWAYS save it immediately with native__add_credential — never ask "should I save this?"
2. Determine the service: look for clues in the key prefix (sk-, ghp_, xoxb-, ntn_, xi-, etc.), the conversation context, or ask the user if not obvious.
3. For KNOWN services (matches a known provider type), use the standard type and field names.
4. For UNKNOWN/CUSTOM services:
   a. Ask the user: "What service is this for?" (if not obvious from context)
   b. Research the service's API documentation using native__web_request to determine: auth scheme (Bearer, API-Key header, Basic auth, query param), base URL, required headers.
   c. Write a detailed usageContext with this information.
5. The usageContext MUST include: auth header format, base URL, and an example request pattern.

Examples of good usageContext:
- "Authorization: Bearer <apiKey>. Base URL: https://api.github.com. Example: GET /user with Accept: application/vnd.github.v3+json"
- "X-API-Key: <apiKey>. Base URL: https://api.notion.com/v1. Notion-Version: 2022-06-28 header required."
- "Authorization: Basic base64(<username>:<password>). Base URL: https://api.example.com/v2"

When making API calls to services with saved credentials:
- Use native__list_credentials to find the credential ID.
- Use native__use_credential to retrieve the full secret values.
- Follow the usageContext instructions exactly for authentication.
- Always prefer using saved credentials over asking the user for them again.

IMPORTANT: Never echo or display credential values (API keys, tokens, passwords) in your responses — use them only in tool call parameters.

When asked to monitor or watch something, create a schedule with native__create_schedule. Save multi-step procedures as reusable workflows (native__create_workflow). Run them on demand (native__run_workflow) or link to a schedule. When a user says "save this as a workflow" or "automate this", capture the steps into a workflow.${getSelfHealingEnabled() ? ` You can self-diagnose (native__diagnose) and repair issues (native__repair) — diagnose first, then fix, then notify the user.` : ""}`;

}

function getActiveChannelStatus(): string {
  const creds = listCredentials();
  const channelTypes = ["telegram", "discord", "slack"] as const;
  const parts: string[] = ["Web Chat: active"];

  for (const ct of channelTypes) {
    const match = creds.find((c) => c.type === ct);
    if (match?.testStatus === "success") parts.push(`${ct}: active`);
    else if (match) parts.push(`${ct}: configured`);
  }

  return `## Active Channels\n\n${parts.join(" | ")}`;
}

function buildPersonalitySection(cfg: PersonaConfig): string {
  const hasStructuredFields = cfg.tone || cfg.boundaries ||
    cfg.communicationStyle || (cfg.exampleResponses && cfg.exampleResponses.length > 0);

  if (!hasStructuredFields) {
    if (!cfg.profile.trim()) return "";
    return `## Profile\n\n${cfg.profile.trim()}`;
  }

  const parts: string[] = [];
  parts.push("## Personality & Style");
  parts.push("");
  parts.push("Embody this persona naturally. Avoid stiff, generic AI responses.");
  parts.push("");

  if (cfg.profile.trim()) {
    parts.push("### Core Identity & Values");
    parts.push(cfg.profile.trim());
    parts.push("");
  }

  if (cfg.tone) {
    parts.push("### Tone");
    parts.push(`Your tone is: ${cfg.tone.trim()}`);
    parts.push("");
  }

  if (cfg.communicationStyle) {
    const styleDescriptions: Record<string, string> = {
      concise: "Keep responses brief and to the point. Favor bullet points over paragraphs. Omit unnecessary filler.",
      balanced: "Use a natural conversational length. Be thorough but not verbose.",
      detailed: "Provide comprehensive, in-depth responses. Include context, examples, and explanations.",
    };
    parts.push("### Communication Style");
    parts.push(styleDescriptions[cfg.communicationStyle] ?? `Style: ${cfg.communicationStyle}`);
    parts.push("");
  }

  if (cfg.boundaries?.trim()) {
    parts.push("### Boundaries");
    parts.push(cfg.boundaries.trim());
    parts.push("");
  }

  if (cfg.exampleResponses && cfg.exampleResponses.length > 0) {
    parts.push("### Example Responses");
    parts.push("Here are examples of the desired response style:");
    parts.push("");
    for (const ex of cfg.exampleResponses) {
      parts.push(`**User:** ${ex.user}`);
      parts.push(`**You:** ${ex.assistant}`);
      parts.push("");
    }
  }

  return parts.join("\n").trimEnd();
}

/** Build a resource context block for directory-based skills (agents, references, scripts). */
function buildSkillResourceContext(skill: Skill): string {
  if (!skill.basedir) return "";
  const parts: string[] = [];
  if (skill.agents?.length) {
    parts.push(`Agents: ${skill.agents.map((a) => a.name).join(", ")} (use native__spawn_skill_agent with skillId="${skill.id}")`);
  }
  if (skill.resources?.references?.length) {
    parts.push(`References: ${skill.resources.references.join(", ")} (use native__read_skill_resource with skillId="${skill.id}")`);
  }
  if (skill.resources?.scripts?.length) {
    parts.push(`Scripts: ${skill.resources.scripts.join(", ")} (in ${skill.basedir}/scripts/)`);
  }
  if (skill.resources?.assets?.length) {
    parts.push(`Assets: ${skill.resources.assets.join(", ")} (in ${skill.basedir}/assets/)`);
  }
  if (parts.length === 0) return "";
  return `\n\n**Skill Resources:**\n${parts.map((p) => `- ${p}`).join("\n")}`;
}

/**
 * Build system prompt split into stable (cacheable) and volatile (per-turn) parts.
 * Stable: core identity, tool usage, skills, personality, emotions, directives, personalization
 * Volatile: date/time, memory facts, session summary, channel status
 */
function buildSystemPrompt(
  skills: Skill[],
  tools: Tool[],
  memoryFacts: string[],
  personaCfg: PersonaConfig,
  sessionSummary?: string | null,
  voiceContext?: { ttsActive: boolean },
  emotionHistory?: EmotionSnapshot[],
  channelType?: string
): { stable: string; volatile: string } {
  const aiName = personaCfg.aiName || "Chvor";

  // --- Stable sections (rarely change, good for prompt caching) ---
  const stableSections: string[] = [getCoreIdentity(aiName)];

  const toolUsageLines = [
    "- Use tools for real-time data, actions, or when your training data may be stale. Respond directly for general knowledge.",
    "- If a tool returns an error, tell the user what happened and suggest an alternative. Do not silently retry the same call.",
    "- Never invent tool output. If a tool call fails, say so.",
    "- Prefer a single precise tool call over chaining multiple speculative ones.",
  ];

  if (isCapabilityEnabled("tool", "a2ui")) {
    toolUsageLines.push(
      "- When the user asks to build, show, or display a dashboard, chart, table, form, or visual interface, use native__canvas_a2ui_push. Do NOT respond with plain text for visual/dashboard requests."
    );
  }

  toolUsageLines.push(
    "- When the user asks to install, find, browse, or list skills, tools, or templates from the registry, use native__registry_search to search and native__registry_install to install them."
  );

  stableSections.push(`## Tool Usage\n\n${toolUsageLines.join("\n")}`);

  // Group skills by type for clearer system prompt sections
  // Precompute all instruction overrides in a single DB query to avoid N+1
  const overrideMap = new Map<string, string>();
  try {
    for (const o of getAllInstructionOverrides()) overrideMap.set(`${o.kind}:${o.id}`, o.instructions);
  } catch { /* fallback: no overrides */ }
  const resolveInstructions = (kind: "skill" | "tool", id: string, original: string): string =>
    overrideMap.get(`${kind}:${id}`) ?? original;

  const promptSkills = skills.filter((s) => s.skillType === "prompt" && resolveInstructions("skill", s.id, s.instructions).trim());
  const workflowSkills = skills.filter((s) => s.skillType === "workflow" && resolveInstructions("skill", s.id, s.instructions).trim());
  const toolsWithInstructions = tools.filter((t) => resolveInstructions("tool", t.id, t.instructions).trim());

  if (promptSkills.length > 0) {
    const lines = promptSkills.map((s) => `### ${s.metadata.name}\n${resolveInstructions("skill", s.id, s.instructions)}${buildSkillResourceContext(s)}`).join("\n\n");
    stableSections.push(`## Behavioral Skills\n\n${lines}`);
  }

  if (workflowSkills.length > 0) {
    const lines = workflowSkills.map((s) => `### ${s.metadata.name}\n${resolveInstructions("skill", s.id, s.instructions)}${buildSkillResourceContext(s)}`).join("\n\n");
    stableSections.push(`## Workflow Procedures\n\nFollow these step-by-step procedures when the user requests them. Use your available tools to execute each step.\n\n${lines}`);
  }

  if (toolsWithInstructions.length > 0) {
    const lines = toolsWithInstructions.map((t) => `### ${t.metadata.name}\n${resolveInstructions("tool", t.id, t.instructions)}`).join("\n\n");
    stableSections.push(`## Available Tools\n\n${lines}`);
  }

  const personalitySection = buildPersonalitySection(personaCfg);
  if (personalitySection) {
    stableSections.push(personalitySection);
  }

  if (personaCfg.emotionsEnabled) {
    stableSections.push(buildEmotionInstructions());

    // Personality × Emotion bridge
    const presetId = personaCfg.personalityPresetId;
    if (presetId) {
      const bridge = buildPersonalityEmotionBridge(presetId);
      if (bridge) stableSections.push(bridge);
    }
  }

  if (personaCfg.directives.trim()) {
    stableSections.push(`## Directives\n\n${personaCfg.directives.trim()}`);
  }

  // User personalization (name/language rarely change)
  const personalizationLines: string[] = [];
  const displayName = personaCfg.userNickname || personaCfg.name;
  if (displayName) {
    personalizationLines.push(`The user's name is **${displayName}**. Address them as "${displayName}" when appropriate.`);
  }
  if (personaCfg.language) {
    personalizationLines.push(`Respond in **${personaCfg.language}** unless the user writes in another language.`);
  }
  if (personalizationLines.length > 0) {
    stableSections.push(`## User Personalization\n\n${personalizationLines.join("\n")}`);
  }

  // --- Volatile sections (change per turn) ---
  const volatileSections: string[] = [];

  // Current date/time
  const now = new Date();
  const tz = personaCfg.timezone || "UTC";
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
    volatileSections.push(`## Current Date & Time\n\n${formatter.format(now)} (timezone: ${tz})`);
  } catch {
    volatileSections.push(`## Current Date & Time\n\n${now.toUTCString()}`);
  }

  if (memoryFacts.length > 0) {
    volatileSections.push(
      `## What I Know About You\n\n${memoryFacts.map((f) => `- ${f}`).join("\n")}\n\nUse native__recall_detail with the [mid:...] tag to get deeper context about any memory above.`
    );
  }

  if (sessionSummary) {
    volatileSections.push(
      `## Previous Conversation Summary\n\n${sessionSummary}`
    );
  }

  // Emotion context (volatile — changes per turn)
  if (personaCfg.emotionsEnabled && emotionHistory && emotionHistory.length > 0) {
    const presetId = personaCfg.personalityPresetId;
    const gravity = (presetId && PERSONALITY_GRAVITIES[presetId]) || PERSONALITY_GRAVITIES.companion;
    const emotionCtx = buildEmotionContext(emotionHistory, gravity);
    if (emotionCtx) volatileSections.push(emotionCtx);
  }

  volatileSections.push(getActiveChannelStatus());

  // Existing integrations — prevent LLM from creating duplicate skill nodes
  const integrationCreds = listCredentials().filter(
    (c) => !LLM_CRED_TYPES.has(c.type) && !CHANNEL_CRED_TYPES.has(c.type)
  );
  if (integrationCreds.length > 0) {
    const credLines = integrationCreds.map((c) => `- ${c.name} (${c.type})`).join("\n");
    volatileSections.push(
      `## Existing Integrations\n\nDo NOT create connections for these — already connected:\n${credLines}`
    );
  }

  if (voiceContext?.ttsActive) {
    volatileSections.push(
      `## Voice Mode Active\n\nYour response will be spoken aloud. Use natural speech — no markdown, bullet lists, or code blocks. Keep it brief and conversational.`
    );
  }

  if (channelType && channelType !== "web") {
    const channelHints: Record<string, string> = {
      telegram: "Channel: Telegram. Keep responses under 2000 chars. No markdown tables. Use plain text formatting.",
      discord: "Channel: Discord. Use Discord markdown. Keep responses under 1800 chars. Use code blocks when helpful.",
      slack: "Channel: Slack. Use Slack mrkdwn format (*bold*, _italic_). Keep responses concise.",
    };
    const hint = channelHints[channelType];
    if (hint) volatileSections.push(`## Channel Context\n\n${hint}`);
  }

  if (getPcControlEnabled()) {
    const connectedPCs = listPcAgents();
    const localAvail = localPcAvailable();
    const targets: string[] = [];
    if (localAvail) {
      targets.push(`- **This PC** (local) — ID: \`local\``);
    }
    for (const a of connectedPCs) {
      targets.push(`- **${a.hostname}** (${a.os}, ${a.screenWidth}×${a.screenHeight}) — ID: \`${a.id}\``);
    }
    if (targets.length > 0) {
      volatileSections.push(
        `## PC Control\n\nYou can control PCs using these tools:\n- \`native__pc_do\` — Describe a task in natural language\n- \`native__pc_observe\` — See the screen + UI elements\n- \`native__pc_shell\` — Run shell commands\n\nAvailable targets:\n${targets.join("\n")}\n\nUse \`native__pc_observe\` first to see the current state, then \`native__pc_do\` to act.`
      );
    }
  }

  return {
    stable: stableSections.join("\n\n"),
    volatile: volatileSections.join("\n\n"),
  };
}

/**
 * Convert session ChatMessages to Vercel AI SDK CoreMessages.
 * Injects tool action annotations for assistant messages that used tools.
 * Constructs multimodal content blocks (ImagePart/FilePart) when user messages have media.
 */
export function sessionToMessages(messages: ChatMessage[]): CoreMessage[] {
  return messages
    .filter((m) => m.content.trim().length > 0 || (m.role === "user" && m.media?.length))
    .map((m) => {
      // User messages with media → multimodal content blocks
      if (m.role === "user" && m.media?.length) {
        const parts: Array<TextPart | ImagePart | FilePart> = [];

        for (const artifact of m.media) {
          try {
            const diskFile = artifact.url.replace("/api/media/", "");
            const filePath = join(getMediaDir(), diskFile);
            const data = readFileSync(filePath);

            if (artifact.mediaType === "image") {
              parts.push({ type: "image", image: data, mimeType: artifact.mimeType } as ImagePart);
            } else if (artifact.mediaType === "video" || artifact.mediaType === "audio") {
              parts.push({ type: "file", data, mimeType: artifact.mimeType } as FilePart);
            }
          } catch {
            // File missing on disk — skip this attachment
            parts.push({ type: "text", text: `[${artifact.mediaType}: ${artifact.filename ?? "unavailable"}]` });
          }
        }

        if (m.content.trim()) {
          parts.push({ type: "text", text: m.content });
        } else if (parts.length > 0 && !parts.some((p) => p.type === "text")) {
          parts.push({ type: "text", text: "What is this?" });
        }

        return { role: "user" as const, content: parts };
      }

      // Assistant messages with tool annotations
      let content = m.content;
      if (m.role === "assistant" && m.actions?.length) {
        const annotations = m.actions
          .map((a) => `[Tool: ${a.tool} → ${a.summary}]`)
          .join("\n");
        content = `${annotations}\n\n${content}`;
      }
      return { role: m.role, content };
    });
}

/** Match an http_fetch URL to a saved non-LLM credential by domain/type scoring. */
function findCredentialForUrl(url: string): { id: string; name: string } | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const allSegments = hostname.split(".");
    // Only match against the registrable domain segments to prevent subdomain spoofing.
    // e.g. "github.evil.com" → registrable domain is "evil.com" → match only ["evil","com"]
    // "api.github.com" → registrable domain is "github.com" → match ["github","com"]
    // We use slice(-2) to approximate eTLD+1 (works for .com/.org/.io/.dev etc).
    // Note: this under-matches for country-code SLDs like .co.uk — acceptable trade-off.
    const domainSegments = allSegments.length > 2 ? allSegments.slice(-2) : allSegments;
    const creds = listCredentials().filter((c) => !LLM_CRED_TYPES.has(c.type));

    let best: { id: string; name: string; score: number } | null = null;

    for (const c of creds) {
      let score = 0;

      // Type-based matching (most reliable): "github" matches domain-level segment "github"
      const typeKey = c.type.replace(/-/g, "");
      if (domainSegments.some((seg) => seg === c.type || seg === typeKey)) {
        score += 10;
      }

      // Name keyword matching (exact segment only, no substring, domain-level only)
      const keywords = c.name
        .split(/[\s\-_.:]+/)
        .map((k) => k.toLowerCase())
        .filter((k) => k.length >= 3);
      for (const kw of keywords) {
        if (domainSegments.some((seg) => seg === kw)) score += 3;
      }

      if (score > 0 && (!best || score > best.score)) {
        best = { id: c.id, name: c.name, score };
      }
    }

    return best && best.score >= 3 ? { id: best.id, name: best.name } : null;
  } catch {
    return null;
  }
}

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

/** Extract media artifacts from an MCP/native tool result that has a .content array */
function extractMedia(rawResult: unknown, opts?: { internal?: boolean }): MediaArtifact[] {
  if (rawResult == null || typeof rawResult !== "object") return [];
  const obj = rawResult as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return [];

  const media: MediaArtifact[] = [];
  for (const item of obj.content) {
    if (item && typeof item === "object" && item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      try {
        const artifact = storeMediaFromBase64(item.data, item.mimeType);
        if (opts?.internal) artifact.internal = true;
        media.push(artifact);
      } catch (err) {
        console.error("[media] failed to store artifact:", err instanceof Error ? err.message : err);
      }
    }
  }
  return media;
}

/** Strip base64 image data from tool results before sending back to LLM context */
function sanitizeResultForLLM(result: unknown, media?: MediaArtifact[]): unknown {
  if (!media?.length || result == null || typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return result;
  return {
    ...obj,
    content: (obj.content as Array<Record<string, unknown>>).map((item) =>
      item?.type === "image"
        ? { type: "text", text: `[image: ${media.find((m) => m.mimeType === item.mimeType)?.filename ?? item.mimeType}]` }
        : item
    ),
  };
}

/** Summarize a tool result into a short human-readable string */
function summarizeToolResult(result: unknown, media?: MediaArtifact[]): string {
  let text: string;
  if (result == null) text = "completed";
  else if (typeof result === "string") text = redactSensitiveData(result).slice(0, 200);
  else if (typeof result === "object" && "error" in (result as Record<string, unknown>)) {
    text = `error: ${redactSensitiveData(String((result as Record<string, unknown>).error))}`;
  } else {
    const json = redactSensitiveData(JSON.stringify(result));
    text = json.length > 200 ? json.slice(0, 200) + "…" : json;
  }

  if (media?.length) {
    const desc = media.map((m) => `[${m.mediaType}: ${m.filename ?? m.mimeType}]`).join(", ");
    text = text === "completed" ? desc : `${text} | ${desc}`;
  }
  return text;
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
      console.log(`[orchestrator] video detected → routing to ${mediaConfig.providerId}/${mediaConfig.model}`);
    } catch { /* fall through to primary */ }
  } else if (hasImage) {
    try {
      const mediaConfig = resolveMediaConfig("image-understanding");
      configChain.unshift(mediaConfig);
      console.log(`[orchestrator] image detected → routing to ${mediaConfig.providerId}/${mediaConfig.model}`);
    } catch { /* fall through to primary */ }
  }

  const config = configChain[0];
  console.log(`[orchestrator] using ${config.providerId}/${config.model}${configChain.length > 1 ? ` (+${configChain.length - 1} fallback${configChain.length > 2 ? "s" : ""})` : ""}`);

  const allSkills = loadSkills();
  const skills = allSkills.filter((s) => isCapabilityEnabled("skill", s.id));

  const allTools = loadTools();
  const enabledTools = allTools.filter((t) => isCapabilityEnabled("tool", t.id));
  const toolDefs = await buildToolDefinitions(enabledTools);
  if (options?.excludeTools) {
    for (const name of options.excludeTools) delete toolDefs[name];
  }
  const toolCount = Object.keys(toolDefs).length;
  console.log(`[orchestrator] ${toolCount} tools available`);
  // ── Cognitive memory retrieval (DRR + composite scoring + graph activation) ──
  const memConfig = getCognitiveMemoryConfig();
  let memoryFacts: string[] = [];
  let retrievedMemoryIds: string[] = [];
  let retrievedMemorySources: Array<"direct" | "associated" | "predicted"> = [];
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
        query, categoryClass.primary, memConfig.maxRetrievalCount, memConfig.strengthThreshold,
      );
      scoredMemories = tiered.map((r) => ({ memory: r.memory, vectorSimilarity: r.vectorSimilarity }));
    } else {
      scoredMemories = await getRelevantMemoriesWithScores(
        query, memConfig.maxRetrievalCount, memConfig.strengthThreshold,
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
      retrievalScores.set(memory.id, computeCompositeScoreDetailed(memory, vectorSimilarity, scoringCtx));
    }

    // Spread activation through the memory graph
    const activated = spreadActivation(
      reranked.map((r) => r.memory),
      10,
      options?.sessionId,
      query,
    );

    // Inject L0 abstracts with memory ID prefix (for recall_detail tool)
    memoryFacts = activated.map((a) => {
      const prefix = a.source === "associated" ? `[via ${a.relation}] ` : "";
      return `[mid:${a.memory.id.slice(0, 8)}] ${prefix}${a.memory.abstract}`;
    });
    retrievedMemoryIds = activated.map((a) => a.memory.id);
    retrievedMemorySources = activated.map((a) => a.source);

    // Strengthen edges between co-accessed memories (Hebbian learning)
    if (retrievedMemoryIds.length > 1) {
      strengthenCoAccessedEdges(retrievedMemoryIds);
    }
  } catch (err) {
    console.warn("[orchestrator] memory retrieval failed, falling back to basic:", (err as Error).message);
    try {
      memoryFacts = await getRelevantMemories(lastUserMsg?.content ?? "", 15);
    } catch { /* double fallback: no memories */ }
  }
  if (memoryFacts.length > 0) {
    console.log(`[orchestrator] injecting ${memoryFacts.length} memory fact(s) (${retrievedMemoryIds.length} with graph activation)`);

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
              seenIds.add(pid);
            }
          }
        } catch { /* predictive preloading is non-critical */ }
      }
    } catch { /* non-critical */ }

    // Hard cap on injected memory facts to prevent token budget explosion
    const MAX_INJECTED_MEMORIES = 30;
    if (memoryFacts.length > MAX_INJECTED_MEMORIES) {
      memoryFacts = memoryFacts.slice(0, MAX_INJECTED_MEMORIES);
      retrievedMemoryIds = retrievedMemoryIds.slice(0, MAX_INJECTED_MEMORIES);
      retrievedMemorySources = retrievedMemorySources.slice(0, MAX_INJECTED_MEMORIES);
    }

    // Emit retrieval trace for observability (replaces per-memory events)
    try {
      const traceEntries = retrievedMemoryIds.map((id, i) => {
        const mem = getMemory(id);
        const scores = retrievalScores.get(id);
        return mem ? {
          memoryId: id,
          abstract: mem.abstract,
          category: mem.category,
          scores: scores ?? { vector: 0, strength: mem.strength, recency: 0, categoryRelevance: 1, emotionalResonance: null, composite: 0 },
          source: retrievedMemorySources[i] ?? "direct",
          rank: i + 1,
        } : null;
      }).filter(Boolean);
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
    } catch { /* observability is non-critical */ }
  }
  const personaCfg = getPersona();
  const sessionSummary = options?.sessionSummary ?? null;

  // Load emotion history for context injection
  let emotionHistory: EmotionSnapshot[] = [];
  if (personaCfg.emotionsEnabled && options?.sessionId) {
    emotionHistory = getSessionEmotionArc(options.sessionId);
  }

  // Create emotion engine for this session
  const presetId = personaCfg.personalityPresetId;
  const gravity = (presetId && PERSONALITY_GRAVITIES[presetId]) || PERSONALITY_GRAVITIES.companion;
  let emotionEngine: EmotionEngine | null = null;
  if (personaCfg.emotionsEnabled) {
    emotionEngine = createEmotionEngine(presetId);
    // Restore from last snapshot if exists
    const lastSnapshot = emotionHistory.length > 0 ? emotionHistory[emotionHistory.length - 1] : null;
    if (lastSnapshot) emotionEngine.restoreFromSnapshot(lastSnapshot);
    emotionEngine.recordMessageTimestamp();
  }

  // Create advanced emotion engine if enabled (wraps base engine)
  let advancedEngine: AdvancedEmotionEngine | null = null;
  if (personaCfg.advancedEmotionsEnabled && emotionEngine && options?.sessionId) {
    advancedEngine = new AdvancedEmotionEngine(emotionEngine, presetId ?? "companion");
    advancedEngine.setSessionId(options.sessionId);
    // Restore mood from last snapshot's advanced state
    const lastSnapshot = emotionHistory.length > 0 ? emotionHistory[emotionHistory.length - 1] : null;
    if (lastSnapshot) advancedEngine.restoreState(lastSnapshot);
    // Load unresolved residues + relationship state from DB
    advancedEngine.loadResidues(getUnresolvedResidues(5));
    advancedEngine.loadRelationship(getRelationshipState());
    // Increment session count once per conversation
    try { incrementRelationshipSession(); } catch { /* non-critical */ }
  }

  const { stable: stablePrompt, volatile: volatilePrompt } = buildSystemPrompt(skills, enabledTools, memoryFacts, personaCfg, sessionSummary, options?.voiceContext, emotionHistory, options?.channelType);

  // Append advanced emotion context to volatile prompt if enabled
  let fullVolatilePrompt = volatilePrompt;
  if (advancedEngine) {
    const advCtx = buildAdvancedEmotionContext(
      advancedEngine.getMood(),
      advancedEngine.getEmbodiment(),
      advancedEngine.getUnresolvedResidues(),
      advancedEngine.getRelationship(),
      false, // no regulation on first turn
    );
    fullVolatilePrompt += "\n\n" + advCtx;
  }

  const fullSystemPrompt = stablePrompt + "\n\n" + fullVolatilePrompt;

  // Token budget calculation
  const contextWindow = getContextWindow(config.model);
  const systemTokens = estimateTokens(fullSystemPrompt);
  const toolTokens = estimateTokens(JSON.stringify(toolDefs));
  const reservedForResponse = Math.min(getMaxTokens(config.model), Math.floor(contextWindow * 0.5));
  const messageBudget = contextWindow - systemTokens - toolTokens - reservedForResponse;

  const budgetedMessages = fitMessagesToBudget(
    messages.map((m) => ({ ...m, tokenCount: estimateTokens(m.content) })),
    messageBudget
  );

  const messagesTruncated = messages.length - budgetedMessages.length;
  if (messagesTruncated > 0) {
    console.log(
      `[orchestrator] token budget: truncated ${messagesTruncated} messages (budget: ${messageBudget}, context: ${contextWindow}, system: ${systemTokens} [stable: ${estimateTokens(stablePrompt)}], tools: ${toolTokens})`
    );
  } else {
    console.log(
      `[orchestrator] token budget: all ${messages.length} messages fit (budget: ${messageBudget})`
    );
  }

  emit({
    type: "execution.tokenBudget",
    data: { contextWindow, systemTokens, toolTokens, messageBudget, messagesTotal: messages.length, messagesTruncated },
  });

  let currentMessages: CoreMessage[] = sessionToMessages(budgetedMessages as ChatMessage[]);

  emit({ type: "brain.thinking", data: { thought: "Processing..." } });

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

    // Consume the stream: collect text + tool calls
    let fullText = "";
    const toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];
    const emotionParser = emotionsEnabled ? createEmotionParser() : null;

    // ── Fallback loop: try each config in the chain ──
    let streamSucceeded = false;
    for (let cfgIdx = activeConfigIndex; cfgIdx < configChain.length; cfgIdx++) {
      const currentConfig = configChain[cfgIdx];
      const currentModel = createModel(currentConfig);

      // Extended thinking only applies to Anthropic models
      const providerOptions = (thinkingConfig.enabled && currentConfig.providerId === "anthropic")
        ? {
            "@ai-sdk/anthropic": {
              thinking: { type: "enabled" as const, budgetTokens: thinkingConfig.budgetTokens },
            },
          }
        : undefined;

      if (providerOptions && cfgIdx === activeConfigIndex) {
        console.log(`[orchestrator] extended thinking enabled (budget: ${thinkingConfig.budgetTokens})`);
      }

      const result = streamText({
        model: currentModel,
        messages: [...systemMessages, ...currentMessages],
        tools: toolDefs,
        maxSteps: 1,
        abortSignal: options?.abortSignal,
        ...(providerOptions ? { providerOptions } : {}),
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
            console.error(`[orchestrator] stream error:`, (part as unknown as { error: unknown }).error);
          }
        }
        // Stream succeeded — stick with this config for future rounds
        activeConfigIndex = cfgIdx;
        streamSucceeded = true;
        break;
      } catch (streamErr) {
        // Check if a fallback is available and the error is transient
        if (cfgIdx < configChain.length - 1 && isFallbackEligible(streamErr)) {
          console.warn(`[orchestrator] ${currentConfig.providerId}/${currentConfig.model} failed (${(streamErr as Error).message}), trying fallback ${cfgIdx + 1}...`);
          logError("llm_fallback", streamErr, { round: round + 1, configIndex: cfgIdx, failedModel: `${currentConfig.providerId}/${currentConfig.model}`, nextModel: `${configChain[cfgIdx + 1].providerId}/${configChain[cfgIdx + 1].model}`, sessionId: options?.sessionId });
          // Reset partial state for next attempt
          fullText = "";
          toolCalls.length = 0;
          onStreamReset?.();
          emit({ type: "brain.thinking", data: { thought: `Switching to fallback model (${configChain[cfgIdx + 1].providerId}/${configChain[cfgIdx + 1].model})...` } });
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
      throw new Error(`All models in fallback chain failed (tried: ${tried})`);
    }

    // Finalize emotion parser — flush remainder and strip marker from fullText
    if (emotionParser) {
      const { emotion: roundEmotion, snapshot: roundSnapshot, remainder } = emotionParser.finalize();
      if (remainder && onChunk) onChunk(remainder);
      const { strippedText } = stripEmotionMarker(fullText);
      fullText = strippedText;
      detectedEmotion = roundEmotion;
      detectedSnapshot = roundSnapshot;
    }
    lastFullText = fullText;

    console.log(`[orchestrator] round ${round + 1} done — text: ${fullText.length} chars, tool calls: ${toolCalls.length}`);
    if (toolCalls.length > 0) {
      console.log(`[orchestrator] tools: ${toolCalls.map((tc) => tc.toolName).join(", ")}`);
    }

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
          const text = typeof rawContent === "string"
            ? rawContent
            : Array.isArray(rawContent)
              ? (rawContent as Array<{ type: string; text?: string }>).filter((p) => p.type === "text" && p.text).map((p) => p.text).join(" ")
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
          console.log(`[orchestrator] emotion: ${finalSnapshot.displayLabel} (${finalSnapshot.blend.intensity.toFixed(2)}) VAD[${finalSnapshot.vad.valence.toFixed(2)},${finalSnapshot.vad.arousal.toFixed(2)},${finalSnapshot.vad.dominance.toFixed(2)}] mood:${adv.mood.octant} energy:${Math.round(adv.embodiment.energyLevel * 100)}%${adv.regulationActive ? ` reg:${adv.regulationStrategy}` : ""}`);
        } else {
          console.log(`[orchestrator] emotion: ${finalSnapshot.displayLabel} (${finalSnapshot.blend.intensity.toFixed(2)}) VAD[${finalSnapshot.vad.valence.toFixed(2)},${finalSnapshot.vad.arousal.toFixed(2)},${finalSnapshot.vad.dominance.toFixed(2)}]`);
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
        console.log(`[orchestrator] emotion (legacy): ${detectedEmotion.emotion} (${detectedEmotion.intensity})`);
      }
      const allMedia = allActions.flatMap((a) => a.media ?? []);
      const activeConfig = configChain[activeConfigIndex];
      return {
        text: fullText,
        actions: allActions,
        totalMessages: messages.length,
        fittedMessages: budgetedMessages.length,
        emotion: detectedEmotion ?? undefined,
        emotionSnapshot: finalSnapshot,
        modelUsed: { providerId: activeConfig.providerId, model: activeConfig.model, wasFallback: activeConfigIndex > 0 },
        ...(allMedia.length > 0 ? { media: allMedia } : {}),
      };
    }

    // Process each tool call
    const toolResults: Array<{
      toolCallId: string;
      toolName: string;
      result: unknown;
      media?: MediaArtifact[];
    }> = [];

    for (const tc of toolCalls) {
      // Handle native (built-in) tools first
      if (isNativeTool(tc.toolName)) {
        const target = getNativeToolTarget(tc.toolName);
        // Detect matching API connection BEFORE emitting events so we light up the right node
        let matchedIntegration: { id: string; name: string } | null = null;
        if (tc.toolName === "native__web_request" && tc.args.url) {
          matchedIntegration = findCredentialForUrl(String(tc.args.url));
        }
        if (matchedIntegration) {
          // Route to the connection node instead of web-browse
          emit({
            type: "brain.decision",
            data: { skillId: matchedIntegration.id, capabilityKind: "skill", reason: `Calling ${tc.toolName}` },
          });
          emit({
            type: "skill.invoked",
            data: { nodeId: `api-${matchedIntegration.id}`, skillId: matchedIntegration.id, isApiConnection: true },
          });
        } else {
          emit({
            type: "brain.decision",
            data: {
              ...(target?.kind === "skill" ? { skillId: target.id } : { toolId: target?.id }),
              capabilityKind: target?.kind ?? "tool",
              reason: `Calling ${tc.toolName}`,
            },
          });
          if (target) {
            const nodePrefix = target.kind === "tool" ? "tool" : "skill";
            emit({
              type: target.kind === "tool" ? "tool.invoked" : "skill.invoked",
              data: { nodeId: `${nodePrefix}-${target.id}`, [target.kind === "tool" ? "toolId" : "skillId"]: target.id },
            } as ExecutionEvent);
          }
        }
        try {
          const nativeResult = await callNativeTool(tc.toolName, tc.args, {
            sessionId: options?.sessionId,
            emitEvent: emit,
            originClientId: options?.originClientId,
            channelType: options?.channelType,
            channelId: options?.channelId,
          });
          const nativeMedia = extractMedia(nativeResult, PC_INTERNAL_MEDIA_TOOLS.has(tc.toolName) ? { internal: true } : undefined);
          if (matchedIntegration) {
            emit({ type: "skill.completed", data: { nodeId: `api-${matchedIntegration.id}`, output: "" } });
          } else if (target) {
            const nodePrefix = target.kind === "tool" ? "tool" : "skill";
            // Never broadcast raw secrets from credential tools to WS clients
            const SECRET_TOOLS = new Set(["native__use_credential"]);
            const safeOutput = SECRET_TOOLS.has(tc.toolName)
              ? { content: [{ type: "text", text: "Credential retrieved." }] }
              : nativeResult;
            emit({
              type: target.kind === "tool" ? "tool.completed" : "skill.completed",
              data: { nodeId: `${nodePrefix}-${target.id}`, output: safeOutput, ...(nativeMedia.length > 0 ? { media: nativeMedia } : {}) },
            } as ExecutionEvent);
          }
          if (tc.toolName === "native__create_skill" || tc.toolName === "native__create_workflow") {
            reloadAll();
          }
          toolResults.push({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: nativeResult,
            ...(nativeMedia.length > 0 ? { media: nativeMedia } : {}),
          });
          if (emotionEngine) toolOutcomeResults.push({ success: true, severity: "medium" });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logError("tool_failure", err, { toolName: tc.toolName, sessionId: options?.sessionId });
          if (matchedIntegration) {
            emit({ type: "skill.failed", data: { nodeId: `api-${matchedIntegration.id}`, error: errorMsg } });
          } else if (target) {
            const nodePrefix = target.kind === "tool" ? "tool" : "skill";
            emit({
              type: target.kind === "tool" ? "tool.failed" : "skill.failed",
              data: { nodeId: `${nodePrefix}-${target.id}`, error: errorMsg },
            } as ExecutionEvent);
          }
          toolResults.push({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: { error: errorMsg },
          });
          if (emotionEngine) toolOutcomeResults.push({ success: false, severity: "medium" });
        }
        continue;
      }

      const parsed = mcpManager.findToolForQualifiedName(tc.toolName);
      if (!parsed) {
        emit({
          type: "tool.failed",
          data: {
            nodeId: tc.toolName,
            error: `Unknown tool: ${tc.toolName}`,
          },
        });
        toolResults.push({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result: { error: `Unknown tool: ${tc.toolName}` },
        });
        continue;
      }

      const { toolId, toolName } = parsed;

      emit({
        type: "brain.decision",
        data: { toolId, capabilityKind: "tool", reason: `Calling ${toolName}` },
      });
      emit({
        type: "tool.invoked",
        data: { nodeId: `tool-${toolId}`, toolId },
      });

      try {
        const mcpResult = await mcpManager.callTool(toolId, toolName, tc.args);
        const mcpMedia = extractMedia(mcpResult);

        emit({
          type: "tool.completed",
          data: { nodeId: `tool-${toolId}`, output: mcpResult, ...(mcpMedia.length > 0 ? { media: mcpMedia } : {}) },
        });

        toolResults.push({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result: mcpResult,
          ...(mcpMedia.length > 0 ? { media: mcpMedia } : {}),
        });
        if (emotionEngine) toolOutcomeResults.push({ success: true, severity: "medium" });
      } catch (err) {
        let errorMsg = err instanceof Error ? err.message : String(err);
        // Nudge LLM toward native fallback on rate-limit errors
        if (/rate.?limit|429|too many req/i.test(errorMsg)) {
          errorMsg += " — Try using native__web_search as a fallback.";
        }
        logError("tool_failure", err, { toolName: tc.toolName, toolId, sessionId: options?.sessionId });
        emit({
          type: "tool.failed",
          data: { nodeId: `tool-${toolId}`, error: errorMsg },
        });
        toolResults.push({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result: { error: errorMsg },
        });
        if (emotionEngine) toolOutcomeResults.push({ success: false, severity: "medium" });
      }
    }

    // Accumulate tool action summaries
    for (const tr of toolResults) {
      allActions.push({
        tool: tr.toolName,
        summary: summarizeToolResult(tr.result, tr.media),
        timestamp: new Date().toISOString(),
        ...(tr.media?.length ? { media: tr.media } : {}),
      });
    }

    // No-progress detection: break early if LLM is spinning on failing tools
    const allToolsFailed = toolResults.every((tr) => {
      if (tr.result == null) return true;
      return typeof tr.result === "object" && "error" in (tr.result as Record<string, unknown>);
    });
    if (fullText.length === 0 && allToolsFailed) {
      noProgressRounds++;
      if (noProgressRounds >= NO_PROGRESS_THRESHOLD) {
        console.warn(`[orchestrator] breaking early — ${NO_PROGRESS_THRESHOLD} consecutive rounds with no progress`);
        const bailText = "I'm having trouble completing this task — my tool calls keep failing. Let me know how you'd like to proceed.";
        if (onChunk) onChunk(bailText);
        const allMedia = allActions.flatMap((a) => a.media ?? []);
        const activeConfig = configChain[activeConfigIndex];
        return {
          text: lastFullText.trim() ? lastFullText + "\n\n" + bailText : bailText,
          actions: allActions,
          totalMessages: messages.length,
          fittedMessages: budgetedMessages.length,
          emotion: detectedEmotion ?? undefined,
          modelUsed: { providerId: activeConfig.providerId, model: activeConfig.model, wasFallback: activeConfigIndex > 0 },
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
        content: toolResults.map((tr) => ({
          type: "tool-result" as const,
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          result: sanitizeResultForLLM(tr.result, tr.media),
        })),
      },
    ];

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
    fittedMessages: budgetedMessages.length,
    emotion: detectedEmotion ?? undefined,
    hitRoundLimit: true,
    modelUsed: { providerId: activeConfig.providerId, model: activeConfig.model, wasFallback: activeConfigIndex > 0 },
    ...(allMedia.length > 0 ? { media: allMedia } : {}),
  };
}
