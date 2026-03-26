import { randomUUID } from "node:crypto";
import { Client, GatewayIntentBits, Events } from "discord.js";
import type { NormalizedMessage } from "@chvor/shared";
import type { ChannelAdapter, MessageHandler, SendResponseOptions } from "./channel.ts";
import {
  listCredentials,
  getCredentialData,
} from "../db/credential-store.ts";
import { storeMediaFromBuffer, MAX_ARTIFACT_BYTES } from "../lib/media-store.ts";

export class DiscordChannel implements ChannelAdapter {
  name = "discord" as const;
  private handler: MessageHandler | null = null;
  private client: Client | null = null;
  private running = false;

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
      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "discord",
        channelId: String(message.channelId),
        senderId: message.author.id,
        senderName: message.author.displayName ?? message.author.username,
        text: message.content ?? "",
        timestamp: message.createdAt.toISOString(),
        threadId: isThread ? message.channel.id : undefined,
        chatType: isThread ? "thread" : message.channel.isDMBased() ? "dm" : "group",
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

    await this.client.login(token);
    this.running = true;
    console.log("[discord] bot connected");
  }

  async stop(): Promise<void> {
    if (this.client && this.running) {
      await this.client.destroy();
      console.log("[discord] bot disconnected");
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
    threadId?: string,
    _options?: SendResponseOptions
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

      const MAX_LEN = 2000;
      const chunks = splitText(text, MAX_LEN);

      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    } catch (err) {
      console.error("[discord] sendResponse failed:", err);
    }
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

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
