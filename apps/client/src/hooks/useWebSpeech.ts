// apps/client/src/hooks/useWebSpeech.ts
import { useState, useCallback, useRef, useEffect } from "react";

const SPEECH_ERROR_MAP: Record<string, string> = {
  "no-speech": "No speech detected. Try again.",
  "audio-capture": "Microphone not available.",
  "not-allowed": "Microphone access denied.",
  network: "Network error during speech recognition.",
  aborted: "Speech recognition was cancelled.",
  "service-not-available": "Speech recognition service unavailable.",
};

const getSpeechRecognition = (): (new () => any) | null => {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
};

export interface UseWebSpeechOptions {
  lang?: string;
  /** When true, recognition stays active until stop() is called. Default: false. */
  continuous?: boolean;
}

interface UseWebSpeechReturn {
  isListening: boolean;
  transcript: string;
  isSupported: boolean;
  start: () => void;
  stop: () => void;
  error: string | null;
}

export function useWebSpeech(
  onResult?: (text: string) => void,
  options?: UseWebSpeechOptions,
): UseWebSpeechReturn {
  const continuous = options?.continuous ?? false;
  const lang = options?.lang;

  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  // Generation counter: prevents stale onend/onerror/onresult from aborted instances
  const generationRef = useRef(0);
  // Accumulates final transcript segments in continuous mode
  const finalTextRef = useRef("");
  // Ref to onResult so the recognition callbacks always see the latest without re-creating
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const isSupported = getSpeechRecognition() !== null;

  const start = useCallback(() => {
    if (!isSupported) {
      setError("Speech recognition not supported");
      return;
    }

    // Stop any previous instance
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* already stopped */ }
    }

    setError(null);
    setTranscript("");
    finalTextRef.current = "";
    const gen = ++generationRef.current;

    const SpeechRecognitionCtor = getSpeechRecognition();
    if (!SpeechRecognitionCtor) { setError("Not supported"); return; }
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = continuous;
    recognition.interimResults = true;
    recognition.lang = lang ?? navigator.language ?? "en-US";

    recognition.onresult = (event: any) => {
      if (generationRef.current !== gen) return;
      if (continuous) {
        // Only process new results since last event (avoids O(n²) re-scan)
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalTextRef.current += event.results[i][0].transcript;
          }
        }
        // Show final + current interim for live display
        const last = event.results[event.results.length - 1];
        const interim = last.isFinal ? "" : last[0].transcript;
        setTranscript(finalTextRef.current + interim);
      } else {
        // Original single-shot behavior
        let text = "";
        for (let i = 0; i < event.results.length; i++) {
          text += event.results[i][0].transcript;
        }
        setTranscript(text);

        if (event.results[event.results.length - 1].isFinal) {
          onResultRef.current?.(text);
          setIsListening(false);
        }
      }
    };

    recognition.onerror = (event: any) => {
      if (generationRef.current !== gen) return;
      // In continuous mode, "no-speech" is recoverable — don't kill the session
      if (continuous && event.error === "no-speech") return;
      setError(SPEECH_ERROR_MAP[event.error] ?? event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      if (generationRef.current !== gen) return;
      if (continuous) {
        // Microtask delay: on some browsers onend fires before the final onresult
        Promise.resolve().then(() => {
          if (generationRef.current !== gen) return;
          const text = finalTextRef.current.trim();
          if (text) onResultRef.current?.(text);
          setIsListening(false);
        });
        return;
      }
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isSupported, continuous, lang]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    // Don't setIsListening(false) here — let onend handle it
    // so the transcript delivery in continuous mode completes first
  }, []);

  // Cleanup on unmount — abort any active recognition instance
  useEffect(() => {
    return () => {
      try { recognitionRef.current?.abort(); } catch { /* cleanup */ }
    };
  }, []);

  return { isListening, transcript, isSupported, start, stop, error };
}
