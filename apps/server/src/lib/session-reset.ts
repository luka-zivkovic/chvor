import { clearSessionMessages, getRecentMessages } from "../db/session-store.ts";
import { extractAndStoreMemories, cleanupSessionExtractionState } from "./memory-extractor.ts";
import type { ChatMessage } from "@chvor/shared";

/**
 * Reset a session: extract memories from existing messages, then clear all messages.
 * The session record is preserved (same key reused on next message).
 */
export async function resetSession(sessionId: string, reason: string): Promise<void> {
  // Extract memories before wiping (best-effort, don't block on failure)
  try {
    const messages = getRecentMessages(sessionId, 100);
    if (messages.length > 0) {
      const channelType = messages[0].channelType ?? "web";
      await extractAndStoreMemories(messages as ChatMessage[], channelType, sessionId);
    }
  } catch (err) {
    console.error(`[session-reset] memory extraction failed for ${sessionId}:`, (err as Error).message);
  }

  clearSessionMessages(sessionId);
  cleanupSessionExtractionState(sessionId);
  console.log(`[session-reset] reset ${sessionId}: ${reason}`);
}
