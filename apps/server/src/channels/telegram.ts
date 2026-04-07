import { randomUUID } from "node:crypto";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { NormalizedMessage } from "@chvor/shared";
import type { ChannelAdapter, MessageHandler, SendResponseOptions } from "./channel.ts";
import {
  listCredentials,
  getCredentialData,
} from "../db/credential-store.ts";
import { resolveApproval } from "../lib/native-tools.ts";
import { storeMediaFromBuffer, MAX_ARTIFACT_BYTES } from "../lib/media-store.ts";
import { splitText } from "./text-utils.ts";
import { getChannelPolicy } from "../db/config-store.ts";

export class TelegramChannel implements ChannelAdapter {
  name = "telegram" as const;
  private handler: MessageHandler | null = null;
  private bot: Bot | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private cachedBotToken: string | null = null;

  /** Download a file from Telegram by file_path. Keeps the bot token out of logged URLs. */
  private async downloadFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${this.cachedBotToken}/${filePath}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async start(): Promise<void> {
    const token = this.loadBotToken();
    if (!token) {
      console.log(
        "[telegram] no bot token found in credentials, skipping start"
      );
      return;
    }

    this.cachedBotToken = token;
    this.bot = new Bot(token);

    this.bot.on("message:text", (ctx) => {
      if (!this.handler) return;

      const msg = ctx.message;
      if (!msg.from) return; // ignore anonymous/channel messages

      const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
      const chatType = msg.message_thread_id ? "thread" : isGroup ? "group" : "dm";

      // Access control — check policy before processing
      if (this.shouldFilter(chatType as "dm" | "group" | "thread", String(msg.from.id))) return;

      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "telegram",
        channelId: String(msg.chat.id),
        senderId: String(msg.from.id),
        senderName:
          msg.from.first_name +
          (msg.from.last_name ? ` ${msg.from.last_name}` : ""),
        text: msg.text,
        timestamp: new Date(msg.date * 1000).toISOString(),
        threadId: msg.message_thread_id
          ? String(msg.message_thread_id)
          : undefined,
        chatType,
      };

      this.handler(normalized);
    });

    this.bot.on("message:voice", async (ctx) => {
      if (!this.handler) return;
      const msg = ctx.message;
      if (!msg.from || msg.from.is_bot) return;

      const isVoiceGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
      const voiceChatType = msg.message_thread_id ? "thread" : isVoiceGroup ? "group" : "dm";

      // Access control — same policy check as text messages
      if (this.shouldFilter(voiceChatType as "dm" | "group" | "thread", String(msg.from.id))) return;

      try {
        // Download voice file from Telegram
        const file = await ctx.getFile();
        // Reject oversized voice files before downloading
        if (file.file_size && file.file_size > MAX_ARTIFACT_BYTES) {
          console.warn(`[telegram] skipping oversized voice file: ${file.file_size} bytes`);
          await ctx.reply("Voice message is too large to process.");
          return;
        }
        const audioData = new Uint8Array(await this.downloadFile(file.file_path!));
        const normalized: NormalizedMessage = {
          id: randomUUID(),
          channelType: "telegram",
          channelId: String(msg.chat.id),
          senderId: String(msg.from.id),
          senderName: msg.from.first_name + (msg.from.last_name ? ` ${msg.from.last_name}` : ""),
          text: "", // Will be filled by voice middleware preProcess
          timestamp: new Date(msg.date * 1000).toISOString(),
          threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
          chatType: voiceChatType,
          audioData,
          inputModality: "voice",
        };

        this.handler(normalized);
      } catch (err) {
        console.error("[telegram] voice message error:", err);
        await ctx.reply("Sorry, I couldn't process that voice message.");
      }
    });

    // Handle photo messages
    this.bot.on("message:photo", async (ctx) => {
      if (!this.handler) return;
      const msg = ctx.message;
      if (!msg.from || msg.from.is_bot) return;

      try {
        // Telegram provides multiple sizes; pick the largest
        const photo = msg.photo[msg.photo.length - 1];
        const file = await ctx.api.getFile(photo.file_id);
        // Reject oversized files before downloading
        if (file.file_size && file.file_size > MAX_ARTIFACT_BYTES) {
          console.warn(`[telegram] skipping oversized photo: ${file.file_size} bytes`);
          return;
        }
        const buffer = await this.downloadFile(file.file_path!);
        const artifact = storeMediaFromBuffer(buffer, "image/jpeg");

        const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
        const normalized: NormalizedMessage = {
          id: randomUUID(),
          channelType: "telegram",
          channelId: String(msg.chat.id),
          senderId: String(msg.from.id),
          senderName: msg.from.first_name + (msg.from.last_name ? ` ${msg.from.last_name}` : ""),
          text: msg.caption ?? "",
          timestamp: new Date(msg.date * 1000).toISOString(),
          threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
          chatType: msg.message_thread_id ? "thread" : isGroup ? "group" : "dm",
          media: [artifact],
        };

        this.handler(normalized);
      } catch (err) {
        console.error("[telegram] photo download failed:", err);
      }
    });

