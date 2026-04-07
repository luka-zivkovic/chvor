export type CommunicationStyle = "concise" | "balanced" | "detailed";

export const VALID_COMMUNICATION_STYLES: readonly CommunicationStyle[] = [
  "concise",
  "balanced",
  "detailed",
] as const;

export const VALID_PRESET_IDS = [
  "companion",
  "warden",
  "steward",
  "copilot",
  "operator",
  "oracle",
] as const;

export type PersonalityPresetId = (typeof VALID_PRESET_IDS)[number];

/** Max lengths for persona text fields. */
export const PERSONA_LIMITS = {
  profile: 4000,
  directives: 2000,
  tone: 200,
  boundaries: 2000,
  name: 100,
  aiName: 50,
  userNickname: 50,
  language: 50,
  timezone: 100,
  exampleText: 500,
  maxExamples: 5,
} as const;

export interface ExampleResponse {
  user: string;
  assistant: string;
}

export interface PersonaConfig {
  profile: string;
  directives: string;
  onboarded: boolean;
  name?: string;
  timezone?: string;
  language?: string;
  aiName?: string;
  userNickname?: string;
  tone?: string;
  boundaries?: string;
  communicationStyle?: CommunicationStyle;
  exampleResponses?: ExampleResponse[];
  emotionsEnabled?: boolean;
  advancedEmotionsEnabled?: boolean;
  personalityPresetId?: string;
}

export type UpdatePersonaRequest = Partial<PersonaConfig>;
