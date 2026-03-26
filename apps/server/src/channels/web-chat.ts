import { randomUUID } from "node:crypto";
import type { NormalizedMessage, MediaArtifact } from "@chvor/shared";
import type { ChannelAdapter, MessageHandler, SendResponseOptions } from "./channel.ts";
import type { WSManager } from "../gateway/ws.ts";

export class WebChatChannel implements ChannelAdapter {
  name = "web" as const;
  private handler: MessageHandler | null = null;
  private wsManager: WSManager;

  constructor(wsManager: WSManager) {
    this.wsManager = wsManager;
  }

  async start(): Promise<void> {
    // Web chat is driven by WS connections — no external setup needed
  }

  async stop(): Promise<void> {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Called by the WS handler when a browser client sends a chat message */
  handleClientMessage(clientId: string, text: string, workspaceId: string, sessionId?: string, inputModality?: "voice", media?: MediaArtifact[]): void {
    const message: NormalizedMessage = {
      id: randomUUID(),
      channelType: "web",
      channelId: sessionId ?? clientId,
      senderId: clientId,
      text,
      timestamp: new Date().toISOString(),
      workspaceId,
      originClientId: clientId,
      chatType: "dm",
      inputModality: inputModality ?? "text",
      ...(media?.length ? { media } : {}),
    };
    this.handler?.(message);
  }

  async sendResponse(channelId: string, text: string, _threadId?: string, options?: SendResponseOptions): Promise<void> {
    const event = {
      type: "chat.message" as const,
      data: {
        role: "assistant" as const,
        content: text,
        timestamp: new Date().toISOString(),
        ...(options?.messageId ? { messageId: options.messageId } : {}),
        ...(options?.media?.length ? { media: options.media } : {}),
      },
    };
    // channelId may be a session UUID — send to all WS clients sharing that session
    const clients = this.wsManager.getClientsBySessionId(channelId);
    if (clients.length > 0) {
      for (const clientId of clients) {
        this.wsManager.sendTo(clientId, event);
      }
      return;
    }
    // Fallback: try direct ws-N client ID (legacy)
    if (channelId && this.wsManager.sendTo(channelId, event)) {
      return;
    }
    // No broadcast fallback — if no matching session/client found, the message
    // belongs to a non-web channel and should not leak to web clients.
    console.warn(`[web-chat] no WS client found for channelId: ${channelId}, dropping response`);
  }
}
