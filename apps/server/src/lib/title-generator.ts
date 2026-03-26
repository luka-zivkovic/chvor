import { generateText } from "ai";
import { createModelForRole } from "./llm-router.ts";
import { getRecentMessages } from "../db/session-store.ts";

const TITLE_PROMPT = `You are a conversation title generator. Given a short excerpt of a conversation, produce a concise, descriptive title (3–6 words). The title should capture the main topic or intent.

Rules:
- 3–6 words maximum
- No punctuation at the end
- No quotes around the title
- No "Chat about" or "Discussion of" prefixes — just the topic itself
- If the conversation is ambiguous, pick the most prominent topic

Return ONLY the title text, nothing else.`;

const MIN_MESSAGES_FOR_TITLE = 2;

/**
 * Generate a short title for a session based on its first few messages.
 * Returns null if no LLM is configured or the session has too few messages.
 */
export async function generateSessionTitle(sessionId: string): Promise<string | null> {
  const messages = getRecentMessages(sessionId, 2, 0);
  if (messages.length < MIN_MESSAGES_FOR_TITLE) return null;

  let model;
  try {
    model = createModelForRole("lightweight");
  } catch {
    return null; // No LLM configured
  }

  const excerpt = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 200)}`)
    .join("\n\n");

  try {
    const result = await generateText({
      model,
      system: TITLE_PROMPT,
      messages: [{ role: "user", content: excerpt }],
      maxSteps: 1,
      maxTokens: 20,
    });

    const title = result.text.trim().replace(/["'.]+$/, "");
    return title || null;
  } catch (err) {
    console.error("[title-generator] error generating title:", err);
    return null;
  }
}
