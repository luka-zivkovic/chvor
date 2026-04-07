import { EventEmitter } from "node:events";
import type { NormalizedMessage, GatewayServerEvent, ToolActionSummary, MediaArtifact } from "@chvor/shared";
import type { ChannelAdapter } from "../channels/channel.ts";
import { preProcess, postProcess, getTtsMode, willTtsBeActive } from "../lib/voice/voice-middleware.ts";
import type { TtsMode } from "../lib/voice/voice-middleware.ts";
import { SessionManager } from "./session.ts";
import { executeConversation } from "../lib/orchestrator.ts";
import type { ModelUsedResult } from "../lib/orchestrator.ts";
import { logError } from "../lib/error-logger.ts";
import { extractAndStoreMemories } from "../lib/memory-extractor.ts";
import { shouldSummarize, triggerSummarization } from "../lib/summarizer.ts";
import { getSessionSummary, getSessionMessageCount, getSessionTitle, updateSessionTitle } from "../db/session-store.ts";
import { setGatewayInstance } from "./gateway-instance.ts";
import { generateSessionTitle } from "../lib/title-generator.ts";
import { getWSInstance } from "./ws-instance.ts";
import { listCredentials } from "../db/credential-store.ts";
import { redactSensitiveData, stripToolAnnotations } from "../lib/sensitive-filter.ts";
import { getSessionLifecycleConfig, resolveResetPolicy, getChannelPolicy } from "../db/config-store.ts";
import { resetSession } from "../lib/session-reset.ts";

export class Gateway extends EventEmitter {
  private channels = new Map<string, ChannelAdapter>();
  private sessions = new SessionManager();
  private sessionLocks = new Map<string, Promise<void>>();
  private sessionAbortControllers = new Map<string, AbortController>();

  constructor() {
    super();
    setGatewayInstance(this);
  }

  private sessionKeyFor(msg: Pick<NormalizedMessage, "channelType" | "channelId" | "threadId">): string {
    return `${msg.channelType}:${msg.channelId}:${msg.threadId ?? "default"}`;
  }

  abortSession(sessionKey: string): boolean {
    const ctrl = this.sessionAbortControllers.get(sessionKey);
    if (ctrl) {
      ctrl.abort();
      return true;
    }
    return false;
  }

  getChannel(name: string): ChannelAdapter | undefined {
    return this.channels.get(name);
  }

  registerChannel(channel: ChannelAdapter): void {
    this.channels.set(channel.name, channel);
    channel.onMessage((msg) => this.handleMessage(msg));
    console.log(`[gateway] registered channel: ${channel.name}`);
  }

  private async handleMessage(message: NormalizedMessage): Promise<void> {
    const sessionKey = this.sessionKeyFor(message);
    const previous = this.sessionLocks.get(sessionKey) ?? Promise.resolve();
    const current = previous.then(() => this.processMessage(message)).catch((err) => {
      console.error("[gateway] processMessage error:", err);
    });
    this.sessionLocks.set(sessionKey, current);
    // Clean up resolved lock to prevent unbounded growth
    current.then(() => {
      if (this.sessionLocks.get(sessionKey) === current) {
        this.sessionLocks.delete(sessionKey);
      }
    });
  }

