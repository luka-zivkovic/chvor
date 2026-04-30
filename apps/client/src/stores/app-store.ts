import { create } from "zustand";
import type {
  ChatMessage,
  GatewayClientEvent,
  GatewayServerEvent,
  ExecutionEvent,
  EmotionState,
  MediaArtifact,
  ModelUsedInfo,
  CommandApprovalRequest,
  ConversationSummary,
  MemoryRetrievalTrace,
  TokenBudgetInfo,
  ToolBagResolvedEvent,
  SecurityVerdictEvent,
} from "@chvor/shared";

const MAX_SECURITY_VERDICTS = 50;
import { useFeatureStore } from "./feature-store";
import { useRuntimeStore } from "./runtime-store";
import { useSessionStore } from "./session-store";
import { useUIStore } from "./ui-store";
import { useCanvasStore } from "./canvas-store";
import { SESSION_ID_KEY } from "../lib/constants";
import { api } from "../lib/api";

// ── Module-level mutable state (intentional) ──────────────────
// These live outside the Zustand store for performance. They are NOT reactive
// and must only be read/written inside store actions.
// chunkBuffer: avoids O(n²) string concat in immutable state during streaming.
// switchGeneration: monotonic counter to discard stale async loads after conversation switch.
let chunkBuffer: string[] = [];
let switchGeneration = 0;
const MAX_EXECUTION_EVENTS = 200;

export interface StreamingTool {
  name: string;
  status: "running" | "done";
  result?: string;
  media?: MediaArtifact[];
}

export interface ToolTraceEntry {
  name: string;
  reason?: string;
  status: "running" | "completed" | "failed";
  output?: string;
  truncated?: boolean;
  error?: string;
  media?: MediaArtifact[];
}

interface AppState {
  connected: boolean;
  reconnecting: boolean;
  setConnected: (connected: boolean) => void;
  setReconnecting: (reconnecting: boolean) => void;

  sessionId: string | null;
  setSessionId: (id: string) => void;
  loadSessionHistory: (sessionId: string) => Promise<void>;
  newConversation: () => void;

  // Conversation management
  conversations: ConversationSummary[];
  conversationsLoading: boolean;
  messagesLoading: boolean;
  _reinitSession: ((id: string) => void) | null;
  setReinitSession: (fn: (id: string) => void) => void;

  _send: (event: GatewayClientEvent) => void;
  setSend: (fn: (event: GatewayClientEvent) => void) => void;
  _sendChat: (
    text: string,
    inputModality?: "voice",
    media?: MediaArtifact[],
    messageId?: string
  ) => void;
  setSendChat: (
    fn: (text: string, inputModality?: "voice", media?: MediaArtifact[], messageId?: string) => void
  ) => void;
  _stopGeneration: () => void;
  setStopGeneration: (fn: () => void) => void;
  loadConversations: () => Promise<void>;
  switchConversation: (compositeId: string) => Promise<void>;
  deleteConversation: (compositeId: string) => Promise<void>;
  archiveConversation: (compositeId: string, archive: boolean) => Promise<void>;
  updateConversationTitle: (compositeId: string, title: string) => Promise<void>;

  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  clearMessages: () => void;

  // Streaming state
  streamingContent: string | null;
  streamingTools: StreamingTool[];
  /** True after user stops generation — suppresses ThinkingIndicator until next send */
  streamingStopped: boolean;
  /** Model info received during streaming (attached to final message) */
  pendingModelInfo: ModelUsedInfo | null;
  clearStreaming: () => void;

  currentEmotion: EmotionState | null;

  // Transparency state (per-execution, cleared on execution.started)
  streamingThought: string | null;
  streamingDecisionReason: string | null;
  memoryTrace: MemoryRetrievalTrace | null;
  tokenBudget: TokenBudgetInfo | null;
  /** Memory traces keyed by message ID — persisted across messages in a session */
  messageTraces: Record<string, MemoryRetrievalTrace>;
  /** Tool execution trace accumulated during current execution */
  toolTrace: ToolTraceEntry[];
  /** Tool traces keyed by message ID — persisted across messages in a session */
  messageToolTraces: Record<string, ToolTraceEntry[]>;
  /** Most recent skill-scoped tool bag rationale (null until first turn this session). */
  lastToolBag: ToolBagResolvedEvent | null;
  /** Rolling buffer of recent security-analyzer verdicts (newest last). */
  securityVerdicts: SecurityVerdictEvent[];

