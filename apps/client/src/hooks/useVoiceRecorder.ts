// apps/client/src/hooks/useVoiceRecorder.ts
import { useState, useCallback, useRef, useEffect } from "react";

interface UseVoiceRecorderReturn {
  isRecording: boolean;
  start: () => Promise<void>;
  stop: () => Promise<string | null>;
  error: string | null;
}

export function useVoiceRecorder(): UseVoiceRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setError("Microphone access denied");
    }
  }, []);

  const stop = useCallback(async (): Promise<string | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return null;

    return new Promise((resolve) => {
      recorder.onstop = async () => {
        setIsRecording(false);
        recorder.stream.getTracks().forEach((t) => t.stop());

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (blob.size === 0) {
          resolve(null);
          return;
        }

        try {
          const form = new FormData();
          form.append("audio", blob, "recording.webm");
          form.append("format", "webm");

          const res = await fetch("/api/voice/transcribe", {
            method: "POST",
            body: form,
            credentials: "same-origin",
          });

          if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            const code = json.code ? `[${json.code}] ` : "";
            setError(code + (json.error ?? "Transcription failed"));
            resolve(null);
            return;
          }

          const json = await res.json();
          resolve(json.text ?? null);
        } catch (err) {
          setError("Couldn't transcribe audio. Try again or type instead.");
          resolve(null);
        }
      };

      recorder.stop();
    });
  }, []);

  // Stop media tracks on unmount to release the microphone
  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      recorder?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return { isRecording, start, stop, error };
}
