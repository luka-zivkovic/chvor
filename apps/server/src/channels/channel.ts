import type { ChannelType, NormalizedMessage, MediaArtifact } from "@chvor/shared";

export type MessageHandler = (message: NormalizedMessage) => void;

export type AudioFormat = "mp3" | "opus" | "ogg" | "wav";

export interface AudioAttachment {
  data: Uint8Array;
  format: AudioFormat;
}

export interface SendResponseOptions {
  media?: MediaArtifact[];
  audio?: AudioAttachment;
  messageId?: string;
}

export interface ChannelAdapter {
  name: ChannelType;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  sendResponse(channelId: string, text: string, threadId?: string, options?: SendResponseOptions): Promise<void>;
  /** Send a shell-command approval prompt with inline buttons (optional — falls back to plain text). */
  sendApproval?(channelId: string, requestId: string, command: string, tier: string, threadId?: string): Promise<void>;
}
