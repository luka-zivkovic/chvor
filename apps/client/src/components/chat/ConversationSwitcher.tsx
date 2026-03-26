import { useRef, useState, useEffect } from "react";
import { useAppStore } from "../../stores/app-store";
import { useUIStore } from "../../stores/ui-store";
import { cn } from "@/lib/utils";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export function ConversationSwitcher() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const conversations = useAppStore((s) => s.conversations);
  const sessionId = useAppStore((s) => s.sessionId);
  const switchConversation = useAppStore((s) => s.switchConversation);
  const openPanel = useUIStore((s) => s.openPanel);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const recent = conversations.slice(0, 10);
  const currentCompositeId = sessionId ? `web:${sessionId}:default` : null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-muted-foreground/70 hover:text-foreground transition-colors"
        title="Switch conversation"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d={open ? "M4 10L8 6L12 10" : "M4 6L8 10L12 6"} />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-72 rounded-lg border border-border/50 bg-popover shadow-lg z-50 overflow-hidden">
          {recent.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center">No conversations yet</div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {recent.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    if (c.id !== currentCompositeId) {
                      switchConversation(c.id);
                    }
                    setOpen(false);
                  }}
                  className={cn(
                    "w-full px-3 py-2 text-left hover:bg-accent/50 transition-colors flex items-center justify-between gap-2",
                    c.id === currentCompositeId && "bg-accent/30"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate">
                      {c.title || "Untitled"}
                    </div>
                    {c.preview && (
                      <div className="text-[10px] text-muted-foreground/60 truncate mt-0.5">
                        {c.preview}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[9px] text-muted-foreground/40">{c.messageCount}</span>
                    <span className="text-[9px] text-muted-foreground/40">{timeAgo(c.updatedAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => {
              openPanel("conversations");
              setOpen(false);
            }}
            className="w-full px-3 py-2 text-[10px] text-muted-foreground hover:text-foreground border-t border-border/30 hover:bg-accent/30 transition-colors text-center"
          >
            View all conversations
          </button>
        </div>
      )}
    </div>
  );
}
