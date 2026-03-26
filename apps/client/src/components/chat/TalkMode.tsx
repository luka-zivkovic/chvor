// apps/client/src/components/chat/TalkMode.tsx
import { useEffect, useCallback, useRef } from "react";
import { useVoiceStore } from "@/stores/voice-store";
import { useWebSpeech } from "@/hooks/useWebSpeech";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { cn } from "@/lib/utils";

/** Max retries when Web Speech stops without a result before showing error */
const MAX_LISTEN_RETRIES = 3;
/** If TTS is enabled but no audio arrives in this time, resume listening */
const TTS_TIMEOUT_MS = 10_000;
/** When TTS is off, resume listening after this delay to avoid cutting off the send */
const NO_TTS_RESUME_DELAY_MS = 1_500;

interface Props {
  onSend: (text: string, inputModality: "voice") => void;
}

export function TalkMode({ onSend }: Props) {
  const {
    talkModeActive, talkPhase, setTalkPhase, setTalkModeActive,
    audioUrls, lastPlayedAudioId, setLastPlayedAudioId, ttsMode,
  } = useVoiceStore();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const retryCountRef = useRef(0);
  const ttsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether recognition was previously active — prevents spurious recovery on phase transitions
  const wasListeningRef = useRef(false);

  // Stable refs to avoid stale closures
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const talkModeActiveRef = useRef(talkModeActive);
  talkModeActiveRef.current = talkModeActive;
  const talkPhaseRef = useRef(talkPhase);
  talkPhaseRef.current = talkPhase;
  const ttsModeRef = useRef(ttsMode);
  ttsModeRef.current = ttsMode;

  // Clear TTS timeout helper
  const clearTtsTimeout = useCallback(() => {
    if (ttsTimeoutRef.current) {
      clearTimeout(ttsTimeoutRef.current);
      ttsTimeoutRef.current = null;
    }
  }, []);

  const resumeListening = useCallback(() => {
    clearTtsTimeout();
    retryCountRef.current = 0;
    setTalkPhase("listening");
  }, [setTalkPhase, clearTtsTimeout]);

  const sendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSpeechResult = useCallback((text: string) => {
    if (!talkModeActiveRef.current || !text.trim()) return;
    retryCountRef.current = 0;
    clearTtsTimeout();
    if (sendingTimerRef.current) clearTimeout(sendingTimerRef.current);
    setTalkPhase("sending");
    // Brief "Sending..." flash before thinking
    sendingTimerRef.current = setTimeout(() => {
      sendingTimerRef.current = null;
      if (talkModeActiveRef.current) setTalkPhase("thinking");
    }, 500);
    onSendRef.current(text, "voice");

    // If TTS is off, skip waiting for audio — resume listening after a short delay
    if (ttsModeRef.current === "off") {
      setTimeout(() => {
        if (talkModeActiveRef.current && talkPhaseRef.current === "thinking") {
          resumeListening();
        }
      }, NO_TTS_RESUME_DELAY_MS);
    } else {
      // TTS is on — set a safety timeout in case audio never arrives
      ttsTimeoutRef.current = setTimeout(() => {
        if (talkModeActiveRef.current && talkPhaseRef.current === "thinking") {
          resumeListening();
        }
      }, TTS_TIMEOUT_MS);
    }
  }, [setTalkPhase, clearTtsTimeout, resumeListening]);

  // TalkMode uses single-shot (continuous: false) so it auto-sends after each phrase
  const webSpeech = useWebSpeech(handleSpeechResult);
  const recorder = useVoiceRecorder();

  const webSpeechRef = useRef(webSpeech);
  webSpeechRef.current = webSpeech;
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  const startListening = useCallback(() => {
    if (webSpeechRef.current.isSupported) {
      webSpeechRef.current.start();
    } else {
      recorderRef.current.start();
    }
  }, []);

  const stopListening = useCallback(() => {
    webSpeechRef.current.stop();
    // Also stop recorder if it's active (fallback path)
    if (recorderRef.current.isRecording) {
      recorderRef.current.stop();
    }
  }, []);

  // Track isListening transitions for recovery logic
  useEffect(() => {
    if (webSpeech.isListening) {
      wasListeningRef.current = true;
      retryCountRef.current = 0;
    }
  }, [webSpeech.isListening]);

  // Start listening when Talk Mode activates or phase transitions to "listening"
  // Note: does NOT depend on webSpeech.isListening — recovery is handled by the next effect
  useEffect(() => {
    if (!talkModeActive || talkPhase !== "listening") return;
    startListening();
  }, [talkModeActive, talkPhase, startListening]);

  // Auto-recovery: when Web Speech was active but stopped while still in "listening" phase
  useEffect(() => {
    if (!talkModeActive || talkPhase !== "listening") return;
    if (webSpeech.isListening || !wasListeningRef.current) return;
    if (!webSpeech.isSupported) return; // MediaRecorder path, handled separately

    // Recognition was active and stopped — schedule retry
    wasListeningRef.current = false;
    const timer = setTimeout(() => {
      if (!talkModeActiveRef.current || talkPhaseRef.current !== "listening") return;
      if (retryCountRef.current >= MAX_LISTEN_RETRIES) {
        setTalkPhase("idle");
        return;
      }
      retryCountRef.current++;
      startListening();
    }, 600);
    return () => clearTimeout(timer);
  }, [talkModeActive, talkPhase, webSpeech.isListening, webSpeech.isSupported, startListening, setTalkPhase]);

  // Auto-play latest audio URL (only if not already played)
  useEffect(() => {
    const entries = Object.entries(audioUrls);
    if (entries.length === 0 || !talkModeActive || !audioRef.current) return;
    const [latestId, latestUrl] = entries[entries.length - 1];
    if (latestId === lastPlayedAudioId) return;
    setLastPlayedAudioId(latestId);
    clearTtsTimeout();
    const el = audioRef.current;
    el.pause();
    el.currentTime = 0;
    el.src = latestUrl;
    el.play().catch(() => {});
    setTalkPhase("speaking");
  }, [audioUrls, talkModeActive, lastPlayedAudioId, setLastPlayedAudioId, setTalkPhase, clearTtsTimeout]);

  const handleAudioEnd = useCallback(() => {
    if (talkModeActiveRef.current) {
      resumeListening();
    }
  }, [resumeListening]);

  // MediaRecorder fallback: handle transcription result when recorder stops
  const handleRecorderSend = useCallback(async () => {
    if (!recorderRef.current.isRecording) return;
    const text = await recorderRef.current.stop();
    if (text) handleSpeechResult(text);
  }, [handleSpeechResult]);

  // Escape to exit
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && talkModeActiveRef.current) {
        setTalkModeActive(false);
        stopListening();
        clearTtsTimeout();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [setTalkModeActive, stopListening, clearTtsTimeout]);

  // Cleanup on unmount / deactivation
  useEffect(() => {
    return () => {
      clearTtsTimeout();
      if (sendingTimerRef.current) clearTimeout(sendingTimerRef.current);
    };
  }, [clearTtsTimeout]);

  if (!talkModeActive) return null;

  const isRecorderFallback = !webSpeech.isSupported;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm">
      <audio ref={audioRef} onEnded={handleAudioEnd} />

      {/* Phase indicator */}
      <div className="mb-8 text-center">
        <div
          className={cn(
            "mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-full transition-all duration-500",
            talkPhase === "listening" && "bg-primary/20 animate-pulse",
            talkPhase === "sending" && "bg-green-500/20",
            talkPhase === "thinking" && "bg-yellow-500/20 animate-bounce",
            talkPhase === "speaking" && "bg-green-500/20 animate-pulse",
            talkPhase === "idle" && "bg-muted/20"
          )}
        >
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={cn(
              talkPhase === "listening" && "text-primary",
              talkPhase === "sending" && "text-green-400",
              talkPhase === "thinking" && "text-yellow-400",
              talkPhase === "speaking" && "text-green-400",
              talkPhase === "idle" && "text-muted-foreground"
            )}
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="22" />
          </svg>
        </div>

        <p className="text-sm text-muted-foreground">
          {talkPhase === "listening" && (isRecorderFallback && recorder.isRecording ? "Recording..." : "Listening...")}
          {talkPhase === "sending" && "Sending..."}
          {talkPhase === "thinking" && "Thinking..."}
          {talkPhase === "speaking" && "Speaking..."}
          {talkPhase === "idle" && "Listening stopped. Tap to retry."}
        </p>

        {webSpeech.transcript && talkPhase === "listening" && (
          <p className="mt-2 max-w-md text-sm text-foreground/70">{webSpeech.transcript}</p>
        )}
      </div>

      {/* Recorder fallback: tap to send */}
      {isRecorderFallback && recorder.isRecording && talkPhase === "listening" && (
        <button
          onClick={handleRecorderSend}
          className="mb-4 rounded-full bg-primary px-6 py-2 text-sm text-primary-foreground hover:opacity-90 transition-colors"
        >
          Tap to Send
        </button>
      )}

      {/* Retry button when idle (retries exhausted) */}
      {talkPhase === "idle" && (
        <button
          onClick={() => {
            retryCountRef.current = 0;
            setTalkPhase("listening");
          }}
          className="mb-4 rounded-full bg-primary px-6 py-2 text-sm text-primary-foreground hover:opacity-90 transition-colors"
        >
          Try Again
        </button>
      )}

      {/* Exit button */}
      <button
        onClick={() => {
          setTalkModeActive(false);
          stopListening();
          clearTtsTimeout();
        }}
        className="rounded-full border border-border/50 px-6 py-2 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
      >
        Exit Talk Mode (Esc)
      </button>
    </div>
  );
}
