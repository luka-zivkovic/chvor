import { Hono } from "hono";
import type { UpdatePersonaRequest } from "@chvor/shared";
import { getPersona, updatePersona } from "../db/config-store.ts";
import { getWSInstance } from "../gateway/ws-instance.ts";

const persona = new Hono();

persona.get("/", (c) => {
  try {
    return c.json({ data: getPersona() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

persona.patch("/", async (c) => {
  try {
    const wasOnboarded = getPersona().onboarded;
    const body = (await c.req.json()) as UpdatePersonaRequest;
    if (body.communicationStyle !== undefined &&
        !["concise", "balanced", "detailed", ""].includes(body.communicationStyle)) {
      return c.json({ error: "Invalid communicationStyle" }, 400);
    }
    if (body.exampleResponses) {
      body.exampleResponses = body.exampleResponses
        .filter((ex: { user?: string; assistant?: string }) => ex.user?.trim() && ex.assistant?.trim())
        .slice(0, 5);
    }
    const updated = updatePersona(body);

    // Trigger welcome message when onboarding just completed
    if (!wasOnboarded && updated.onboarded) {
      triggerWelcomeMessage(updated);
    }

    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

function triggerWelcomeMessage(persona: ReturnType<typeof getPersona>): void {
  const ws = getWSInstance();
  if (!ws) return;

  const aiName = persona.aiName || "Chvor";
  const userName = persona.userNickname || persona.name || "";
  const greeting = userName ? `Hey ${userName}!` : "Hey!";

  const welcomeText = [
    `${greeting} I'm ${aiName}, your personal AI assistant.`,
    "",
    "Here's what I can do right now:",
    "- **Remember things** about you across conversations",
    "- **Search the web** and browse pages for you",
    "- **Run scheduled tasks** (daily briefings, reminders)",
    "- **Execute commands** and manage files on your machine",
    "- **Connect to your tools** (Telegram, Discord, GitHub, Notion, and more)",
    "",
    "Try asking me something — you'll see my reasoning light up on the Brain Canvas.",
  ].join("\n");

  // Send as a system welcome event to all connected web clients
  // This avoids creating a session — the user's first real message will do that
  ws.broadcast({
    type: "chat.welcome",
    data: {
      content: welcomeText,
      aiName,
    },
  });
}

export default persona;
