import { randomUUID } from "node:crypto";
import * as sdk from "matrix-js-sdk";
import { RoomEvent, MsgType } from "matrix-js-sdk";
import type { NormalizedMessage } from "@chvor/shared";
import type {
  ChannelAdapter,
  MessageHandler,
  SendResponseOptions,
} from "./channel.ts";
import {
  listCredentials,
  getCredentialData,
} from "../db/credential-store.ts";

interface MatrixCredentials {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
}

export class MatrixChannel implements ChannelAdapter {
  name = "matrix" as const;
  private handler: MessageHandler | null = null;
  private client: sdk.MatrixClient | null = null;
  private running = false;

  async start(): Promise<void> {
    const creds = this.loadCredentials();
    if (!creds) {
      console.log("[matrix] no credentials found, skipping start");
      return;
    }

    this.client = sdk.createClient({
      baseUrl: creds.homeserverUrl,
      accessToken: creds.accessToken,
      userId: creds.userId,
    });

    this.client.on(RoomEvent.Timeline, (event, room) => {
      if (!this.handler) return;
      if (event.getType() !== "m.room.message") return;

      const sender = event.getSender();
      // Ignore our own messages
      if (sender === creds.userId) return;

      const content = event.getContent();
      if (content.msgtype !== "m.text") return;

      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "matrix",
        channelId: room?.roomId || event.getRoomId() || "",
        senderId: sender || "",
        senderName: sender || "Unknown",
        text: content.body || "",
        timestamp: new Date(event.getTs()).toISOString(),
        threadId: undefined,
        chatType: "dm",
      };

      this.handler(normalized);
    });

    await this.client.startClient({ initialSyncLimit: 0 });
    this.running = true;
    console.log("[matrix] client started");
  }

  async stop(): Promise<void> {
    if (this.client && this.running) {
      this.client.stopClient();
      console.log("[matrix] client stopped");
    }
    this.client = null;
    this.running = false;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async sendResponse(
    channelId: string,
    text: string,
    _threadId?: string,
    _options?: SendResponseOptions
  ): Promise<void> {
    if (!this.client) {
      console.error("[matrix] cannot send response — client not initialized");
      return;
    }

    try {
      await this.client.sendMessage(channelId, {
        msgtype: MsgType.Text,
        body: text,
      });
    } catch (err) {
      console.error("[matrix] sendResponse failed:", err);
    }
  }

  private loadCredentials(): MatrixCredentials | null {
    const creds = listCredentials();
    const match = creds.find((c) => c.type === "matrix");
    if (!match) return null;
    const full = getCredentialData(match.id);
    if (!full) return null;
    const data = full.data as Record<string, string>;
    if (!data.homeserverUrl || !data.accessToken || !data.userId) return null;
    return {
      homeserverUrl: data.homeserverUrl,
      accessToken: data.accessToken,
      userId: data.userId,
    };
  }
}
