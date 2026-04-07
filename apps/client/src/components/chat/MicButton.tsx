// apps/client/src/components/chat/MicButton.tsx
import { useCallback, useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useWebSpeech } from "@/hooks/useWebSpeech";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";

interface Props {
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
  disabled?: boolean;
}

/** Cached STT status from server; invalidated on credential changes or after TTL. */
let sttStatusCache: { available: boolean; needsCredential: string | null; expiresAt: number } | null = null;

async function checkSttStatus(): Promise<{ available: boolean; needsCredential: string | null }> {
  if (sttStatusCache && Date.now() < sttStatusCache.expiresAt) return sttStatusCache;
  try {
    const res = await fetch("/api/voice/status", { credentials: "same-origin" });
    if (!res.ok) return { available: false, needsCredential: null };
    const json = await res.json();
    const whisperApi = json.stt?.alternatives?.find((a: any) => a.id === "whisper-api");
    const whisperLocal = json.stt?.alternatives?.find((a: any) => a.id === "whisper-local");
    const available = whisperApi?.available || whisperLocal?.available || false;
    const needsCredential = !available ? (whisperApi?.needsCredential ?? "openai") : null;
    sttStatusCache = { available, needsCredential, expiresAt: Date.now() + 60_000 };
    return sttStatusCache;
  } catch {
    // Fail closed: don't cache failures, let user retry
    return { available: false, needsCredential: null };
  }
}

/** Invalidate the cached status (call when credentials change). */
export function invalidateSttStatus() {
  sttStatusCache = null;
}

export function MicButton({ onTranscript, onError, disabled }: Props) {
  const [usingFallback, setUsingFallback] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const webSpeech = useWebSpeech(
    (text) => { onTranscript(text); },
    { continuous: true },
  );

  const recorder = useVoiceRecorder();
  const isActive = webSpeech.isListening || recorder.isRecording;

  // Surface errors from both hooks
  const hookError = usingFallback ? recorder.error : webSpeech.error;
  useEffect(() => {
    if (hookError) onErrorRef.current?.(hookError);
  }, [hookError]);

  const handleClick = useCallback(async () => {
    if (isActive) {
      if (usingFallback) {
        const text = await recorder.stop();
        if (text) onTranscript(text);
      } else {
        webSpeech.stop();
      }
      return;
    }

    if (webSpeech.isSupported) {
      webSpeech.start();
      setUsingFallback(false);
    } else {
      // Pre-flight: check if server-side STT is available before recording
      const status = await checkSttStatus();
      if (!status.available) {
        const msg = status.needsCredential
          ? "Voice input requires an OpenAI API key. Set up in Settings → Credentials."
          : "Speech-to-text is not configured. Check Settings → Voice.";
        onError?.(msg);
        return;
      }
      await recorder.start();
      setUsingFallback(true);
    }
  }, [isActive, usingFallback, webSpeech, recorder, onTranscript, onError]);

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      title={isActive ? "Stop recording" : "Start voice input"}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all",
        isActive
          ? "bg-red-500/20 text-red-400 animate-pulse"
          : "text-muted-foreground/50 hover:text-muted-foreground"
      )}
    >
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
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
    </button>
  );
}