  private async processMessage(rawMessage: NormalizedMessage): Promise<void> {
    const safePreview = redactSensitiveData(rawMessage.text).slice(0, 80);
    console.log(`[gateway] message from ${rawMessage.channelType}/${rawMessage.senderId}: ${safePreview}`);

    const targetClient = rawMessage.originClientId;

    let session = this.sessions.getOrCreate(
      rawMessage.channelType,
      rawMessage.channelId,
      rawMessage.threadId
    );

    // ── Voice STT pre-processing ──
    if (rawMessage.audioData && targetClient) {
      this.emitEvent({ type: "voice.status", data: { state: "transcribing" } }, targetClient);
    }
    let message: NormalizedMessage;
    try {
      message = await preProcess(rawMessage);
    } catch (err) {
      const channel = this.channels.get(rawMessage.channelType);
      if (channel) {
        await channel.sendResponse(
          rawMessage.channelId,
          "Sorry, I couldn't process that voice message. Please try again or send text instead.",
          rawMessage.threadId
        );
      }
      return;
    }

    // ── Session lifecycle: reset triggers ──
    const lifecycle = getSessionLifecycleConfig();
    if (lifecycle.resetTriggers.length > 0 && lifecycle.resetTriggers.includes(message.text.trim())) {
      await resetSession(session.id, "user-command");
      this.sessions.evict(session.id);
      const channel = this.channels.get(message.channelType);
      if (channel) {
        await channel.sendResponse(message.channelId, "Session reset. Starting fresh.", message.threadId);
      }
      return;
    }

    // ── Session lifecycle: idle timeout auto-reset ──
    const policy = resolveResetPolicy(message.chatType);
    if (policy.idleTimeoutMinutes > 0 && session.messages.length > 0) {
      const idleMs = Date.now() - new Date(session.updatedAt).getTime();
      if (idleMs > policy.idleTimeoutMinutes * 60_000) {
        await resetSession(session.id, `idle-timeout (${policy.idleTimeoutMinutes}min)`);
        this.sessions.evict(session.id);
        session = this.sessions.getOrCreate(
          rawMessage.channelType,
          rawMessage.channelId,
          rawMessage.threadId
        );
      }
    }

    // Store user message
    session.messages.push({
      id: message.id,
      role: "user",
      content: message.text,
      channelType: message.channelType,
      timestamp: message.timestamp,
      ...(message.media?.length ? { media: message.media } : {}),
    });
    session.updatedAt = new Date().toISOString();
    this.sessions.persist(session);

    // Emit execution started (canvas animation — broadcast to all)
    const sourceChannel = message.channelType;
    this.emitEvent({
      type: "execution.event",
      data: { type: "execution.started", data: { executionId: message.id } },
      sourceChannel,
    });

    // Light up the channel's integration node on the canvas
    let channelCredId: string | null = null;
    if (message.channelType !== "web") {
      const cred = listCredentials().find((c) => c.type === message.channelType);
      if (cred) {
        channelCredId = cred.id;
        this.emitEvent({
          type: "execution.event",
          data: { type: "skill.invoked", data: { nodeId: `channel-${cred.id}`, skillId: cred.id } },
          sourceChannel,
        });
      }
    }

    // Detect workspace mode and route accordingly
    const emitExec = (event: import("@chvor/shared").ExecutionEvent) => {
      this.emitEvent({ type: "execution.event", data: event, sourceChannel });
    };

    // ── Abort controller for stop-generation support ──
    const sessionKey = this.sessionKeyFor(message);
    this.sessionAbortControllers.get(sessionKey)?.abort(); // defensive: cancel stale controller
    const abortController = new AbortController();
    this.sessionAbortControllers.set(sessionKey, abortController);

    let responseText: string;
    let actions: ToolActionSummary[] = [];
    let allMedia: MediaArtifact[] = [];
    let totalMessages = 0;
    let fittedMessages = 0;
    let sessionSummary: string | null = null;
    let messagesAtExecution: typeof session.messages = [];
    let executionSucceeded = false;
    let aborted = false;
    let modelUsed: ModelUsedResult | undefined;
    // Broadcast streaming events to ALL WS clients sharing this session
    // so multi-tab users see real-time updates in every tab.
    const sessionBroadcastClients = () => {
      const ws = getWSInstance();
      return ws ? ws.getClientsBySessionId(message.channelId) : (targetClient ? [targetClient] : []);
    };
    try {
      const onChunk = (text: string) => {
        const content = redactSensitiveData(stripToolAnnotations(text));
        for (const clientId of sessionBroadcastClients()) {
          this.emitEvent({ type: "chat.chunk", data: { content } }, clientId);
        }
      };
      const onStreamReset = () => {
        for (const clientId of sessionBroadcastClients()) {
          this.emitEvent({ type: "chat.streamReset", data: {} }, clientId);
        }
      };
      sessionSummary = getSessionSummary(session.id);
      const CONTINUATION_EXTRA_ROUNDS = 20;
      const extraRounds = session.continuationPending ? CONTINUATION_EXTRA_ROUNDS : undefined;
      session.continuationPending = false;
      const result = await executeConversation(session.messages, emitExec, onChunk, onStreamReset, {
        sessionSummary,
        sessionId: session.id,
        originClientId: targetClient,
        channelType: message.channelType,
        channelId: message.channelId,
        voiceContext: { ttsActive: willTtsBeActive(message.inputModality ?? "text") },
        extraRounds,
        abortSignal: abortController.signal,
      });
      responseText = redactSensitiveData(stripToolAnnotations(result.text));
      actions = result.actions;
      allMedia = result.media ?? [];
      totalMessages = result.totalMessages;
      fittedMessages = result.fittedMessages;
      modelUsed = result.modelUsed;
      messagesAtExecution = [...session.messages];
      if (result.hitRoundLimit) session.continuationPending = true;
      for (const clientId of sessionBroadcastClients()) {
        this.emitEvent({ type: "chat.streamEnd", data: {} }, clientId);
        if (modelUsed) {
          this.emitEvent({ type: "chat.modelInfo", data: modelUsed }, clientId);
        }
      }
      executionSucceeded = true;
    } catch (err) {
      if (abortController.signal.aborted) {
        // User stopped generation — discard partial response
        aborted = true;
        console.log(`[gateway] generation stopped by user for session: ${sessionKey}`);
        for (const clientId of sessionBroadcastClients()) {
          this.emitEvent({ type: "chat.streamEnd", data: {} }, clientId);
          this.emitEvent({ type: "chat.stopped", data: {} }, clientId);
        }
        this.emitEvent({
          type: "execution.event",
          data: { type: "execution.failed", data: { error: "Stopped by user" } },
          sourceChannel,
        });
        responseText = "";
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const safeErrorMsg = redactSensitiveData(errorMsg);
        console.error("[gateway] execution failed:", safeErrorMsg);
        logError("system_error", err, { channelType: message.channelType, sessionKey: `${message.channelType}:${message.channelId}` });
        this.emitEvent({
          type: "execution.event",
          data: { type: "execution.failed", data: { error: safeErrorMsg } },
          sourceChannel,
        });
        responseText = "Sorry, I ran into an issue. Please try again.";
      }
    } finally {
      this.sessionAbortControllers.delete(sessionKey);
    }

    // Aborted — all cleanup already handled in catch block
    if (aborted) return;

    // ── Voice TTS post-processing ──
    const ttsMode: TtsMode = getTtsMode();
    const inputModality = message.inputModality ?? "text";

    let voiceAudio: { data: Uint8Array; format: import("../channels/channel.ts").AudioFormat } | undefined;
    let voiceAudioUrl: string | undefined;

    if (ttsMode !== "off" && responseText.trim()) {
      try {
        if (targetClient) {
          this.emitEvent({ type: "voice.status", data: { state: "synthesizing" } }, targetClient);
        }
        const voiceResult = await postProcess(responseText, {
          ttsMode,
          inputModality,
          channelType: message.channelType,
        });
        voiceAudio = voiceResult.audio;
        voiceAudioUrl = voiceResult.audioUrl;
        if (voiceAudioUrl) {
          // Broadcast audio to all tabs sharing this session (consistent with chat.chunk)
          for (const clientId of sessionBroadcastClients()) {
            this.emitEvent(
              { type: "chat.audio", data: { audioUrl: voiceAudioUrl, duration: voiceResult.duration, messageId: `resp-${message.id}` } },
              clientId
            );
          }
        }
      } catch (err) {
        console.error("[gateway] TTS post-processing failed:", err);
      }
    }
    // Always clear voice status if it was emitted (handles TTS off + STT on case)
    if (rawMessage.audioData && targetClient) {
      this.emitEvent({ type: "voice.status", data: { state: "ready" } }, targetClient);
    }

    const timestamp = new Date().toISOString();

    // Store assistant message (skip empty to avoid poisoning session history)
    if (responseText.trim()) {
      session.messages.push({
        id: `resp-${message.id}`,
        role: "assistant",
        content: responseText,
        channelType: message.channelType,
        timestamp,
        ...(actions.length > 0 ? { actions } : {}),
        ...(allMedia.length > 0 ? { media: allMedia } : {}),
        ...(modelUsed ? { modelUsed } : {}),
      });
    }

    session.updatedAt = timestamp;
    this.sessions.persist(session);

    // ── Session lifecycle: max messages auto-reset ──
    if (policy.maxMessages > 0 && session.messages.length >= policy.maxMessages) {
      resetSession(session.id, `max-messages (${policy.maxMessages})`)
        .then(() => this.sessions.evict(session.id))
        .catch((err) => console.error("[session-reset] max-messages reset failed:", err));
    }

    // Fire-and-forget memory extraction (both modes, only on success)
    if (executionSucceeded) {
      extractAndStoreMemories(
        session.messages,
        message.channelType,
        session.id
      ).catch((err) => console.error("[memory] extraction failed:", err));

      // Auto-generate title for new conversations
      if (getSessionMessageCount(session.id) === 2 && getSessionTitle(session.id) === null) {
        generateSessionTitle(session.id)
          .then((title) => {
            if (title) {
              updateSessionTitle(session.id, title);
              // Broadcast title update to all clients in this session
              // Use bare UUID (message.channelId) — WSManager sessionMap stores bare UUIDs
              getWSInstance()?.broadcastToSession(
                message.channelId,
                { type: "session.titleUpdate", data: { sessionId: session.id, title } }
              );
              console.log(`[gateway] auto-titled session ${session.id}: "${title}"`);
            }
          })
          .catch((err) => console.error("[gateway] title generation failed:", err));
      }

      // Fire-and-forget summarization when messages were truncated
      // Use sessionSummary (read before executeConversation) and messagesAtExecution
      // (snapshot before assistant push) to avoid off-by-one in dropped-message slice.
      if (shouldSummarize(totalMessages, fittedMessages)) {
        triggerSummarization(session.id, messagesAtExecution, fittedMessages, sessionSummary)
          .catch((err) => console.error("[summarizer] failed:", err));
      }
    }

    // Guard: never send empty text to channels (causes Telegram 400, etc.)
    if (!responseText.trim()) {
      responseText = "I'm temporarily unable to respond. Please try again in a moment.";
    }

    // Send response back through originating channel
    const channel = this.channels.get(message.channelType);
    if (channel) {
      await channel.sendResponse(message.channelId, responseText, message.threadId, {
        messageId: `resp-${message.id}`,
        ...(allMedia.length > 0 ? { media: allMedia } : {}),
        ...(voiceAudio ? { audio: voiceAudio } : {}),
      });
    } else {
      console.error(`[gateway] no channel registered for type: ${message.channelType}`);
    }

    // Complete the channel integration node animation
    if (channelCredId) {
      this.emitEvent({
        type: "execution.event",
        data: { type: "skill.completed", data: { nodeId: `channel-${channelCredId}`, output: "" } },
        sourceChannel,
      });
    }

    // Emit execution completed (canvas animation)
    this.emitEvent({
      type: "execution.event",
      data: { type: "execution.completed", data: { output: responseText } },
      sourceChannel,
    });
  }