  executionEvents: ExecutionEvent[];
  addExecutionEvent: (event: ExecutionEvent) => void;
  clearExecutionEvents: () => void;

  pendingApprovals: CommandApprovalRequest[];
  respondToApproval: (requestId: string, approved: boolean) => void;

  pendingCredentialRequests: import("@chvor/shared").CredentialRequestData[];
  respondToCredentialRequest: (requestId: string) => void;

  pendingCredentialChoices: import("@chvor/shared").CredentialChoiceRequestData[];
  respondToCredentialChoice: (requestId: string) => void;

  pendingSynthesizedConfirms: import("@chvor/shared").SynthesizedConfirmData[];
  respondToSynthesizedConfirm: (requestId: string) => void;

  pendingOAuthWizards: import("@chvor/shared").OAuthSynthesizedWizardData[];
  respondToOAuthWizard: (requestId: string) => void;

  handleServerEvent: (event: GatewayServerEvent) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  connected: false,
  reconnecting: false,
  setConnected: (connected) => {
    const updates: Partial<AppState> = { connected };
    if (!connected) {
      updates.pendingApprovals = [];
      updates.pendingCredentialRequests = [];
      updates.pendingCredentialChoices = [];
      updates.pendingSynthesizedConfirms = [];
      updates.pendingOAuthWizards = [];
    }
    set(updates);
  },
  setReconnecting: (reconnecting) => set({ reconnecting }),

  sessionId: null,
  setSessionId: (id) => set({ sessionId: id }),
  loadSessionHistory: async (sessionId) => {
    try {
      const compositeId = `web:${sessionId}:default`;
      const messages = await api.sessions.messages(compositeId);
      set({ messages: messages ?? [] });
    } catch (err) {
      console.error("[app] failed to load session history:", err);
    }
  },
  newConversation: () => {
    const newId = crypto.randomUUID();
    localStorage.setItem(SESSION_ID_KEY, newId);
    chunkBuffer = [];
    switchGeneration++;
    set({
      sessionId: newId,
      messages: [],
      executionEvents: [],
      streamingContent: null,
      streamingTools: [],
      streamingStopped: false,
      pendingModelInfo: null,
      pendingApprovals: [],
      pendingCredentialRequests: [],
      pendingCredentialChoices: [],
      pendingSynthesizedConfirms: [],
      pendingOAuthWizards: [],
      currentEmotion: null,
      messagesLoading: false,
      messageTraces: {},
      messageToolTraces: {},
      toolTrace: [],
      streamingThought: null,
      streamingDecisionReason: null,
      memoryTrace: null,
      tokenBudget: null,
      lastToolBag: null,
      securityVerdicts: [],
    });
    // Re-init WS session with new ID
    const reinit = get()._reinitSession;
    if (reinit) reinit(newId);
    // Refresh conversations list
    get().loadConversations();
  },

  // Conversation management
  conversations: [],
  conversationsLoading: false,
  messagesLoading: false,
  _reinitSession: null,
  setReinitSession: (fn) => set({ _reinitSession: fn }),
  _send: () => {},
  setSend: (fn) => set({ _send: fn }),
  _sendChat: () => {},
  setSendChat: (fn) => set({ _sendChat: fn }),
  _stopGeneration: () => {},
  setStopGeneration: (fn) => set({ _stopGeneration: fn }),

  loadConversations: async () => {
    set({ conversationsLoading: true });
    try {
      const data = await api.sessions.list({ archived: false });
      set({ conversations: data, conversationsLoading: false });
    } catch (err) {
      console.error("[app] failed to load conversations:", err);
      set({ conversationsLoading: false });
    }
  },

