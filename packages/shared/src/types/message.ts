export type ChannelType = "web" | "telegram" | "discord" | "slack" | "whatsapp" | "matrix" | "scheduler" | "pulse" | "webhook";

export interface NormalizedMessage {
  id: string;
  channelType: ChannelType;
  channelId: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: string;
  threadId?: string;
  workspaceId?: string;
  /** Chat context: direct message, group chat, or thread */
  chatType?: "dm" | "group" | "thread";
  /** WS client ID for routing responses back to the originating client */
  originClientId?: string;
  /** Raw audio bytes from voice input (Telegram voice, browser upload) */
  audioData?: Uint8Array;
  /** How the user sent this message */
  inputModality?: "text" | "voice";
  /** Media attachments (images, video) sent by the user */
  media?: MediaArtifact[];
}

export interface MediaArtifact {
  id: string;
  url: string;
  mimeType: string;
  mediaType: "image" | "audio" | "video" | "file";
  filename?: string;
  sizeBytes?: number;
  /** If true, media is internal to AI processing and not shown in the chat UI (e.g. PC control screenshots) */
  internal?: boolean;
}

export interface ToolActionSummary {
  tool: string;
  summary: string;
  timestamp: string;
  media?: MediaArtifact[];
}

export interface ModelUsedInfo {
  providerId: string;
  model: string;
  wasFallback: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  channelType: ChannelType;
  timestamp: string;
  executionId?: string;
  actions?: ToolActionSummary[];
  /** URL to TTS audio file for this message */
  audioUrl?: string;
  media?: MediaArtifact[];
  /** Which model actually generated this response (set when fallback occurred) */
  modelUsed?: ModelUsedInfo;
}

export interface Session {
  id: string;
  channelType: ChannelType;
  channelId: string;
  threadId?: string;
  workspaceId: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}
