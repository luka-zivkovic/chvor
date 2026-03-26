/**
 * Lightweight token estimation and budget-aware message fitting.
 * Uses chars/4 heuristic (~85% accurate for English text).
 */

import type { MediaArtifact } from "@chvor/shared";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Rough token estimate for media attachments in a message. */
export function estimateMediaTokens(media?: MediaArtifact[]): number {
  if (!media?.length) return 0;
  let tokens = 0;
  for (const m of media) {
    if (m.mediaType === "image") tokens += 1000;
    else if (m.mediaType === "video") tokens += 2500;
    else if (m.mediaType === "audio") tokens += 500;
  }
  return tokens;
}

/**
 * Fit messages into a token budget, keeping the most recent ones.
 * Iterates newest→oldest, returns the slice that fits.
 */
export function fitMessagesToBudget(
  messages: Array<{ content: string; tokenCount?: number; media?: MediaArtifact[] }>,
  budget: number
): typeof messages {
  let used = 0;
  let startIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const textTokens = messages[i].tokenCount ?? estimateTokens(messages[i].content);
    const mediaTokens = estimateMediaTokens(messages[i].media);
    const tokens = textTokens + mediaTokens;
    if (used + tokens > budget) break;
    used += tokens;
    startIndex = i;
  }

  // Always include at least the most recent message so the LLM has context
  if (startIndex === messages.length && messages.length > 0) {
    startIndex = messages.length - 1;
  }

  return messages.slice(startIndex);
}