  switchConversation: async (compositeId: string) => {
    const bareId = compositeId.split(":")[1] ?? compositeId;
    localStorage.setItem(SESSION_ID_KEY, bareId);
    chunkBuffer = [];
    const gen = ++switchGeneration;
    set({
      sessionId: bareId,
      messages: [],
      executionEvents: [],
      streamingContent: null,
      streamingTools: [],
      streamingStopped: false,
      pendingModelInfo: null,
      pendingApprovals: [],
      pendingCredentialRequests: [],
      pendingCredentialChoices: [],
      pendingSynthesizedConfirms: [],
      pendingOAuthWizards: [],
      messagesLoading: true,
    });
    // Re-init WS session with new ID
    const reinit = get()._reinitSession;
    if (reinit) reinit(bareId);
    // Load history
    try {
      const messages = await api.sessions.messages(compositeId);
      if (gen !== switchGeneration) return; // Stale — another switch happened
      set({ messages: messages ?? [], messagesLoading: false });
    } catch (err) {
      if (gen !== switchGeneration) return;
      console.error("[app] failed to load conversation:", err);
      set({ messagesLoading: false });
    }
  },

  deleteConversation: async (compositeId: string) => {
    try {
      await api.sessions.delete(compositeId);
      const bareId = compositeId.split(":")[1] ?? compositeId;
      if (get().sessionId === bareId) {
        get().newConversation(); // already calls loadConversations
      } else {
        get().loadConversations();
      }
    } catch (err) {
      console.error("[app] failed to delete conversation:", err);
    }
  },

  archiveConversation: async (compositeId: string, archive: boolean) => {
    try {
      await api.sessions.patch(compositeId, { archived: archive });
      get().loadConversations();
    } catch (err) {
      console.error("[app] failed to archive conversation:", err);
    }
  },

  updateConversationTitle: async (compositeId: string, title: string) => {
    try {
      await api.sessions.patch(compositeId, { title });
      set({
        conversations: get().conversations.map((c) => (c.id === compositeId ? { ...c, title } : c)),
      });
    } catch (err) {
      console.error("[app] failed to update title:", err);
    }
  },

  messages: [],
  addMessage: (message) =>
    set((s) => {
      if (s.messages.some((m) => m.id === message.id)) return s;
      return { messages: [...s.messages, message] };
    }),
  clearMessages: () => set({ messages: [] }),

  streamingContent: null,
  streamingTools: [],
  streamingStopped: false,
  pendingModelInfo: null,
  clearStreaming: () => {
    chunkBuffer = [];
    set({
      streamingContent: null,
      streamingTools: [],
      streamingStopped: true,
      pendingModelInfo: null,
    });
  },

  currentEmotion: null,

  streamingThought: null,
  streamingDecisionReason: null,
  memoryTrace: null,
  tokenBudget: null,
  messageTraces: {},
  toolTrace: [],
  messageToolTraces: {},

  executionEvents: [],
  addExecutionEvent: (event) =>
    set((s) => {
      const events = [...s.executionEvents, event];
      return {
        executionEvents:
          events.length > MAX_EXECUTION_EVENTS ? events.slice(-MAX_EXECUTION_EVENTS) : events,
      };
    }),
  clearExecutionEvents: () => set({ executionEvents: [] }),
  lastToolBag: null,
  securityVerdicts: [],

  pendingApprovals: [],
  respondToApproval: (_requestId, _approved) => {
    // Actual WS send is done in the component via useGateway; this just removes from state
    set((s) => ({
      pendingApprovals: s.pendingApprovals.filter((a) => a.requestId !== _requestId),
    }));
  },

  pendingCredentialRequests: [],
  respondToCredentialRequest: (requestId) => {
    set((s) => ({
      pendingCredentialRequests: s.pendingCredentialRequests.filter(
        (r) => r.requestId !== requestId
      ),
    }));
  },

  pendingCredentialChoices: [],
  respondToCredentialChoice: (requestId) => {
    set((s) => ({
      pendingCredentialChoices: s.pendingCredentialChoices.filter((r) => r.requestId !== requestId),
    }));
  },

