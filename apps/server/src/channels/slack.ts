import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App, LogLevel } from "@slack/bolt";
import type { NormalizedMessage } from "@chvor/shared";
import type { ChannelAdapter, MessageHandler, SendResponseOptions } from "./channel.ts";
import {
  listCredentials,
  getCredentialData,
} from "../db/credential-store.ts";
import { storeMediaFromBuffer, MAX_ARTIFACT_BYTES, getMediaDir } from "../lib/media-store.ts";
import { splitText } from "./text-utils.ts";
import { getChannelPolicy } from "../db/config-store.ts";

export class SlackChannel implements ChannelAdapter {
  name = "slack" as const;
  private handler: MessageHandler | null = null;
  private app: App | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private cachedTokens: { botToken: string; appToken: string } | null = null;

  async start(): Promise<void> {
    if (this.app || this.running) return; // idempotency guard

    const tokens = this.loadTokens();
    if (!tokens) {
      console.log("[slack] no credentials found, skipping start");
      return;
    }

    this.cachedTokens = tokens;

    this.app = new App({
      token: tokens.botToken,
      appToken: tokens.appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.app.message(async ({ message, client }) => {
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
      const chatType = hasThread ? "thread" : message.channel.startsWith("D") ? "dm" : "group";

      // Access control — check policy before processing
      if (this.shouldFilter(chatType as "dm" | "group" | "thread", message.user)) return;

      // Resolve display name for sender (best-effort, fall back to user ID)
      let senderName = message.user;
      try {
        const userInfo = await client.users.info({ user: message.user });
        if (userInfo.user) {
          senderName = userInfo.user.profile?.display_name || userInfo.user.real_name || userInfo.user.name || message.user;
        }
      } catch {
        // Fall back to user ID
      }

      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "slack",
        channelId: message.channel,
        senderId: message.user,
        senderName,
        text,
        timestamp: new Date(parseFloat(message.ts) * 1000).toISOString(),
        threadId: hasThread ? (message.thread_ts ?? undefined) : undefined,
        chatType,
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

    try {
      await this.app.start();
      this.running = true;
      this.reconnectAttempts = 0;
      console.log("[slack] socket mode connected");
    } catch (err) {
      console.error("[slack] start failed:", (err as Error).message);
      this.app = null;
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.app && this.running) {
      await this.app.stop();
      console.log("[slack] disconnected");
    }
    this.app = null;
    this.running = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(3000 * 2 ** this.reconnectAttempts, 60_000);
    this.reconnectAttempts++;
    console.log(`[slack] reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.start();
      } catch (err) {
        console.error("[slack] reconnect failed:", (err as Error).message);
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
    if (!this.app) {
      console.error("[slack] cannot send response — app not initialized");
      return;
    }

    try {
      // Upload media files if provided
      if (options?.media && options.media.length > 0) {
        for (const artifact of options.media) {
          try {
            const filename = artifact.url.split("/").pop();
            if (filename) {
              const filePath = join(getMediaDir(), filename);
              const buffer = readFileSync(filePath);
              await this.app.client.files.uploadV2({
                channel_id: channelId,
                file: buffer,
                filename: artifact.filename ?? filename,
                ...(threadId ? { thread_ts: threadId } : {}),
              } as never);
            }
          } catch (err) {
            console.warn("[slack] media upload failed:", err);
          }
        }
      }

      // Upload audio if provided
      if (options?.audio && options.audio.data.length > 0) {
        try {
          const ext = options.audio.format === "ogg" ? "ogg" : options.audio.format;
          await this.app.client.files.uploadV2({
            channel_id: channelId,
            file: Buffer.from(options.audio.data),
            filename: `voice.${ext}`,
            ...(threadId ? { thread_ts: threadId } : {}),
          } as never);
          return; // Audio sent successfully — don't duplicate with text
        } catch (err) {
          console.warn("[slack] audio upload failed:", err);
        }
      }

      // Send text response
      const MAX_LEN = 4000;
      const chunks = splitText(text, MAX_LEN);

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

  private shouldFilter(chatType: "dm" | "group" | "thread", senderId: string): boolean {
    const policy = getChannelPolicy("slack");
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
