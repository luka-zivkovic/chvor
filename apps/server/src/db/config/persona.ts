import type {
  PersonaConfig,
  UpdatePersonaRequest,
  CommunicationStyle,
  ExampleResponse,
} from "@chvor/shared";
import { getDb } from "../database.ts";
import { setConfig } from "./base.ts";

const DEFAULTS: Record<string, string> = {
  "persona.profile":
    "You are a helpful, direct assistant. You prefer concise answers and ask clarifying questions when a request is ambiguous.",
  "persona.directives": "",
  "persona.onboarded": "false",
  "persona.name": "",
  "persona.timezone": "",
  "persona.language": "",
  "persona.aiName": "",
  "persona.userNickname": "",
  "persona.tone": "",
  "persona.boundaries": "",
  "persona.communicationStyle": "",
  "persona.exampleResponses": "[]",
  "persona.emotionsEnabled": "false",
  "persona.advancedEmotionsEnabled": "false",
  "persona.personalityPresetId": "",
};

function parseExampleResponses(raw: string | null): ExampleResponse[] | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length > 0 ? arr : undefined;
  } catch (err) {
    console.error("[config-store] Failed to parse persona.exampleResponses:", err);
    return undefined;
  }
}

export function getPersona(): PersonaConfig {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, value FROM config WHERE key LIKE 'persona.%'")
    .all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const get = (k: string): string => map.get(k) ?? DEFAULTS[k] ?? "";

  return {
    profile: get("persona.profile"),
    directives: get("persona.directives"),
    onboarded: get("persona.onboarded") === "true",
    name: get("persona.name") || undefined,
    timezone: get("persona.timezone") || undefined,
    language: get("persona.language") || undefined,
    aiName: get("persona.aiName") || undefined,
    userNickname: get("persona.userNickname") || undefined,
    tone: get("persona.tone") || undefined,
    boundaries: get("persona.boundaries") || undefined,
    communicationStyle: (get("persona.communicationStyle") as CommunicationStyle) || undefined,
    exampleResponses: parseExampleResponses(get("persona.exampleResponses") || null),
    emotionsEnabled: get("persona.emotionsEnabled") === "true",
    advancedEmotionsEnabled: get("persona.advancedEmotionsEnabled") === "true",
    personalityPresetId: get("persona.personalityPresetId") || undefined,
  };
}

export function updatePersona(updates: UpdatePersonaRequest): PersonaConfig {
  const db = getDb();
  const run = db.transaction(() => {
    if (updates.profile !== undefined) {
      setConfig("persona.profile", updates.profile);
    }
    if (updates.directives !== undefined) {
      setConfig("persona.directives", updates.directives);
    }
    if (updates.onboarded !== undefined) {
      setConfig("persona.onboarded", String(updates.onboarded));
    }
    if (updates.name !== undefined) {
      setConfig("persona.name", updates.name);
    }
    if (updates.timezone !== undefined) {
      setConfig("persona.timezone", updates.timezone);
    }
    if (updates.language !== undefined) {
      setConfig("persona.language", updates.language);
    }
    if (updates.aiName !== undefined) {
      setConfig("persona.aiName", updates.aiName);
    }
    if (updates.userNickname !== undefined) {
      setConfig("persona.userNickname", updates.userNickname);
    }
    if (updates.tone !== undefined) {
      setConfig("persona.tone", updates.tone);
    }
    if (updates.boundaries !== undefined) {
      setConfig("persona.boundaries", updates.boundaries);
    }
    if (updates.communicationStyle !== undefined) {
      setConfig("persona.communicationStyle", updates.communicationStyle);
    }
    if (updates.exampleResponses !== undefined) {
      setConfig("persona.exampleResponses", JSON.stringify(updates.exampleResponses));
    }
    if (updates.emotionsEnabled !== undefined) {
      setConfig("persona.emotionsEnabled", String(updates.emotionsEnabled));
    }
    if (updates.advancedEmotionsEnabled !== undefined) {
      setConfig("persona.advancedEmotionsEnabled", String(updates.advancedEmotionsEnabled));
    }
    if (updates.personalityPresetId !== undefined) {
      setConfig("persona.personalityPresetId", updates.personalityPresetId);
    }
  });
  run();
  return getPersona();
}