  pendingSynthesizedConfirms: [],
  respondToSynthesizedConfirm: (requestId) => {
    set((s) => ({
      pendingSynthesizedConfirms: s.pendingSynthesizedConfirms.filter(
        (r) => r.requestId !== requestId
      ),
    }));
  },

  pendingOAuthWizards: [],
  respondToOAuthWizard: (requestId) => {
    set((s) => ({
      pendingOAuthWizards: s.pendingOAuthWizards.filter((w) => w.requestId !== requestId),
    }));
  },

  handleServerEvent: (event) => {
    switch (event.type) {
      case "chat.message": {
        // Stream complete — finalize: move streaming content to messages, clear streaming state
        chunkBuffer = [];
        const modelInfo = get().pendingModelInfo;
        set({ streamingContent: null, streamingTools: [], pendingModelInfo: null });
        const messageId = event.data.messageId ?? crypto.randomUUID();
        const trace = get().memoryTrace;
        get().addMessage({
          id: messageId,
          role: event.data.role,
          content: event.data.content,
          channelType: "web",
          timestamp: event.data.timestamp,
          ...(event.data.media?.length ? { media: event.data.media } : {}),
          ...(modelInfo ? { modelUsed: modelInfo } : {}),
        });
        // Persist memory retrieval trace and tool trace for this message
        const toolTraceSnapshot = get().toolTrace;
        set((s) => ({
          ...(trace ? { messageTraces: { ...s.messageTraces, [messageId]: trace } } : {}),
          ...(toolTraceSnapshot.length
            ? { messageToolTraces: { ...s.messageToolTraces, [messageId]: toolTraceSnapshot } }
            : {}),
        }));
        break;
      }
      case "chat.chunk":
        chunkBuffer.push(event.data.content);
        set({ streamingContent: chunkBuffer.join(""), streamingStopped: false });
        break;
      case "chat.streamEnd":
        // Stream ended, chat.message will follow with full content
        break;
      case "chat.modelInfo":
        // Model info (especially useful when a fallback was used)
        set({ pendingModelInfo: event.data });
        break;
      case "chat.streamReset":
        // New LLM round after tool execution — clear stale text, keep tool indicators
        chunkBuffer = [];
        set({ streamingContent: "" });
        break;
      case "chat.stopped":
        // User stopped generation — discard partial response (skip if already handled by clearStreaming)
        if (!get().streamingStopped) {
          chunkBuffer = [];
          set({
            streamingContent: null,
            streamingTools: [],
            streamingStopped: true,
            pendingModelInfo: null,
          });
        }
        break;
      case "chat.welcome":
        // Welcome message after onboarding — display as assistant message
        get().addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: event.data.content,
          channelType: "web",
          timestamp: new Date().toISOString(),
        });
        break;
      case "execution.event": {
        get().addExecutionEvent(event.data);
        const execEvent = event.data;
        // Reset streaming state when a new execution begins
        if (execEvent.type === "execution.started") {
          chunkBuffer = [];
          useCanvasStore.getState().clearMindAgents();
          set({
            streamingContent: null,
            streamingTools: [],
            streamingStopped: false,
            pendingModelInfo: null,
            streamingThought: null,
            streamingDecisionReason: null,
            memoryTrace: null,
            tokenBudget: null,
            toolTrace: [],
          });
        }
        // Unified skill/tool execution tracking (shared logic, different ID extraction)
        if (execEvent.type === "skill.invoked" || execEvent.type === "tool.invoked") {
          const name =
            execEvent.type === "skill.invoked" ? execEvent.data.skillId : execEvent.data.toolId;
          const reason = get().streamingDecisionReason ?? undefined;
          set((s) => {
            const alreadyRunning = s.streamingTools.some(
              (t) => t.name === name && t.status === "running"
            );
            return {
              streamingTools: alreadyRunning
                ? s.streamingTools
                : [...s.streamingTools, { name, status: "running" }],
              toolTrace: [...s.toolTrace, { name, reason, status: "running" }],
            };
          });
        } else if (execEvent.type === "skill.completed" || execEvent.type === "tool.completed") {
          const prefix = execEvent.type === "skill.completed" ? "skill-" : "tool-";
          const id = execEvent.data.nodeId.replace(prefix, "");
          const media = execEvent.data.media;
          const outputStr =
            typeof execEvent.data.output === "string"
              ? execEvent.data.output
              : JSON.stringify(execEvent.data.output);
          set((s) => ({
            streamingTools: s.streamingTools.map((t) =>
              t.name === id && t.status === "running"
                ? { ...t, status: "done" as const, ...(media?.length ? { media } : {}) }
                : t
            ),
            toolTrace: s.toolTrace.map((t) =>
              t.name === id && t.status === "running"
                ? {
                    ...t,
                    status: "completed" as const,
                    output: outputStr?.slice(0, 500),
                    truncated: (outputStr?.length ?? 0) > 500,
                    ...(media?.length ? { media } : {}),
                  }
                : t
            ),
          }));
        } else if (execEvent.type === "skill.failed" || execEvent.type === "tool.failed") {
          const prefix = execEvent.type === "skill.failed" ? "skill-" : "tool-";
          const id = execEvent.data.nodeId.replace(prefix, "");
          set((s) => ({
            streamingTools: s.streamingTools.map((t) =>
              t.name === id && t.status === "running"
                ? { ...t, status: "done" as const, result: execEvent.data.error }
                : t
            ),
            toolTrace: s.toolTrace.map((t) =>
              t.name === id && t.status === "running"
                ? { ...t, status: "failed" as const, error: execEvent.data.error }
                : t
            ),
          }));
        } else if (execEvent.type === "brain.emotion") {
          const d = execEvent.data;
          if ("emotion" in d && "intensity" in d) set({ currentEmotion: d });
          useRuntimeStore.getState().handleEmotionEvent(d);
        } else if (execEvent.type === "brain.thinking") {
          set({ streamingThought: execEvent.data.thought });
        } else if (execEvent.type === "brain.decision") {
          set({ streamingDecisionReason: execEvent.data.reason });
        } else if (execEvent.type === "memory.retrieval_trace") {
          set({ memoryTrace: execEvent.data });
        } else if (execEvent.type === "execution.tokenBudget") {
          set({ tokenBudget: execEvent.data });
        } else if (execEvent.type === "execution.completed") {
          set({ streamingThought: null });
        } else if (execEvent.type === "tool.bag.resolved") {
          set({ lastToolBag: execEvent.data });
        } else if (execEvent.type === "security.verdict") {
          set((s) => {
            const next = [...s.securityVerdicts, execEvent.data];
            return {
              securityVerdicts:
                next.length > MAX_SECURITY_VERDICTS ? next.slice(-MAX_SECURITY_VERDICTS) : next,
            };
          });
        } else if (execEvent.type === "multi_mind.agent.started") {
          useCanvasStore.getState().upsertMindAgent({
            agentId: execEvent.data.agentId,
            role: execEvent.data.role,
            title: execEvent.data.title,
            status: "running",
          });
        } else if (execEvent.type === "multi_mind.agent.completed") {
          useCanvasStore
            .getState()
            .completeMindAgent(
              execEvent.data.agentId,
              execEvent.data.title,
              execEvent.data.text,
              execEvent.data.durationMs
            );
        } else if (execEvent.type === "multi_mind.agent.failed") {
          useCanvasStore.getState().failMindAgent(execEvent.data.agentId, execEvent.data.error);
        }
        break;
      }
      case "schedule.created":
      case "schedule.updated":
      case "schedule.deleted":
        useFeatureStore.getState().fetchSchedules();
        break;
      case "webhook.created":
      case "webhook.updated":
      case "webhook.deleted":
      case "webhook.received":
        useFeatureStore.getState().fetchWebhooks();
        break;
      case "a2ui.surface":
        useRuntimeStore.getState().handleSurfaceUpdate(event.data);
        break;
      case "a2ui.data":
        useRuntimeStore.getState().handleDataUpdate(event.data);
        break;
      case "a2ui.delete":
        useRuntimeStore.getState().handleDelete(event.data);
        break;
      case "a2ui.deleteAll":
        useRuntimeStore.getState().handleDeleteAll();
        break;
      case "a2ui.toast":
        // Auto-open the preview modal so the user sees the dashboard immediately
        useUIStore.getState().openPreviewModal(event.data.surfaceId);
        import("sonner")
          .then(({ toast }) => {
            toast.success(event.data.title ?? "Surface ready");
          })
          .catch(() => {
            /* sonner not available */
          });
        break;
      case "activity.new":
        useRuntimeStore.getState().handleActivityEvent(event.data);
        break;
      case "cognitive.loop.run":
        useRuntimeStore.getState().handleCognitiveLoopRun(event.data);
        break;
      case "cognitive.loop.event":
        useRuntimeStore.getState().handleCognitiveLoopEvent(event.data);
        break;
      case "pc.connected":
        useSessionStore.getState().handleAgentConnected(event.data);
        break;
      case "pc.disconnected":
        useSessionStore.getState().handleAgentDisconnected(event.data.id);
        break;
      case "pc.frame":
        useSessionStore
          .getState()
          .handleFrame(event.data.agentId, event.data.screenshot, event.data.mimeType);
        break;
      case "session.ack":
        console.log("[ws] session acknowledged:", event.data.sessionId);
        break;
      case "session.titleUpdate": {
        const { sessionId, title } = event.data;
        const found = get().conversations.some((c) => c.id === sessionId);
        if (found) {
          set({
            conversations: get().conversations.map((c) =>
              c.id === sessionId ? { ...c, title } : c
            ),
          });
        } else {
          // Session just created — reload full list to pick it up
          get().loadConversations();
        }
        break;
      }
      case "command.confirm":
        set((s) => ({
          pendingApprovals: [...s.pendingApprovals, event.data],
        }));
        break;
      case "credential.request":
        set((s) => ({
          pendingCredentialRequests: [...s.pendingCredentialRequests, event.data],
        }));
        break;
      case "credential.choice.request":
        set((s) => ({
          pendingCredentialChoices: [...s.pendingCredentialChoices, event.data],
        }));
        break;
      case "synthesized.confirm":
        set((s) => ({
          pendingSynthesizedConfirms: [...s.pendingSynthesizedConfirms, event.data],
        }));
        break;
      case "oauth.synthesized.wizard":
        set((s) => ({
          pendingOAuthWizards: [...s.pendingOAuthWizards, event.data],
        }));
        break;
      case "error":
        console.error("[gateway] error:", event.data.message);
        break;
      case "system.shutdown": {
        console.log("[ws] server shutdown announced:", event.data.reason);
        // Suppress the noisy reconnect-loop UI — the next clean restart will
        // re-open the socket on its own.
        set({ connected: false });
        import("sonner")
          .then(({ toast }) => {
            toast.info("Server is restarting…");
          })
          .catch(() => {
            /* sonner not available */
          });
        break;
      }
      case "chat.audio": {
        useFeatureStore.getState().setAudioUrl(event.data.messageId, event.data.audioUrl);
        break;
      }
      case "voice.status": {
        const state = event.data.state;
        if (state === "transcribing") {
          useFeatureStore.getState().setTalkPhase("listening");
        } else if (state === "synthesizing") {
          useFeatureStore.getState().setTalkPhase("thinking");
        } else if (state === "ready") {
          useFeatureStore.getState().setTalkPhase("idle");
        }
        break;
      }
      case "whatsapp.qr":
        useFeatureStore.getState().setQR(event.data.qrDataUrl);
        break;
      case "whatsapp.status":
        useFeatureStore.getState().setStatus(event.data.status, event.data.phoneNumber);
        break;
      case "skills.reloaded":
        useFeatureStore.getState().fetchSkills();
        break;
      case "registry.updatesAvailable":
        useFeatureStore.getState().checkUpdates();
        break;
    }
  },
}));
