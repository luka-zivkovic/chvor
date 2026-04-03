import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { MicButton } from "./MicButton";
import { useUIStore } from "@/stores/ui-store";
import type { MediaArtifact } from "@chvor/shared";

interface Props {
  onSend: (text: string, inputModality?: "voice", media?: MediaArtifact[]) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
}

export function ChatInput({ onSend, onStop, disabled, isStreaming }: Props) {
  const [input, setInput] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [pendingMedia, setPendingMedia] = useState<MediaArtifact[]>([]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openSettings = useUIStore((s) => s.openSettings);

  const showStop = isStreaming && !input.trim() && !pendingMedia.length;

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text && !pendingMedia.length) return;
    onSend(text || (pendingMedia.length ? "What is this?" : ""), undefined, pendingMedia.length ? pendingMedia : undefined);
    setInput("");
    setPendingMedia([]);
  }, [input, pendingMedia, onSend]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(true);
    try {
      const artifacts: MediaArtifact[] = [];
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/media/upload", { method: "POST", body: formData });
        if (res.ok) {
          const artifact = (await res.json()) as MediaArtifact;
          artifacts.push(artifact);
        }
      }
      if (artifacts.length) setPendingMedia((prev) => [...prev, ...artifacts]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const removePendingMedia = useCallback((id: string) => {
    setPendingMedia((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const handleButtonClick = useCallback(() => {
    if (showStop) {
      onStop?.();
    } else {
      handleSend();
    }
  }, [showStop, onStop, handleSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming && !input.trim()) {
          onStop?.();
        } else {
          handleSend();
        }
      }
    },
    [isStreaming, input, onStop, handleSend]
  );

  const handleVoiceTranscript = useCallback((text: string) => {
    setInput(text);
  }, []);

  const handleVoiceError = useCallback((error: string) => {
    setVoiceError(error);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setVoiceError(null), 6000);
  }, []);

  const handleOpenCredentials = useCallback(() => {
    openSettings("connections");
    setVoiceError(null);
  }, [openSettings]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [input]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  const needsCredential = voiceError?.includes("[STT_NO_CREDENTIAL]") || voiceError?.includes("API key") || voiceError?.includes("Credentials");

  return (
    <div className="relative">
      {voiceError && (
        <div className="absolute -top-9 left-0 right-0 z-10 flex items-center gap-1.5 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-1.5">
          <span className="flex-1 text-[11px] text-destructive">{voiceError}</span>
          {needsCredential && (
            <button
              onClick={handleOpenCredentials}
              className="shrink-0 text-[11px] font-medium text-primary underline underline-offset-2 hover:opacity-80"
            >
              Open Settings
            </button>
          )}
          <button
            onClick={() => setVoiceError(null)}
            className="shrink-0 text-destructive/50 hover:text-destructive"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      {/* Pending media preview */}
      {pendingMedia.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2.5 pt-2 pb-0.5 rounded-t-xl" style={{ background: "var(--glass-bg)", borderTop: "1px solid var(--glass-border)", borderLeft: "1px solid var(--glass-border)", borderRight: "1px solid var(--glass-border)" }}>
          {pendingMedia.map((m) => (
            <div key={m.id} className="relative group">
              {m.mediaType === "image" ? (
                <img src={m.url} alt={m.filename ?? ""} className="h-14 w-14 rounded-md object-cover border border-border/30" />
              ) : (
                <div className="h-14 w-14 rounded-md border border-border/30 flex items-center justify-center bg-muted/30 text-[10px] text-muted-foreground">
                  {m.mediaType === "video" ? "VID" : "FILE"}
                </div>
              )}
              <button
                onClick={() => removePendingMedia(m.id)}
                className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className={cn("flex items-end gap-2 rounded-xl p-2.5 transition-all focus-within:border-primary/40", pendingMedia.length > 0 && "rounded-t-none border-t-0")}
        style={{
          background: "var(--glass-bg)",
          border: "1px solid var(--glass-border)",
          ...(pendingMedia.length > 0 ? { borderTop: "none" } : {}),
        }}
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
        {/* Attachment button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all text-muted-foreground/50 hover:text-muted-foreground",
            uploading && "animate-pulse"
          )}
          title="Attach image or video"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={disabled ? "Connecting..." : pendingMedia.length ? "Add a message..." : "Message Chvor..."}
          rows={1}
          className={cn(
            "min-h-0 flex-1 resize-none border-none bg-transparent px-1 py-1 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none",
            disabled && "cursor-not-allowed opacity-50"
          )}
        />
        <MicButton
          onTranscript={handleVoiceTranscript}
          onError={handleVoiceError}
          disabled={disabled}
        />
        <button
          onClick={handleButtonClick}
          disabled={disabled || (!showStop && !input.trim() && !pendingMedia.length)}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all",
            showStop
              ? "bg-destructive text-destructive-foreground shadow-sm hover:opacity-90"
              : (input.trim() || pendingMedia.length)
                ? "bg-primary text-primary-foreground shadow-sm hover:opacity-90"
                : "text-muted-foreground/30"
          )}
        >
          {showStop ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 2L11 13" />
              <path d="M22 2L15 22L11 13L2 9L22 2Z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
