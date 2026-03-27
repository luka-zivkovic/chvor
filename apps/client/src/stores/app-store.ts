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
} from "@chvor/shared";
import { useScheduleStore } from "./schedule-store";
import { useWebhookStore } from "./webhook-store";
import { useVoiceStore } from "./voice-store";
import { useActivityStore } from "./activity-store";
import { usePcStore } from "./pc-store";
import { useWhatsAppStore } from "./whatsapp-store";
import { useEmotionStore } from "./emotion-store";
import { useSkillStore } from "./skill-store";
import { useRegistryStore } from "./registry-store";
import { useA2UIStore } from "./a2ui-store";
import { useUIStore } from "./ui-store";
import { SESSION_ID_KEY } from "../lib/constants";
import { api } from "../lib/api";

// Streaming chunk buffer — avoids O(n²) string concat in immutable state
let chunkBuffer: string[] = [];
let switchGeneration = 0;
const MAX_EXECUTION_EVENTS = 200;

interface StreamingTool {
  name: string;
  status: "running" | "done";
  result?: string;
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

  _send: ((event: GatewayClientEvent) => void) | null;
  setSend: (fn: (event: GatewayClientEvent) => void) => void;
  _sendChat: ((text: string, inputModality?: "voice", media?: MediaArtifact[]) => void) | null;
  setSendChat: (fn: (text: string, inputModality?: "voice", media?: MediaArtifact[]) => void) => void;
  _stopGeneration: (() => void) | null;
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

  executionEvents: ExecutionEvent[];
  addExecutionEvent: (event: ExecutionEvent) => void;
  clearExecutionEvents: () => void;

  pendingApprovals: CommandApprovalRequest[];
  respondToApproval: (requestId: string, approved: boolean) => void;

  handleServerEvent: (event: GatewayServerEvent) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  connected: false,
  reconnecting: false,
  setConnected: (connected) => {
    const updates: Partial<AppState> = { connected };
    if (!connected) updates.pendingApprovals = []; // clear zombie approval cards on disconnect
    set(updates);
  },
  setReconnecting: (reconnecting) => set({ reconnecting }),