  private emitEvent(event: GatewayServerEvent, targetClientId?: string): void {
    this.emit("event", event, targetClientId);
  }

  async sendToChannel(
    channelType: string,
    channelId: string,
    text: string,
    threadId?: string
  ): Promise<void> {
    const channel = this.channels.get(channelType);
    if (!channel) {
      console.error(`[gateway] no channel adapter for: ${channelType}`);
      return;
    }
    await channel.sendResponse(channelId, text, threadId);
  }

  async restartChannel(channelType: string): Promise<void> {
    const channel = this.channels.get(channelType);
    if (!channel) {
      console.log(`[gateway] no channel adapter for restart: ${channelType}`);
      return;
    }
    try {
      console.log(`[gateway] restarting channel: ${channelType}`);
      await channel.stop();
      await channel.start();
      console.log(`[gateway] restarted channel: ${channelType}`);
    } catch (err) {
      console.error(`[gateway] restart failed for ${channelType}:`, err);
    }
  }

  async startAll(): Promise<void> {
    for (const [name, channel] of this.channels) {
      await channel.start();
      console.log(`[gateway] started channel: ${name}`);
    }
    this.warnDenyAllPolicies();
  }

  /** Log a warning for channels that have credentials but an effective deny-all policy. */
  private warnDenyAllPolicies(): void {
    const creds = listCredentials();
    const externalTypes = ["telegram", "discord", "slack", "whatsapp", "matrix"] as const;
    for (const ct of externalTypes) {
      if (!creds.find((c) => c.type === ct)) continue;
      const policy = getChannelPolicy(ct);
      const dmBlocked = policy.dm.mode === "allowlist" && policy.dm.allowlist.length === 0;
      const groupBlocked = policy.group.mode === "allowlist" && policy.group.allowlist.length === 0;
      if (dmBlocked && groupBlocked) {
        console.warn(
          `[gateway] ⚠ channel "${ct}" has credentials but its policy blocks ALL messages (empty allowlist). ` +
          `Configure the allowlist via PATCH /api/channels/${ct}/policy or set mode to "open".`
        );
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, channel] of this.channels) {
      await channel.stop();
      console.log(`[gateway] stopped channel: ${name}`);
    }
  }
}
