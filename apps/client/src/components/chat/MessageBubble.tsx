import { useState, useCallback, useMemo } from "react";
import type { ChatMessage } from "@chvor/shared";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MediaRenderer } from "./MediaRenderer";
import { MemoryTrace } from "./MemoryTrace";
import { ToolTrace } from "./ToolTrace";
import { sanitizeMessageContent } from "@/lib/chat-utils";
import { useEmotionStore } from "@/stores/emotion-store";
import { useAppStore } from "@/stores/app-store";

interface Props {
  message: ChatMessage;
}

const URL_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

/** Render plain text with clickable URLs. */
function Linkify({ text }: { text: string }) {
  const parts = useMemo(() => {
    const result: Array<{ type: "text" | "link"; value: string }> = [];
    let lastIndex = 0;
    for (const match of text.matchAll(URL_RE)) {
      if (match.index > lastIndex) {
        result.push({ type: "text", value: text.slice(lastIndex, match.index) });
      }
      result.push({ type: "link", value: match[0] });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      result.push({ type: "text", value: text.slice(lastIndex) });
    }
    return result;
  }, [text]);

  if (parts.length === 0) return <>{text}</>;

  return (
    <>
      {parts.map((p, i) =>
        p.type === "link" ? (
          <a
            key={i}
            href={p.value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 break-all hover:opacity-80"
          >
            {p.value}
          </a>
        ) : (
          <span key={i}>{p.value}</span>
        )
      )}
    </>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="animate-fade-in flex justify-end">
        <div className="max-w-[85%] overflow-hidden">
          <div
            className="rounded-2xl rounded-br-sm px-3.5 py-2"
            style={{
              background: "var(--user-bubble-bg)",
              border: "1px solid var(--user-bubble-border)",
            }}
          >
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground" style={{ overflowWrap: "break-word" }}>
              <Linkify text={message.content} />
            </p>
          </div>
          <span className="mt-1 block text-right font-mono text-[10px] text-muted-foreground/40" title={new Date(message.timestamp).toLocaleString()}>
            {formatTime(message.timestamp)}
          </span>
        </div>
      </div>
    );
  }

  return <AssistantBubble message={message} />;
}

function useEmotionForMessage(timestamp: string): { label: string; color: string } | null {
  const history = useEmotionStore((s) => s.sessionHistory);
  return useMemo(() => {
    if (!history.length) return null;
    const msgTime = new Date(timestamp).getTime();
    let closest = history[0];
    let minDiff = Infinity;
    for (const snap of history) {
      const diff = Math.abs(new Date(snap.timestamp).getTime() - msgTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = snap;
      }
    }
    // Only show if within 30 seconds of the message
    if (minDiff > 30_000) return null;
    if (!closest.displayLabel || !closest.color) return null;
    return { label: closest.displayLabel, color: closest.color };
  }, [history, timestamp]);
}

function AssistantBubble({ message }: Props) {
  const [copied, setCopied] = useState(false);
  const emotion = useEmotionForMessage(message.timestamp);
  const trace = useAppStore((s) => s.messageTraces[message.id]);
  const toolTraceEntries = useAppStore((s) => s.messageToolTraces[message.id]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(sanitizeMessageContent(message.content)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => console.warn("clipboard write failed"));
  }, [message.content]);

  return (
    <div className="group animate-fade-in flex justify-start gap-2">
      <img src="/bot-avatar-512.png" alt="Chvor" className="h-5 w-5 shrink-0 rounded-full mt-0.5" />
      <div className="relative max-w-[85%] min-w-0 overflow-hidden">
        <div
          className="rounded-2xl rounded-bl-sm px-3.5 py-2"
          style={{
            background: "var(--glass-bg)",
            border: "1px solid var(--glass-border)",
          }}
        >
          <MarkdownRenderer content={sanitizeMessageContent(message.content)} />
          {message.media?.length ? <MediaRenderer media={message.media} /> : null}
        </div>
        {/* Copy button */}
        <button
          onClick={handleCopy}
          className="absolute -top-2 right-1 hidden h-6 w-6 items-center justify-center rounded-md text-muted-foreground/50 transition-all hover:text-foreground group-hover:flex"
          style={{ background: "var(--glass-bg-strong)", border: "1px solid var(--glass-border)" }}
          title={copied ? "Copied!" : "Copy message"}
        >
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-status-completed">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground/40" title={new Date(message.timestamp).toLocaleString()}>
            {formatTime(message.timestamp)}
          </span>
          {emotion && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground/50">
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: emotion.color }} />
              {emotion.label}
            </span>
          )}
          {message.modelUsed?.wasFallback && (
            <span className="text-[10px] text-status-warning/70" title={`${message.modelUsed.providerId}/${message.modelUsed.model}`}>
              Responded using {message.modelUsed.model} (primary unavailable)
            </span>
          )}
        </div>
        {(toolTraceEntries || trace) && (
          <div className="mt-1 space-y-0.5">
            {toolTraceEntries && <ToolTrace tools={toolTraceEntries} />}
            {trace && <MemoryTrace trace={trace} />}
          </div>
        )}
      </div>
    </div>
  );
}