    // Handle document messages (PDF, DOCX, TXT, etc.)
    this.bot.on("message:document", async (ctx) => {
      if (!this.handler) return;
      const msg = ctx.message;
      if (!msg.from || msg.from.is_bot) return;
      const doc = msg.document;
      if (!doc) return;

      try {
        const file = await ctx.api.getFile(doc.file_id);
        // Reject oversized files before downloading
        if (file.file_size && file.file_size > MAX_ARTIFACT_BYTES) {
          console.warn(`[telegram] skipping oversized document: ${file.file_size} bytes`);
          return;
        }
        const buffer = await this.downloadFile(file.file_path!);
        const mimeType = doc.mime_type ?? "application/octet-stream";
        const artifact = storeMediaFromBuffer(buffer, mimeType, doc.file_name ?? undefined);

        const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
        const normalized: NormalizedMessage = {
          id: randomUUID(),
          channelType: "telegram",
          channelId: String(msg.chat.id),
          senderId: String(msg.from.id),
          senderName: msg.from.first_name + (msg.from.last_name ? ` ${msg.from.last_name}` : ""),
          text: msg.caption ?? "",
          timestamp: new Date(msg.date * 1000).toISOString(),
          threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
          chatType: msg.message_thread_id ? "thread" : isGroup ? "group" : "dm",
          media: [artifact],
        };

        this.handler(normalized);
      } catch (err) {
        console.error("[telegram] document download failed:", err);
      }
    });

    // Handle inline keyboard button clicks for shell command approval
    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const match = data.match(/^(approve|deny):(.+)$/);
      if (!match) {
        await ctx.answerCallbackQuery();
        return;
      }

      const [, action, requestId] = match;
      const approved = action === "approve";
      const resolved = resolveApproval(requestId, approved);

      if (resolved) {
        await ctx.answerCallbackQuery({ text: approved ? "Command approved" : "Command denied" });
        // Replace buttons with result text
        try {
          const original = ctx.callbackQuery.message;
          if (original && "text" in original) {
            const status = approved ? "\u2705 Approved" : "\u274c Denied";
            await ctx.editMessageText(`${original.text}\n\n${status}`, { parse_mode: "HTML" });
          }
        } catch (e) { console.debug("[telegram] edit approval message failed:", e); }
      } else {
        await ctx.answerCallbackQuery({ text: "Approval expired or already handled" });
      }
    });

    this.bot.catch((err) => {
      console.error("[telegram] bot error:", err.message);
      if (!this.running) this.scheduleReconnect();
    });

    // bot.start() resolves only when polling stops — do NOT await
    this.bot.start({
      onStart: () => {
        this.running = true;
        this.reconnectAttempts = 0;
        console.log("[telegram] polling started");
      },
    }).catch((err) => {
      console.error("[telegram] polling crashed:", (err as Error).message);
      this.running = false;
      this.bot = null;
      this.scheduleReconnect();
    });
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.bot && this.running) {
      await this.bot.stop();
      console.log("[telegram] polling stopped");
    }
    this.bot = null;
    this.running = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(3000 * 2 ** this.reconnectAttempts, 60_000);
    this.reconnectAttempts++;
    console.log(`[telegram] reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.start();
      } catch (err) {
        console.error("[telegram] reconnect failed:", (err as Error).message);
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
    if (!this.bot) {
      console.error("[telegram] cannot send response — bot not initialized");
      return;
    }

    const opts = { message_thread_id: threadId ? Number(threadId) : undefined };
    const audio = options?.audio;

    if (audio && audio.data.length > 0 && audio.format === "ogg") {
      try {
        const inputFile = new InputFile(Buffer.from(audio.data), "voice.ogg");
        await this.bot.api.sendVoice(Number(channelId), inputFile, opts);
        return;
      } catch (err) {
        console.warn("[telegram] sendVoice failed, falling back to text:", err);
      }
    }

    // Fallback: send as text
    const MAX_LEN = 4096;
    const chunks = splitText(text, MAX_LEN);

    for (const chunk of chunks) {
      await this.bot.api.sendMessage(Number(channelId), chunk, opts);
    }
  }

  async sendApproval(
    channelId: string,
    requestId: string,
    command: string,
    tier: string,
    threadId?: string
  ): Promise<void> {
    if (!this.bot) return;

    const tierEmoji = tier === "dangerous" ? "\u{1f534}" : "\u{1f7e1}";
    const text =
      `${tierEmoji} <b>Command requires approval</b>\n` +
      `<code>${escapeHtml(command)}</code>\n` +
      `Risk: <b>${tier.toUpperCase()}</b>`;

    const keyboard = new InlineKeyboard()
      .text("\u2705 Approve", `approve:${requestId}`)
      .text("\u274c Deny", `deny:${requestId}`);

    await this.bot.api.sendMessage(Number(channelId), text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      message_thread_id: threadId ? Number(threadId) : undefined,
    });
  }

  private shouldFilter(chatType: "dm" | "group" | "thread", senderId: string): boolean {
    const policy = getChannelPolicy("telegram");
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
    const match = creds.find((c) => c.type === "telegram");
    if (!match) return null;
    const full = getCredentialData(match.id);
    if (!full) return null;
    return (full.data as Record<string, string>).botToken || null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

