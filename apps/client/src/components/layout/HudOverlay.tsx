import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useAppStore } from "../../stores/app-store";
import { useUIStore } from "../../stores/ui-store";
import { useActivityStore } from "../../stores/activity-store";
import { TokenCounter } from "./TokenCounter";
import type { LayoutMode } from "../../stores/ui-store";

/* ─── Top Bar ─── */

function HudClock() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div className="flex flex-col items-end">
      <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.15em] text-node-label">{time}</span>
      <span className="font-mono text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{date}</span>
    </div>
  );
}

function ConnectionStatus() {
  const connected = useAppStore((s) => s.connected);
  const reconnecting = useAppStore((s) => s.reconnecting);

  let dotClass = "bg-destructive";
  let label = "Offline";
  if (connected) {
    dotClass = "bg-status-completed";
    label = "Online";
  } else if (reconnecting) {
    dotClass = "bg-status-warning animate-pulse";
    label = "Reconnecting";
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className={cn("h-[6px] w-[6px] rounded-full", dotClass)} />
      <span className="font-mono text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
    </div>
  );
}

function ChatToggle() {
  const chatCollapsed = useUIStore((s) => s.chatCollapsed);
  const toggleChat = useUIStore((s) => s.toggleChat);
  const isStreaming = useAppStore((s) => s.streamingContent !== null);
  const messages = useAppStore((s) => s.messages);
  const lastIsUser = messages.length > 0 && messages[messages.length - 1].role === "user";
  const hasUnread = chatCollapsed && (isStreaming || lastIsUser);

  return (
    <button
      onClick={toggleChat}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-all duration-200",
        chatCollapsed
          ? "text-muted-foreground hover:text-foreground"
          : "bg-primary/15 text-primary",
      )}
      style={{
        background: chatCollapsed ? "var(--glass-bg)" : undefined,
        border: `1px solid ${chatCollapsed ? "var(--glass-border)" : "oklch(0.62 0.13 250 / 0.4)"}`,
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em]">Chat</span>
      {hasUnread && (
        <span className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" />
      )}
    </button>
  );
}

export function TopBar({ layoutMode }: { layoutMode?: LayoutMode }) {
  const isExpanded = layoutMode === "canvas-expanded";
  const unreadCount = useActivityStore((s) => s.unreadCount);
  const fetchUnread = useActivityStore((s) => s.fetchUnread);
  const togglePanel = useUIStore((s) => s.togglePanel);

  useEffect(() => { fetchUnread(); }, [fetchUnread]);

  return (
    <div
      className={cn(
        "flex h-full items-center justify-between px-5 transition-opacity duration-300",
        isExpanded && "opacity-40 hover:opacity-100"
      )}
    >
      {/* Left: Logo */}
      <div className="flex items-center gap-2.5">
        <div className="glass flex h-6 w-6 items-center justify-center rounded-md overflow-hidden">
          <img src="/chvor_logo.svg" alt="Chvor" className="h-4 w-4 object-contain" />
        </div>
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-node-label">Chvor</span>
      </div>

      {/* Center: Token counter */}
      <TokenCounter />

      {/* Right: status + clock + chat toggle */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => togglePanel("activity")}
          className="relative flex items-center justify-center w-7 h-7 rounded-md hover:bg-white/10 transition-colors"
          title="Activity feed"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-white">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
        <ConnectionStatus />
        <HudClock />
        <ChatToggle />
      </div>
    </div>
  );
}
