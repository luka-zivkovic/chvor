import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  type WASocket,
  type ConnectionState,
  type WAMessageContent,
  type proto,
} from "@whiskeysockets/baileys";
import pino from "pino";
import * as QRCode from "qrcode";
import type { NormalizedMessage, MediaArtifact } from "@chvor/shared";
import type { ChannelAdapter, MessageHandler, SendResponseOptions } from "./channel.ts";
import { getChannelPolicy } from "../db/config-store.ts";
import { storeMediaFromBuffer } from "../lib/media-store.ts";
import { splitText } from "./text-utils.ts";

const DATA_DIR = join(process.cwd(), "data");
const AUTH_DIR = join(DATA_DIR, "whatsapp-auth");

type WhatsAppStatus = "disconnected" | "connecting" | "connected";
type StatusHandler = (status: WhatsAppStatus, phoneNumber?: string) => void;
type QRHandler = (qrDataUrl: string) => void;

export class WhatsAppChannel implements ChannelAdapter {
  name = "whatsapp" as const;
  private handler: MessageHandler | null = null;
  private sock: WASocket | null = null;
  private status: WhatsAppStatus = "disconnected";
  private phoneNumber: string | undefined;
  private qrHandler: QRHandler | null = null;
  private statusHandler: StatusHandler | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  async start(): Promise<void> {
    // Only start if auth state exists (user has paired before or is initiating pairing)
    if (!existsSync(AUTH_DIR)) {
      console.log("[whatsapp] no auth state found, waiting for QR pairing via /api/whatsapp/connect");
      return;
    }
    await this.connect();
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.status = "disconnected";
    this.phoneNumber = undefined;
    this.reconnectAttempts = 0;
    console.log("[whatsapp] stopped");
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  onQR(handler: QRHandler): void {
    this.qrHandler = handler;
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  getStatus(): { status: WhatsAppStatus; phoneNumber?: string } {
    return { status: this.status, phoneNumber: this.phoneNumber };
  }

  /** Initiate a new connection (creates auth dir if needed). */
  async connect(): Promise<void> {
    if (this.sock) {
      // Already connected or connecting
      return;
    }

    if (!existsSync(AUTH_DIR)) {
      mkdirSync(AUTH_DIR, { recursive: true });
    }

    this.status = "connecting";
    this.emitStatus("connecting");

    const logger = pino({ level: "silent" });
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Baileys API, not a React hook
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
    });

    this.sock = sock;

    // Save credentials on update
    sock.ev.on("creds.update", saveCreds);

    // Connection state management
    sock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
          console.log("[whatsapp] QR code generated, scan with your phone");
          this.qrHandler?.(qrDataUrl);
        } catch (err) {
          console.error("[whatsapp] QR code generation failed:", err);
        }
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          console.log("[whatsapp] logged out, clearing auth state");
          this.clearAuthState();
          this.sock = null;
          this.status = "disconnected";
          this.phoneNumber = undefined;
          this.emitStatus("disconnected");
        } else {
          const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts), 60000);
          this.reconnectAttempts++;
          console.log(`[whatsapp] connection closed (code: ${statusCode}), reconnecting in ${delay / 1000}s...`);
          this.sock = null;
          this.reconnectTimer = setTimeout(() => this.connect(), delay);
        }
      }

      if (connection === "open") {
        this.status = "connected";
        this.reconnectAttempts = 0;
        // Extract phone number from connection state
        this.phoneNumber = sock.user?.id?.split(":")[0] ?? sock.user?.id;
        console.log(`[whatsapp] connected as ${this.phoneNumber}`);
        this.emitStatus("connected", this.phoneNumber);
      }
    });

    // Message handling
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      if (!this.handler) return;

      for (const msg of messages) {
        try {
          await this.handleIncomingMessage(msg);
        } catch (err) {
          console.error("[whatsapp] message handling error:", err);
        }
      }
    });
  }

  /** Disconnect and clear auth state (unpair). */
  async disconnect(): Promise<void> {
    try {
      if (this.sock) {
        await this.sock.logout();
      }
    } catch (err) {
      console.warn("[whatsapp] logout error (ignored):", err);
    }
    await this.stop();
    this.clearAuthState();
    this.emitStatus("disconnected");
  }

  async sendResponse(
    channelId: string,
    text: string,
    threadId?: string,
    options?: SendResponseOptions
  ): Promise<void> {
    if (!this.sock) {
      console.error("[whatsapp] cannot send response — not connected");
      return;
    }

    const jid = channelId;

    // Send media if provided
    if (options?.media && options.media.length > 0) {
      for (const artifact of options.media) {
        try {
          if (artifact.mediaType === "image") {
            await this.sock.sendMessage(jid, {
              image: { url: artifact.url },
              caption: text,
            });
            return; // Caption included with first image
          }
        } catch (err) {
          console.warn("[whatsapp] media send failed, falling back to text:", err);
        }
      }
    }

    // Send audio if provided
    if (options?.audio && options.audio.data.length > 0) {
      try {
        await this.sock.sendMessage(jid, {
          audio: Buffer.from(options.audio.data),
          mimetype: "audio/ogg; codecs=opus",
          ptt: true,
        });
        return;
      } catch (err) {
        console.warn("[whatsapp] audio send failed, falling back to text:", err);
      }
    }

    // Text message with chunking
    const MAX_LEN = 4096;
    const chunks = splitText(text, MAX_LEN);
    for (const chunk of chunks) {
      await this.sock.sendMessage(jid, { text: chunk });
    }
  }

  private async handleIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
    if (!this.handler || !msg.key) return;

    // Skip messages sent by us
    if (msg.key.fromMe) return;

    // Skip status broadcasts
    if (msg.key.remoteJid === "status@broadcast") return;

    // Skip empty messages
    if (!msg.message) return;

    const text = extractText(msg.message);
    const isVoice = !!msg.message.audioMessage?.ptt;
    const hasImage = !!msg.message.imageMessage;
    const hasVideo = !!msg.message.videoMessage;

    // Skip messages with no text, no voice, and no media
    if (!text && !isVoice && !hasImage && !hasVideo) return;

    const remoteJid = msg.key.remoteJid!;
    const isGroup = remoteJid.endsWith("@g.us");
    const senderId = isGroup
      ? (msg.key.participant ?? remoteJid)
      : remoteJid;
    const senderPhone = senderId.split("@")[0];

    // Access control — check policy before processing
    if (this.shouldFilter(isGroup, remoteJid, senderPhone)) return;

    const normalized: NormalizedMessage = {
      id: randomUUID(),
      channelType: "whatsapp",
      channelId: remoteJid,
      senderId: senderPhone, // Strip @s.whatsapp.net
      senderName: msg.pushName ?? undefined,
      text: text ?? "",
      timestamp: new Date((msg.messageTimestamp as number) * 1000).toISOString(),
      threadId: isGroup ? remoteJid : undefined,
      chatType: isGroup ? "group" : "dm",
      inputModality: isVoice ? "voice" : "text",
    };

    // Handle voice messages — download audio data
    if (isVoice && this.sock) {
      try {
        const buffer = await downloadMediaMessage(msg as Parameters<typeof downloadMediaMessage>[0], "buffer", {}) as Buffer;
        normalized.audioData = new Uint8Array(buffer);
      } catch (err) {
        console.error("[whatsapp] voice download failed:", err);
        return; // Skip if we can't download voice
      }
    }

    // Handle image/video attachments — download and store as media artifacts
    if ((hasImage || hasVideo) && this.sock) {
      try {
        const buffer = await downloadMediaMessage(msg as Parameters<typeof downloadMediaMessage>[0], "buffer", {}) as Buffer;
        const mimeType = hasImage
          ? (msg.message!.imageMessage!.mimetype ?? "image/jpeg")
          : (msg.message!.videoMessage!.mimetype ?? "video/mp4");
        const artifact = storeMediaFromBuffer(buffer, mimeType);
        normalized.media = [artifact];
      } catch (err) {
        console.error(`[whatsapp] ${hasImage ? "image" : "video"} download failed:`, err);
        // Continue without media — text/caption may still be useful
      }
    }

    this.handler(normalized);
  }

  private shouldFilter(isGroup: boolean, remoteJid: string, senderPhone: string): boolean {
    const policy = getChannelPolicy("whatsapp");

    if (isGroup) {
      if (policy.group.mode === "disabled") return true;
      if (policy.group.mode === "allowlist") {
        // Match against both the full JID (123456@g.us) and the numeric prefix
        const groupId = remoteJid.split("@")[0];
        const allowed = policy.group.allowlist.some(
          (entry) => entry === remoteJid || entry === groupId
        );
        if (!allowed) return true;
      }
      if (policy.groupSenderFilter.enabled && !policy.groupSenderFilter.allowlist.includes(senderPhone)) return true;
    } else {
      if (policy.dm.mode === "disabled") return true;
      if (policy.dm.mode === "allowlist" && !policy.dm.allowlist.includes(senderPhone)) return true;
    }

    return false;
  }

  private clearAuthState(): void {
    if (existsSync(AUTH_DIR)) {
      try {
        rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log("[whatsapp] auth state cleared");
      } catch (err) {
        console.error("[whatsapp] failed to clear auth state:", err);
      }
    }
  }

  private emitStatus(status: WhatsAppStatus, phoneNumber?: string): void {
    this.statusHandler?.(status, phoneNumber);
  }
}

/** Extract text content from a WhatsApp message. */
function extractText(content: WAMessageContent): string | undefined {
  // Use proto.Message typed properties — Baileys defines these on WAMessageContent
  const msg = content as proto.IMessage;
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    msg.listResponseMessage?.title ??
    msg.buttonsResponseMessage?.selectedDisplayText ??
    undefined
  );
}

