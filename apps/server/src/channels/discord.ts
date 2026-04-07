import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, GatewayIntentBits, Events, AttachmentBuilder } from "discord.js";
import type { NormalizedMessage } from "@chvor/shared";
import type { ChannelAdapter, MessageHandler, SendResponseOptions } from "./channel.ts";
import {
  listCredentials,
  getCredentialData,
} from "../db/credential-store.ts";
import { storeMediaFromBuffer, MAX_ARTIFACT_BYTES, getMediaDir } from "../lib/media-store.ts";
import { splitText } from "./text-utils.ts";
import { getChannelPolicy } from "../db/config-store.ts";

export class DiscordChannel implements ChannelAdapter {
  name = "discord" as const;
  private handler: MessageHandler | null = null;
  private client: Client | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  async start(): Promise<void> {
    const token = this.loadBotToken();
    if (!token) {
      console.log("[discord] no bot token found in credentials, skipping start");
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (!this.handler) return;
      if (message.author.bot) return;

      const hasAttachments = message.attachments.size > 0;
      // Skip messages with no text AND no attachments
      if (!message.content && !hasAttachments) return;

      const isThread = message.channel.isThread();
      const chatType = isThread ? "thread" : message.channel.isDMBased() ? "dm" : "group";

      // Access control — check policy before processing
      if (this.shouldFilter(chatType, message.author.id)) return;

      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "discord",
        channelId: String(message.channelId),
        senderId: message.author.id,
        senderName: message.author.displayName ?? message.author.username,
        text: message.content ?? "",
        timestamp: message.createdAt.toISOString(),
        threadId: isThread ? message.channel.id : undefined,
        chatType,
      };

      // Download attachments and store as media artifacts (cap at 5, 50 MB aggregate)
      if (hasAttachments) {
        const artifacts = [];
        const entries = [...message.attachments.values()].slice(0, 5);
        const MAX_AGGREGATE_BYTES = 50 * 1024 * 1024;
        let totalBytes = 0;
        for (const attachment of entries) {
          try {
            // Reject oversized attachments before downloading
            if (attachment.size && attachment.size > MAX_ARTIFACT_BYTES) {
              console.warn(`[discord] skipping oversized attachment: ${attachment.size} bytes`);
              continue;
            }
            if (attachment.size && totalBytes + attachment.size > MAX_AGGREGATE_BYTES) {
              console.warn(`[discord] aggregate size cap reached, skipping remaining attachments`);
              break;
            }
            const res = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
            if (!res.ok) throw new Error(`Download failed: ${res.status}`);
            const cl = res.headers.get("content-length");
            if (cl && parseInt(cl, 10) > MAX_ARTIFACT_BYTES) {
              console.warn(`[discord] skipping oversized download: ${cl} bytes`);
              continue;
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            totalBytes += buffer.length;
            if (totalBytes > MAX_AGGREGATE_BYTES) {
              console.warn(`[discord] aggregate size cap exceeded after download, discarding`);
              break;
            }
            const mimeType = attachment.contentType ?? "application/octet-stream";
            const artifact = storeMediaFromBuffer(buffer, mimeType, attachment.name ?? undefined);
            artifacts.push(artifact);
          } catch (err) {
            console.error("[discord] attachment download failed:", err);
          }
        }
        if (artifacts.length > 0) {
          normalized.media = artifacts;
        }
      }

      this.handler(normalized);
    });

    this.client.on(Events.Error, (err) => {
      console.error("[discord] client error:", err.message);
    });

    // Reconnect on unexpected disconnect
    this.client.on(Events.ShardDisconnect, (_event, _shardId) => {
      if (this.running) {
        console.warn("[discord] unexpected disconnect, scheduling reconnect");
        this.running = false;
        this.scheduleReconnect();
      }
    });

    this.client.on(Events.ShardReconnecting, () => {
      console.log("[discord] reconnecting...");
    });

    this.client.on(Events.ShardResume, () => {
      console.log("[discord] resumed connection");
      this.reconnectAttempts = 0;
    });

    try {
      await this.client.login(token);
      this.running = true;
      this.reconnectAttempts = 0;
      console.log("[discord] bot connected");
    } catch (err) {
      console.error("[discord] login failed:", (err as Error).message);
      this.client = null;
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.client && this.running) {
      await this.client.destroy();
      console.log("[discord] bot disconnected");
    }
    this.client = null;
    this.running = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(3000 * 2 ** this.reconnectAttempts, 60_000);
    this.reconnectAttempts++;
    console.log(`[discord] reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.start();
      } catch (err) {
        console.error("[discord] reconnect failed:", (err as Error).message);
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
    threadId?: string,
    options?: SendResponseOptions
  ): Promise<void> {
    if (!this.client) {
      console.error("[discord] cannot send response — client not initialized");
      return;
    }

    const targetId = threadId ?? channelId;
    try {
      const channel = await this.client.channels.fetch(targetId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        console.error(`[discord] channel ${targetId} not found or not text-based`);
        return;
      }

      // Send audio as a voice message attachment if provided
      if (options?.audio && options.audio.data.length > 0) {
        try {
          const ext = options.audio.format === "ogg" ? "ogg" : options.audio.format;
          const attachment = new AttachmentBuilder(Buffer.from(options.audio.data), { name: `voice.${ext}` });
          await channel.send({ files: [attachment] });
          return; // Audio sent successfully — don't duplicate with text
        } catch (err) {
          console.warn("[discord] audio send failed, falling back to text:", err);
        }
      }

      // Send media attachments if provided
      if (options?.media && options.media.length > 0) {
        const files: AttachmentBuilder[] = [];
        for (const artifact of options.media) {
          try {
            // Media URLs are local /api/media/... paths — resolve to disk
            const filename = artifact.url.split("/").pop();
            if (filename) {
              const filePath = join(getMediaDir(), filename);
              const buffer = readFileSync(filePath);
              files.push(new AttachmentBuilder(buffer, { name: artifact.filename ?? filename }));
            }
          } catch (err) {
            console.warn("[discord] failed to attach media file:", err);
          }
        }
        if (files.length > 0) {
          // Send first chunk with files attached
          const MAX_LEN = 2000;
          const chunks = splitText(text, MAX_LEN);
          await channel.send({ content: chunks[0] || undefined, files });
          // Send remaining text chunks
          for (let i = 1; i < chunks.length; i++) {
            await channel.send(chunks[i]);
          }
          return;
        }
      }

      // Text-only fallback
      const MAX_LEN = 2000;
      const chunks = splitText(text, MAX_LEN);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    } catch (err) {
      console.error("[discord] sendResponse failed:", err);
    }
  }

  private shouldFilter(chatType: "dm" | "group" | "thread", senderId: string): boolean {
    const policy = getChannelPolicy("discord");
    const isGroup = chatType === "group" || chatType === "thread";

    if (isGroup) {
      if (policy.group.mode === "disabled") return true;
      if (policy.group.mode === "allowlist" && !policy.group.allowlist.includes(senderId)) return true;
      if (policy.groupSenderFilter.enabled && !policy.groupSenderFilter.allowlist.includes(senderId)) return true;
    } else {
      if (policy.dm.mode === "disabled") return true;
      if (policy.dm.mode === "allowlist" && !policy.dm.allowlist.includes(senderId)) return true;
    }

    return false;
  }

  private loadBotToken(): string | null {
    const creds = listCredentials();
    const match = creds.find((c) => c.type === "discord");
    if (!match) return null;
    const full = getCredentialData(match.id);
    if (!full) return null;
    return (full.data as Record<string, string>).botToken || null;
  }
}

