import { generateText } from "ai";
import type { ChatMessage } from "@chvor/shared";
import { createModelForRole } from "./llm-router.ts";
import { estimateTokens } from "./token-counter.ts";
import { updateSessionSummary } from "../db/session-store.ts";
import { containsSensitiveData } from "./sensitive-filter.ts";

const SUMMARIZATION_PROMPT = `Summarize this conversation for context continuity. This summary replaces messages the user can no longer see.

Format: structured prose, max 300 words. Prioritize (in order):
1. Unresolved questions and pending tasks
2. Decisions made and commitments
3. User preferences and corrections expressed
4. Topics discussed (brief)

Merge with any previous summary into ONE unified text. Preserve names, numbers, URLs, and technical specifics. NEVER include credentials, API keys, tokens, passwords, or secrets.

Return ONLY the summary text.`;

const MIN_MESSAGES_FOR_SUMMARY = 6;
const ROLLING_THRESHOLD_TOKENS = 3000;
const MAX_SUMMARY_TOKENS = 560;

// Per-session chains to avoid cross-session head-of-line blocking
const summarizationChains = new Map<string, Promise<void>>();

/**
 * Check if summarization should be triggered.
 * True when fitMessagesToBudget had to drop messages AND conversation is long enough.
 */
export function shouldSummarize(
  totalMessages: number,
  fittedMessages: number
): boolean {
  if (totalMessages <= MIN_MESSAGES_FOR_SUMMARY) return false;
  return fittedMessages < totalMessages;
}

/**
 * Fire-and-forget summarization of dropped messages.
 * Serialized per session — only one summarization per session runs at a time.
 */
export function triggerSummarization(
  sessionId: string,
  allMessages: ChatMessage[],
  fittedCount: number,
  existingSummary: string | null
): Promise<void> {
  const prev = summarizationChains.get(sessionId) ?? Promise.resolve();
  const next = prev
    .then(() => doSummarization(sessionId, allMessages, fittedCount, existingSummary))
    .catch((err) => console.error("[summarizer] error in chain:", err));
  summarizationChains.set(sessionId, next);
  // Clean up resolved chains to prevent memory leak
  next.then(() => {
    if (summarizationChains.get(sessionId) === next) {
      summarizationChains.delete(sessionId);
    }
  });
  return next;
}

async function doSummarization(
  sessionId: string,
  allMessages: ChatMessage[],
  fittedCount: number,
  existingSummary: string | null
): Promise<void> {
  let model;
  try {
    model = createModelForRole("lightweight");
  } catch {
    return; // No LLM configured
  }

  const droppedMessages = allMessages.slice(0, allMessages.length - fittedCount);
  if (droppedMessages.length === 0) return;

  console.log(
    `[summarizer] summarizing ${droppedMessages.length} dropped messages for session ${sessionId}`
  );

  // Build the conversation text from dropped messages
  const conversationText = droppedMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  // Build prompt with existing summary for rolling re-summarization
  let userContent = "";
  if (existingSummary) {
    const summaryTokens = estimateTokens(existingSummary);
    const label =
      summaryTokens > ROLLING_THRESHOLD_TOKENS
        ? "Previous summary (long — compress and consolidate):"
        : "Previous summary:";
    userContent += `${label}\n${existingSummary}\n\n`;
  }
  userContent += `Messages to summarize:\n${conversationText}`;

  const result = await generateText({
    model,
    system: SUMMARIZATION_PROMPT,
    messages: [{ role: "user", content: userContent }],
    maxSteps: 1,
    maxTokens: MAX_SUMMARY_TOKENS,
  });

  const summary = result.text.trim();
  if (!summary) {
    console.warn("[summarizer] empty summary returned");
    return;
  }

  // Discard if summary contains sensitive data
  if (containsSensitiveData(summary)) {
    console.log("[summarizer] discarding summary — contains sensitive data");
    return;
  }

  updateSessionSummary(sessionId, summary);
  console.log(
    `[summarizer] stored summary for session ${sessionId} (${estimateTokens(summary)} tokens)`
  );
}
