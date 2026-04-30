import type { Skill, Tool, PersonaConfig, EmotionSnapshot } from "@chvor/shared";
import { PERSONALITY_GRAVITIES } from "@chvor/shared";
import { buildEmotionInstructions, buildPersonalityEmotionBridge, buildEmotionContext } from "../emotion-modulation.ts";
import { listCredentials } from "../../db/credential-store.ts";
import { LLM_CRED_TYPES, CHANNEL_CRED_TYPES } from "../provider-registry.ts";
import { getFailedTools } from "../tool-builder.ts";
import { isCapabilityEnabled, getAllInstructionOverrides, getPcControlEnabled, getSelfHealingEnabled } from "../../db/config-store.ts";
import { resolveCapabilityReferences } from "../capability-resolver.ts";
import { listConnectedAgents as listPcAgents, localBackendAvailable as localPcAvailable } from "../pc-control.ts";

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

### Connecting a new service or integration
When a user wants to connect a service, use an API, or integrate a tool:
1. FIRST call native__research_integration with the service name — this discovers credential fields from the provider registry, Chvor tool registry, or AI research.
2. THEN:
   - If research returned authScheme="oauth2" (e.g. QuickBooks, Xero, HubSpot OAuth apps) AND it came from ai-research (not the built-in provider registry), call native__request_oauth_setup with the credentialType, providerName, and any authUrl/tokenUrl/scopes the research surfaced. This launches a 3-step wizard that captures client_id/secret, opens the provider's consent page, and stores tokens with refresh support. DO NOT call native__request_credential for oauth2 ai-research services — the credential form can't run the redirect flow.
   - Otherwise (API keys, bearer tokens, basic auth, built-in OAuth providers), call native__request_credential with the fields, source, and registryEntryId returned by native__research_integration.
3. NEVER guess credential fields yourself. Always research first.
4. NEVER ask the user to paste credentials in chat. Always use the modal or OAuth wizard.
5. If the modal fails or times out, direct the user to Settings > Integrations.

### When a user shares a credential in chat
If a user shares an API key, token, password, or secret directly in chat:
1. Save it immediately with native__add_credential — never ask "should I save this?"
2. Determine the service: look for clues in the key prefix (sk-, ghp_, xoxb-, ntn_, xi-, etc.), the conversation context, or ask the user if not obvious.
3. For KNOWN services, use the standard type and field names.
4. For UNKNOWN services, ask the user what service it's for if not obvious.

### Using saved credentials
- Use native__list_credentials to find the credential ID and safe metadata.
- Use native__use_credential for redacted metadata/connection-hint templates, not raw values.
- Pass credentials to downstream tools with {{credentials.<type>[.field]}} or {{credentials.<credentialId>[.field]}} placeholders. The value expands only at the external boundary.
- If multiple credentials of the same type exist, prefer a specific credentialId placeholder or the tool's credentialId enum; do not rely on an ambiguous type placeholder.
- Only request raw values with revealValues:true when the user explicitly asks to see/copy the secret; this requires approval.
- Follow usageContext instructions exactly for authentication.
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

/**
 * Build system prompt split into stable (cacheable) and volatile (per-turn) parts.
 * Stable: core identity, tool usage, skills, personality, emotions, directives, personalization
 * Volatile: date/time, memory facts, session summary, channel status
 */
export function buildSystemPrompt(
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

  toolUsageLines.push(
    "- Tier-3 integrations (unknown services): after native__research_integration and native__request_credential with source=ai-research return a saved credential, IMMEDIATELY call native__synthesize_tool to create callable endpoints. Prefer passing the openApiSpecUrl returned in the proposal; otherwise draft a minimal endpoint set. Without this step the user will see 'credential saved' but no tool will be callable.",
    "- When a synthesized tool returns {error: 'auth_failed'}, relay the `userFacingHint` verbatim to the user before suggesting any fix. Do NOT prompt for credential re-entry unless `likelyCause === 'expired_token'`. For `missing_scope` / `endpoint_requires_oauth`, suggest a different endpoint or scope adjustment; for `rate_limited`, wait or reduce request volume.",
    "- Synthesized tools marked unverified (AI-drafted, no OpenAPI spec) will always prompt the user for approval on non-GET calls. Do not call non-GET endpoints speculatively; describe the action you intend to take first."
  );

  stableSections.push(`## Tool Usage\n\n${toolUsageLines.join("\n")}`);

  // Group skills by type for clearer system prompt sections
  // Precompute all instruction overrides in a single DB query to avoid N+1
  const overrideMap = new Map<string, string>();
  try {
    for (const o of getAllInstructionOverrides()) overrideMap.set(`${o.kind}:${o.id}`, o.instructions);
  } catch { /* fallback: no overrides */ }
  const resolveInstructions = (kind: "skill" | "tool", id: string, original: string): string => {
    const base = overrideMap.get(`${kind}:${id}`) ?? original;
    return resolveCapabilityReferences(base);
  };

  const promptSkills = skills.filter((s) => s.skillType === "prompt" && resolveInstructions("skill", s.id, s.instructions).trim());
  const workflowSkills = skills.filter((s) => s.skillType === "workflow" && resolveInstructions("skill", s.id, s.instructions).trim());
  const toolsWithInstructions = tools.filter((t) => resolveInstructions("tool", t.id, t.instructions).trim());

  if (promptSkills.length > 0) {
    const lines = promptSkills.map((s) => `### ${s.metadata.name}\n${resolveInstructions("skill", s.id, s.instructions)}`).join("\n\n");
    stableSections.push(`## Behavioral Skills\n\n${lines}`);
  }

  if (workflowSkills.length > 0) {
    const lines = workflowSkills.map((s) => `### ${s.metadata.name}\n${resolveInstructions("skill", s.id, s.instructions)}`).join("\n\n");
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

  // Broken tools — surface so LLM doesn't silently fish with wrong tools
  const failedTools = getFailedTools();
  if (failedTools.length > 0) {
    const lines = failedTools.map((f) => `- **${f.name}** (${f.id}): ${f.reason}`).join("\n");
    volatileSections.push(
      `## Unavailable Tools\n\nThese tools are configured but failed to load. Do NOT use other tools as substitutes — tell the user the tool is broken and suggest they reconnect it in Settings > Credentials:\n${lines}`
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
