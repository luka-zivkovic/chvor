import { randomUUID } from "node:crypto";
import { App, LogLevel } from "@slack/bolt";
import type { NormalizedMessage } from "@chvor/shared";
import type { ChannelAdapter, MessageHandler, SendResponseOptions } from "./channel.ts";
import {
  listCredentials,
  getCredentialData,
} from "../db/credential-store.ts";
import { storeMediaFromBuffer, MAX_ARTIFACT_BYTES } from "../lib/media-store.ts";

export class SlackChannel implements ChannelAdapter {
  name = "slack" as const;
  private handler: MessageHandler | null = null;
  private app: App | null = null;
  private running = false;

  async start(): Promise<void> {
    const tokens = this.loadTokens();
    if (!tokens) {
      console.log("[slack] no credentials found, skipping start");
      return;
    }

    this.app = new App({
      token: tokens.botToken,
      appToken: tokens.appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.app.message(async ({ message }) => {
      if (!this.handler) return;
      // Ignore bot messages and subtypes (edits, joins, etc.) — but allow file_share
      const subtype = "subtype" in message ? message.subtype : undefined;
      if (subtype && subtype !== "file_share") return;
      if (!("user" in message) || !message.user) return;

      const text = ("text" in message ? message.text : undefined) ?? "";
      const files = "files" in message ? (message.files as Array<{ url_private_download?: string; mimetype?: string; name?: string }>) : undefined;

      // Skip messages with neither text nor files
      if (!text && (!files || files.length === 0)) return;

      const hasThread = "thread_ts" in message && !!message.thread_ts;
      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "slack",
        channelId: message.channel,
        senderId: message.user,
        senderName: message.user,
        text,
        timestamp: new Date(parseFloat(message.ts) * 1000).toISOString(),
        threadId: hasThread ? (message.thread_ts ?? undefined) : undefined,
        chatType: hasThread ? "thread" : message.channel.startsWith("D") ? "dm" : "group",
      };

      // Download file attachments and store as media artifacts (cap at 5, 50 MB aggregate)
      if (files && files.length > 0 && tokens) {
        const artifacts = [];
        const MAX_AGGREGATE_BYTES = 50 * 1024 * 1024;
        let totalBytes = 0;
        for (const file of files.slice(0, 5)) {
          if (!file.url_private_download) continue;
          try {
            const res = await fetch(file.url_private_download, {
              headers: { Authorization: `Bearer ${tokens.botToken}` },
              signal: AbortSignal.timeout(30_000),
            });
            if (!res.ok) throw new Error(`Download failed: ${res.status}`);
            const cl = res.headers.get("content-length");
            if (cl && parseInt(cl, 10) > MAX_ARTIFACT_BYTES) {
              console.warn(`[slack] skipping oversized download: ${cl} bytes`);
              continue;
            }
            if (cl && totalBytes + parseInt(cl, 10) > MAX_AGGREGATE_BYTES) {
              console.warn(`[slack] aggregate size cap reached, skipping remaining files`);
              break;
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            totalBytes += buffer.length;
            if (totalBytes > MAX_AGGREGATE_BYTES) {
              console.warn(`[slack] aggregate size cap exceeded after download, discarding`);
              break;
            }
            const mimeType = file.mimetype ?? "application/octet-stream";
            const artifact = storeMediaFromBuffer(buffer, mimeType, file.name ?? undefined);
            artifacts.push(artifact);
          } catch (err) {
            console.error("[slack] file download failed:", err);
          }
        }
        if (artifacts.length > 0) {
          normalized.media = artifacts;
        }
      }

      this.handler(normalized);
    });

    await this.app.start();
    this.running = true;
    console.log("[slack] socket mode connected");
  }

  async stop(): Promise<void> {
    if (this.app && this.running) {
      await this.app.stop();
      console.log("[slack] disconnected");
    }
    this.app = null;
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
    if (!this.app) {
      console.error("[slack] cannot send response — app not initialized");
      return;
    }

    const MAX_LEN = 4000;
    const chunks = splitText(text, MAX_LEN);

    try {
      for (const chunk of chunks) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: chunk,
          thread_ts: threadId,
        });
      }
    } catch (err) {
      console.error("[slack] sendResponse failed:", err);
    }
  }

  private loadTokens(): { botToken: string; appToken: string } | null {
    const creds = listCredentials();
    const match = creds.find((c) => c.type === "slack");
    if (!match) return null;
    const full = getCredentialData(match.id);
    if (!full) return null;
    const data = full.data as Record<string, string>;
    if (!data.botToken || !data.appToken) return null;
    return { botToken: data.botToken, appToken: data.appToken };
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
