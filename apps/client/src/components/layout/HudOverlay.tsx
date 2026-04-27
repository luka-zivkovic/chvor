import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useAppStore } from "../../stores/app-store";
import { useUIStore } from "../../stores/ui-store";
import { useRuntimeStore } from "../../stores/runtime-store";
import { useFeatureStore } from "../../stores/feature-store";
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
  const unreadCount = useRuntimeStore((s) => s.unreadCount);
  const fetchUnread = useRuntimeStore((s) => s.fetchUnread);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const toggleMobileMenu = useUIStore((s) => s.toggleMobileMenu);

  useEffect(() => { fetchUnread(); }, [fetchUnread]);

  return (
    <div
      className={cn(
        "flex h-full items-center justify-between px-2 md:px-5 transition-opacity duration-300",
        isExpanded && "opacity-40 hover:opacity-100"
      )}
    >
      {/* Left: Hamburger (mobile) + Logo */}
      <div className="flex items-center gap-2">
        <button
          onClick={toggleMobileMenu}
          className="flex md:hidden h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          title="Menu"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="glass flex h-6 w-6 items-center justify-center rounded-md overflow-hidden">
          <img src="/chvor_logo.svg" alt="Chvor" className="h-4 w-4 object-contain" />
        </div>
        <span className="hidden md:inline font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-node-label">Chvor</span>
      </div>

      {/* Center: Token counter (hidden on mobile) */}
      <div className="hidden md:block">
        <TokenCounter />
      </div>

      {/* Right: status + clock + chat toggle */}
      <div className="flex items-center gap-2 md:gap-4">
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
        <button
          onClick={() => {
            const store = useFeatureStore.getState();
            const ui = useUIStore.getState();
            store.setKindFilter("template");
            if (ui.activePanel === "registry") {
              // Already open — just re-search with new filter
              store.search(undefined, undefined, "template");
            } else {
              togglePanel("registry");
            }
          }}
          className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          title="Templates"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M17.5 14v7M14 17.5h7" />
          </svg>
        </button>
        <button
          onClick={() => useUIStore.getState().openSettings()}
          className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          title="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <div className="hidden md:block"><ConnectionStatus /></div>
        <div className="hidden md:block"><HudClock /></div>
        <ChatToggle />
      </div>
    </div>
  );
}