  sessionId: null,
  setSessionId: (id) => set({ sessionId: id }),
  loadSessionHistory: async (sessionId) => {
    try {
      const compositeId = `web:${sessionId}:default`;
      const messages = await api.sessions.messages(compositeId);
      if (messages?.length) {
        set({ messages });
      }
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
      currentEmotion: null,
      messagesLoading: false,
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
  _send: null,
  setSend: (fn) => set({ _send: fn }),
  _sendChat: null,
  setSendChat: (fn) => set({ _sendChat: fn }),
  _stopGeneration: null,
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
        conversations: get().conversations.map((c) =>
          c.id === compositeId ? { ...c, title } : c
        ),
      });
    } catch (err) {
      console.error("[app] failed to update title:", err);
    }
  },

  messages: [],
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  clearMessages: () => set({ messages: [] }),

  streamingContent: null,
  streamingTools: [],
  streamingStopped: false,
  pendingModelInfo: null,
  clearStreaming: () => {
    chunkBuffer = [];
    set({ streamingContent: null, streamingTools: [], streamingStopped: true, pendingModelInfo: null });
  },

  currentEmotion: null,

  executionEvents: [],
  addExecutionEvent: (event) =>
    set((s) => {
      const events = [...s.executionEvents, event];
      return { executionEvents: events.length > MAX_EXECUTION_EVENTS ? events.slice(-MAX_EXECUTION_EVENTS) : events };
    }),
  clearExecutionEvents: () => set({ executionEvents: [] }),

  pendingApprovals: [],
  respondToApproval: (_requestId, _approved) => {
    // Actual WS send is done in the component via useGateway; this just removes from state
    set((s) => ({
      pendingApprovals: s.pendingApprovals.filter((a) => a.requestId !== _requestId),
    }));
  },

  handleServerEvent: (event) => {
    switch (event.type) {
      case "chat.message": {
        // Stream complete — finalize: move streaming content to messages, clear streaming state
        chunkBuffer = [];
        const modelInfo = get().pendingModelInfo;
        set({ streamingContent: null, streamingTools: [], pendingModelInfo: null });
        get().addMessage({
          id: event.data.messageId ?? crypto.randomUUID(),
          role: event.data.role,
          content: event.data.content,
          channelType: "web",
          timestamp: event.data.timestamp,
          ...(event.data.media?.length ? { media: event.data.media } : {}),
          ...(modelInfo ? { modelUsed: modelInfo } : {}),
        });
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
          set({ streamingContent: null, streamingTools: [], streamingStopped: true, pendingModelInfo: null });
        }
        break;
      case "execution.event": {
        get().addExecutionEvent(event.data);
        const execEvent = event.data;
        // Reset streaming state when a new execution begins
        if (execEvent.type === "execution.started") {
          chunkBuffer = [];
          set({ streamingContent: null, streamingTools: [], streamingStopped: false, pendingModelInfo: null });
        }
        // Track tool invocations in streaming tools (deduplicate same skill)
        if (execEvent.type === "skill.invoked") {
          const toolName = execEvent.data.skillId;
          set((s) => {
            const alreadyRunning = s.streamingTools.some(
              (t) => t.name === toolName && t.status === "running"
            );
            if (alreadyRunning) return s;
            return {
              streamingTools: [...s.streamingTools, { name: toolName, status: "running" }],
            };
          });
        } else if (execEvent.type === "skill.completed") {
          const nodeId = execEvent.data.nodeId;
          const skillId = nodeId.replace("skill-", "");
          const skillMedia = execEvent.data.media;
          set((s) => ({
            streamingTools: s.streamingTools.map((t) =>
              t.name === skillId && t.status === "running"
                ? { ...t, status: "done" as const, ...(skillMedia?.length ? { media: skillMedia } : {}) }
                : t
            ),
          }));
        } else if (execEvent.type === "skill.failed") {
          const nodeId = execEvent.data.nodeId;
          const skillId = nodeId.replace("skill-", "");
          set((s) => ({
            streamingTools: s.streamingTools.map((t) =>
              t.name === skillId && t.status === "running"
                ? { ...t, status: "done" as const, result: execEvent.data.error }
                : t
            ),
          }));
        }
        // Tool execution tracking
        else if (execEvent.type === "tool.invoked") {
          const toolName = execEvent.data.toolId;
          set((s) => {
            const alreadyRunning = s.streamingTools.some(
              (t) => t.name === toolName && t.status === "running"
            );
            if (alreadyRunning) return s;
            return {
              streamingTools: [...s.streamingTools, { name: toolName, status: "running" }],
            };
          });
        } else if (execEvent.type === "tool.completed") {
          const nodeId = execEvent.data.nodeId;
          const toolId = nodeId.replace("tool-", "");
          const toolMedia = execEvent.data.media;
          set((s) => ({
            streamingTools: s.streamingTools.map((t) =>
              t.name === toolId && t.status === "running"
                ? { ...t, status: "done" as const, ...(toolMedia?.length ? { media: toolMedia } : {}) }
                : t
            ),
          }));
        } else if (execEvent.type === "tool.failed") {
          const nodeId = execEvent.data.nodeId;
          const toolId = nodeId.replace("tool-", "");
          set((s) => ({
            streamingTools: s.streamingTools.map((t) =>
              t.name === toolId && t.status === "running"
                ? { ...t, status: "done" as const, result: execEvent.data.error }
                : t
            ),
          }));
        } else if (execEvent.type === "brain.emotion") {
          const d = execEvent.data;
          if ("emotion" in d && "intensity" in d) set({ currentEmotion: d });
          useEmotionStore.getState().handleEmotionEvent(d);
        }
        break;
      }
      case "schedule.created":
      case "schedule.updated":
      case "schedule.deleted":
        useScheduleStore.getState().fetchAll();
        break;
      case "webhook.created":
      case "webhook.updated":
      case "webhook.deleted":
      case "webhook.received":
        useWebhookStore.getState().fetchAll();
        break;
      case "a2ui.surface":
        useA2UIStore.getState().handleSurfaceUpdate(event.data);
        break;
      case "a2ui.data":
        useA2UIStore.getState().handleDataUpdate(event.data);
        break;
      case "a2ui.delete":
        useA2UIStore.getState().handleDelete(event.data);
        break;
      case "a2ui.toast":
        import("sonner").then(({ toast }) => {
          toast.success(event.data.title ?? "Surface ready", {
            action: { label: "Open Canvas", onClick: () => useUIStore.getState().openCanvas() },
          });
        }).catch(() => { /* sonner not available */ });
        break;
      case "activity.new":
        useActivityStore.getState().handleActivityEvent(event.data);
        break;
      case "pc.connected":
        usePcStore.getState().handleAgentConnected(event.data);
        break;
      case "pc.disconnected":
        usePcStore.getState().handleAgentDisconnected(event.data.id);
        break;
      case "pc.frame":
        usePcStore.getState().handleFrame(event.data.agentId, event.data.screenshot, event.data.mimeType);
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
      case "error":
        console.error("[gateway] error:", event.data.message);
        break;
      case "chat.audio": {
        useVoiceStore.getState().setAudioUrl(event.data.messageId, event.data.audioUrl);
        break;
      }
      case "voice.status": {
        const state = event.data.state;
        if (state === "transcribing") {
          useVoiceStore.getState().setTalkPhase("listening");
        } else if (state === "synthesizing") {
          useVoiceStore.getState().setTalkPhase("thinking");
        } else if (state === "ready") {
          useVoiceStore.getState().setTalkPhase("idle");
        }
        break;
      }
      case "whatsapp.qr":
        useWhatsAppStore.getState().setQR(event.data.qrDataUrl);
        break;
      case "whatsapp.status":
        useWhatsAppStore.getState().setStatus(event.data.status, event.data.phoneNumber);
        break;
      case "skills.reloaded":
        useSkillStore.getState().fetchSkills();
        break;
      case "registry.updatesAvailable":
        useRegistryStore.getState().checkUpdates();
        break;
    }
  },
}));
