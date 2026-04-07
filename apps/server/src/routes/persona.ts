import { Hono } from "hono";
import type { UpdatePersonaRequest, ExampleResponse } from "@chvor/shared";
import {
  VALID_COMMUNICATION_STYLES,
  VALID_PRESET_IDS,
  PERSONA_LIMITS,
} from "@chvor/shared";
import { getPersona, updatePersona } from "../db/config-store.ts";
import { getWSInstance } from "../gateway/ws-instance.ts";

function checkLength(
  value: string | undefined,
  max: number,
  label: string
): string | null {
  if (value !== undefined && value.length > max)
    return `${label} exceeds max length of ${max}`;
  return null;
}

const persona = new Hono();

persona.get("/", (c) => {
  try {
    return c.json({ data: getPersona() });
  } catch (err) {
    console.error("[persona] GET failed:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

persona.patch("/", async (c) => {
  try {
    const wasOnboarded = getPersona().onboarded;
    const body = (await c.req.json()) as UpdatePersonaRequest;

    // ── Length validation ────────────────────────────────────────────
    const lengthErr =
      checkLength(body.profile, PERSONA_LIMITS.profile, "profile") ??
      checkLength(body.directives, PERSONA_LIMITS.directives, "directives") ??
      checkLength(body.tone, PERSONA_LIMITS.tone, "tone") ??
      checkLength(body.boundaries, PERSONA_LIMITS.boundaries, "boundaries") ??
      checkLength(body.name, PERSONA_LIMITS.name, "name") ??
      checkLength(body.aiName, PERSONA_LIMITS.aiName, "aiName") ??
      checkLength(body.userNickname, PERSONA_LIMITS.userNickname, "userNickname") ??
      checkLength(body.language, PERSONA_LIMITS.language, "language") ??
      checkLength(body.timezone, PERSONA_LIMITS.timezone, "timezone");
    if (lengthErr) return c.json({ error: lengthErr }, 400);

    // ── communicationStyle whitelist ─────────────────────────────────
    if (body.communicationStyle !== undefined &&
        !(VALID_COMMUNICATION_STYLES as readonly string[]).includes(body.communicationStyle)) {
      return c.json({ error: "Invalid communicationStyle" }, 400);
    }

    // ── personalityPresetId whitelist ────────────────────────────────
    if (body.personalityPresetId !== undefined &&
        body.personalityPresetId !== "" &&
        !(VALID_PRESET_IDS as readonly string[]).includes(body.personalityPresetId)) {
      return c.json({ error: "Invalid personalityPresetId" }, 400);
    }

    // ── exampleResponses shape + length validation ──────────────────
    if (body.exampleResponses !== undefined) {
      if (!Array.isArray(body.exampleResponses)) {
        return c.json({ error: "exampleResponses must be an array" }, 400);
      }
      body.exampleResponses = body.exampleResponses
        .filter((ex): ex is ExampleResponse =>
          typeof ex?.user === "string" &&
          typeof ex?.assistant === "string" &&
          ex.user.trim() !== "" &&
          ex.assistant.trim() !== "")
        .map((ex) => ({
          user: ex.user.slice(0, PERSONA_LIMITS.exampleText),
          assistant: ex.assistant.slice(0, PERSONA_LIMITS.exampleText),
        }))
        .slice(0, PERSONA_LIMITS.maxExamples);
    }

    const updated = updatePersona(body);

    // Trigger welcome message when onboarding just completed
    if (!wasOnboarded && updated.onboarded) {
      triggerWelcomeMessage(updated);
    }

    return c.json({ data: updated });
  } catch (err) {
    console.error("[persona] PATCH failed:", err);
    return c.json({ error: "Internal server error" }, 500);
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
