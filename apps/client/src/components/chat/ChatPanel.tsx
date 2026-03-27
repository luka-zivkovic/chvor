import { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../../stores/app-store";

import { cn } from "@/lib/utils";
import { MessageBubble } from "./MessageBubble";
import { StreamingMessage } from "./StreamingMessage";
import { ChatInput } from "./ChatInput";
import { TalkMode } from "./TalkMode";
import { AudioPlayback } from "./AudioPlayback";
import { useVoiceStore } from "@/stores/voice-store";
import { CommandApproval } from "./CommandApproval";
import { ConversationSwitcher } from "./ConversationSwitcher";
import type { LayoutMode } from "../../stores/ui-store";
import type { ConversationSummary } from "@chvor/shared";

interface Props {
  collapsed?: boolean;
  layoutMode?: LayoutMode;
}

function ThinkingIndicator() {
  return (
    <div className="animate-fade-in flex items-center justify-start gap-1.5 px-3 py-2">
      <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary/60" />
      <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary/60" />
      <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary/60" />
    </div>
  );
}

const STARTER_PROMPTS = [
  "What can you do?",
  "Search the web for...",
  "Help me brainstorm",
  "Tell me a joke",
];

function EmptyState({ onSend }: { onSend: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 overflow-hidden">
        <img src="/chvor_logo.svg" alt="Chvor" className="h-6 w-6 object-contain" />
      </div>
      <p className="text-xs text-muted-foreground">
        Start a conversation
      </p>
      <div className="flex max-w-sm flex-wrap items-center justify-center gap-2">
        {STARTER_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            onClick={() => onSend(prompt)}
            className="cursor-pointer rounded-full border border-border px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function StreamingSection({ lastIsUser, scrollToBottom }: { lastIsUser: boolean; scrollToBottom: () => void }) {
  const streamingContent = useAppStore((s) => s.streamingContent);
  const streamingTools = useAppStore((s) => s.streamingTools);
  const streamingStopped = useAppStore((s) => s.streamingStopped);
  const isStreaming = streamingContent !== null;
  const isThinking = !isStreaming && lastIsUser && !streamingStopped;

  useEffect(() => {
    if (isStreaming) scrollToBottom();
  }, [streamingContent, isStreaming, scrollToBottom]);

  return (
    <>
      {isStreaming && <StreamingMessage content={streamingContent} tools={streamingTools} />}
      {isThinking && <ThinkingIndicator />}
    </>
  );
}

function ConversationTitle({
  sessionId,
  conversations,
  onRename,
}: {
  sessionId: string | null;
  conversations: ConversationSummary[];
  onRename: (compositeId: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const compositeId = sessionId ? `web:${sessionId}:default` : null;
  const current = conversations.find((c) => c.id === compositeId);
  const title = current?.title || "New conversation";

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title && compositeId) {
      onRename(compositeId, trimmed);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="font-mono text-xs bg-transparent border-b border-accent outline-none text-foreground min-w-0 flex-1"
        maxLength={100}
      />
    );
  }

  return (
    <button
      onClick={() => {
        setDraft(title);
        setEditing(true);
      }}
      className="font-mono text-xs text-muted-foreground hover:text-foreground truncate min-w-0 flex-1 text-left transition-colors"
      title="Click to rename"
    >
      {title}
    </button>
  );
}

export function ChatPanel({ collapsed, layoutMode }: Props) {
  const messages = useAppStore((s) => s.messages);
  const connected = useAppStore((s) => s.connected);
  const isStreaming = useAppStore((s) => s.streamingContent !== null);
  const pendingApprovals = useAppStore((s) => s.pendingApprovals);
  const conversations = useAppStore((s) => s.conversations);
  const sessionId = useAppStore((s) => s.sessionId);
  const newConversation = useAppStore((s) => s.newConversation);
  const updateConversationTitle = useAppStore((s) => s.updateConversationTitle);
  const messagesLoading = useAppStore((s) => s.messagesLoading);
  const send = useAppStore((s) => s._send);
  const sendChat = useAppStore((s) => s._sendChat);
  const stopGeneration = useAppStore((s) => s._stopGeneration);
  const { setTalkModeActive } = useVoiceStore();
  const audioUrls = useVoiceStore((s) => s.audioUrls);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const scrollToBottom = useCallback(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  useEffect(() => {
    useVoiceStore.getState().fetchConfig();
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    userScrolledUp.current = !atBottom;
    setShowScrollButton(!atBottom);
  }, []);

  const handleStop = useCallback(() => {
    stopGeneration();
    useAppStore.getState().clearStreaming();
  }, [stopGeneration]);

  const handleSend = (text: string, inputModality?: "voice", media?: import("@chvor/shared").MediaArtifact[]) => {
    // Auto-stop current generation when sending a new message
    if (isStreaming) {
      stopGeneration();
      useAppStore.getState().clearStreaming();
    }
    userScrolledUp.current = false;
    setShowScrollButton(false);
    useAppStore.getState().addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      channelType: "web",
      timestamp: new Date().toISOString(),
      ...(media?.length ? { media } : {}),
    });
    sendChat(text, inputModality, media);
  };

  const lastIsUser = messages.length > 0 && messages[messages.length - 1].role === "user";
  const isHidden = layoutMode === "canvas-expanded";

  return (
    <div
      className={cn(
        "absolute top-10 right-0 bottom-0 z-20 w-full md:w-[460px]",
        "flex flex-col transition-transform duration-300 ease-in-out",
        collapsed ? "translate-x-full md:translate-x-[460px]" : "translate-x-0",
        isHidden && "translate-x-full md:translate-x-[460px]"
      )}
      style={{
        background: "var(--chat-panel-bg)",
        backdropFilter: "blur(28px) saturate(1.1)",
        borderLeft: "1px solid var(--glass-border)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            onClick={() => newConversation()}
            title="New conversation (Ctrl+Shift+N)"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 3V13M3 8H13" />
            </svg>
          </button>
          <ConversationTitle
            sessionId={sessionId}
            conversations={conversations}
            onRename={updateConversationTitle}
          />
          <ConversationSwitcher />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setTalkModeActive(true)}
            title="Talk Mode"
            className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" x2="12" y1="19" y2="22" />
            </svg>
          </button>
          <span className={cn("h-[6px] w-[6px] rounded-full", connected ? "bg-status-completed" : "bg-destructive")} />
        </div>
      </div>

      {/* Messages */}
      <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} onScroll={handleScroll} className="chat-scrollbar h-full overflow-y-auto px-4 py-3">
          {messagesLoading ? (
            <div className="flex items-center justify-center h-32">
              <div className="text-xs text-muted-foreground/50">Loading conversation...</div>
            </div>
          ) : messages.length === 0 && !isStreaming ? (
            <EmptyState onSend={handleSend} />
          ) : (
            <div className="flex flex-col gap-4">
              {messages.map((msg) => {
                const msgAudioUrl = msg.role === "assistant"
                  ? audioUrls[msg.id]
                  : undefined;
                return (
                  <div key={msg.id} className="min-w-0">
                    <MessageBubble message={msg} />
                    {msgAudioUrl && <AudioPlayback audioUrl={msgAudioUrl} autoPlay />}
                  </div>
                );
              })}
              <StreamingSection lastIsUser={lastIsUser} scrollToBottom={scrollToBottom} />
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Scroll to bottom */}
        {showScrollButton && (
          <button
            onClick={() => {
              userScrolledUp.current = false;
              setShowScrollButton(false);
              bottomRef.current?.scrollIntoView({ behavior: "smooth" });
            }}
            className="animate-fade-in absolute bottom-3 left-1/2 z-30 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full shadow-md transition-all hover:scale-105"
            style={{
              background: "var(--glass-bg-strong)",
              border: "1px solid var(--glass-border)",
              backdropFilter: "blur(12px)",
            }}
            title="Scroll to bottom"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
      </div>

      {/* Pending command approvals */}
      {pendingApprovals.length > 0 && (
        <div className="shrink-0">
          {pendingApprovals.map((a) => (
            <CommandApproval key={a.requestId} approval={a} onSend={send} />
          ))}
        </div>
      )}

      {/* Input */}
      <div className="px-3 py-3 shrink-0">
        <ChatInput onSend={handleSend} onStop={handleStop} disabled={!connected} isStreaming={isStreaming} />
      </div>
      <TalkMode onSend={handleSend} />
    </div>
  );
}
