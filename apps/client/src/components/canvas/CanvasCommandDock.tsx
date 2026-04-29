import { useCallback, useRef, useState } from "react";
import { useAppStore } from "../../stores/app-store";
import { useUIStore } from "../../stores/ui-store";
import { cn } from "@/lib/utils";

export function CanvasCommandDock() {
  const sendChat = useAppStore((s) => s._sendChat);
  const connected = useAppStore((s) => s.connected);
  const chatCollapsed = useUIStore((s) => s.chatCollapsed);
  const toggleChat = useUIStore((s) => s.toggleChat);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const send = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !connected) return;
    sendChat(trimmed);
    setText("");
  }, [connected, sendChat, text]);

  if (!chatCollapsed) return null;

  return (
    <div className="pointer-events-none absolute bottom-5 left-1/2 z-20 w-[min(620px,calc(100vw-2rem))] -translate-x-1/2">
      <div
        className="pointer-events-auto flex items-center gap-2 rounded-2xl border px-3 py-2 shadow-2xl backdrop-blur-xl"
        style={{
          background: "linear-gradient(145deg, oklch(0.14 0.006 285 / 0.88), oklch(0.10 0.004 285 / 0.72))",
          borderColor: "oklch(0.62 0.13 250 / 0.28)",
          boxShadow: "0 0 42px oklch(0.62 0.13 250 / 0.16), inset 0 1px 0 oklch(1 0 0 / 0.07)",
        }}
      >
        <div className="hidden rounded-full border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/35 sm:block">
          canvas input
        </div>
        <input
          ref={inputRef}
          value={text}
          disabled={!connected}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          placeholder={connected ? "Ask from the canvas…" : "Connecting…"}
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm text-white outline-none placeholder:text-white/35"
        />
        <button
          type="button"
          onClick={toggleChat}
          className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/55 transition hover:bg-white/8 hover:text-white"
        >
          Chat
        </button>
        <button
          type="button"
          onClick={send}
          disabled={!connected || !text.trim()}
          className={cn(
            "rounded-full px-3 py-1.5 text-xs font-medium transition",
            text.trim() && connected
              ? "bg-primary text-primary-foreground hover:opacity-90"
              : "bg-white/5 text-white/25"
          )}
        >
          Send
        </button>
      </div>
    </div>
  );
}
