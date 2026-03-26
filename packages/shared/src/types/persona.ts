export type CommunicationStyle = "concise" | "balanced" | "detailed";

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

export interface UpdatePersonaRequest {
  profile?: string;
  directives?: string;
  onboarded?: boolean;
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
