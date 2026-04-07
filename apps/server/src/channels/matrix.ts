import { randomUUID } from "node:crypto";
import * as sdk from "matrix-js-sdk";
import { RoomEvent, MsgType, ClientEvent } from "matrix-js-sdk";
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
import { splitText } from "./text-utils.ts";
import { getChannelPolicy } from "../db/config-store.ts";

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
  private userId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  async start(): Promise<void> {
    if (this.client || this.running) return; // idempotency guard

    const creds = this.loadCredentials();
    if (!creds) {
      console.log("[matrix] no credentials found, skipping start");
      return;
    }

    this.userId = creds.userId;

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

      // Determine chat type based on room membership
      const roomId = room?.roomId || event.getRoomId() || "";
      let chatType: "dm" | "group" = "dm";
      if (room) {
        const members = room.getJoinedMemberCount();
        if (members > 2) chatType = "group";
      }

      // Access control — check policy before processing
      if (this.shouldFilter(chatType, sender || "")) return;

      // Handle text messages (skip m.notice to avoid bot loops)
      if (content.msgtype === MsgType.Text) {
        const normalized: NormalizedMessage = {
          id: randomUUID(),
          channelType: "matrix",
          channelId: roomId,
          senderId: sender || "",
          senderName: sender || "Unknown",
          text: content.body || "",
          timestamp: new Date(event.getTs()).toISOString(),
          threadId: undefined,
          chatType,
        };

        this.handler(normalized);
        return;
      }

      // Handle image/video/audio/file — log and pass with caption text
      if (content.msgtype === MsgType.Image || content.msgtype === MsgType.Video ||
          content.msgtype === MsgType.Audio || content.msgtype === MsgType.File) {
        console.log(`[matrix] received ${content.msgtype} message from ${sender} (media download not yet supported)`);
        const normalized: NormalizedMessage = {
          id: randomUUID(),
          channelType: "matrix",
          channelId: roomId,
          senderId: sender || "",
          senderName: sender || "Unknown",
          text: content.body || `[${content.msgtype} attachment]`,
          timestamp: new Date(event.getTs()).toISOString(),
          threadId: undefined,
          chatType,
        };

        this.handler(normalized);
      }
    });

    // Handle sync errors and reconnect
    this.client.on(ClientEvent.Sync, (state: string) => {
      if (state === "ERROR" || state === "STOPPED") {
        console.warn(`[matrix] sync state: ${state}, scheduling reconnect`);
        this.running = false;
        try { this.client?.stopClient(); } catch { /* ignore */ }
        this.client = null;
        this.scheduleReconnect();
      }
    });

    await this.client.startClient({ initialSyncLimit: 0 });
    this.running = true;
    this.reconnectAttempts = 0;
    console.log("[matrix] client started");
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.client && this.running) {
      this.client.stopClient();
      console.log("[matrix] client stopped");
    }
    this.client = null;
    this.running = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(3000 * 2 ** this.reconnectAttempts, 60_000);
    this.reconnectAttempts++;
    console.log(`[matrix] reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.start();
      } catch (err) {
        console.error("[matrix] reconnect failed:", (err as Error).message);
        this.scheduleReconnect();
      }
    }, delay);
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
      // Matrix has a ~65KB event size limit; chunk long messages
      const MAX_LEN = 32_000;
      const chunks = splitText(text, MAX_LEN);

      for (const chunk of chunks) {
        await this.client.sendMessage(channelId, {
          msgtype: MsgType.Text,
          body: chunk,
        });
      }
    } catch (err) {
      console.error("[matrix] sendResponse failed:", err);
    }
  }

  private shouldFilter(chatType: "dm" | "group", senderId: string): boolean {
    const policy = getChannelPolicy("matrix");

    if (chatType === "group") {
      if (policy.group.mode === "disabled") return true;
      if (policy.group.mode === "allowlist" && !policy.group.allowlist.includes(senderId)) return true;
      if (policy.groupSenderFilter.enabled && !policy.groupSenderFilter.allowlist.includes(senderId)) return true;
    } else {
      if (policy.dm.mode === "disabled") return true;
      if (policy.dm.mode === "allowlist" && !policy.dm.allowlist.includes(senderId)) return true;
    }

    return false;
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
