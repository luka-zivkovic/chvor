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
  const cancelledRef = useRef(false);

  const start = useCallback(async () => {
    setError(null);
    cancelledRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // If stop() was called before getUserMedia resolved, release immediately
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // Pick best supported MIME type
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250); // timeslice ensures chunks accumulate during recording
      setIsRecording(true);
    } catch (err) {
      const msg = err instanceof Error && err.name === "NotSupportedError"
        ? "Audio recording not supported in this browser"
        : "Microphone access denied";
      setError(msg);
    }
  }, []);

  const stop = useCallback(async (): Promise<string | null> => {
    cancelledRef.current = true;
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return null;

    return new Promise((resolve) => {
      recorder.onstop = async () => {
        setIsRecording(false);
        recorder.stream.getTracks().forEach((t) => t.stop());

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size === 0) {
          resolve(null);
          return;
        }

        try {
          const form = new FormData();
          const ext = recorder.mimeType?.includes("mp4") ? "mp4" : "webm";
          form.append("audio", blob, `recording.${ext}`);
          form.append("format", ext);

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
      if (recorder) {
        // Detach onstop to prevent state updates / fetch on unmounted component
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
        recorder.stream.getTracks().forEach((t) => t.stop());
      }
      cancelledRef.current = true;
    };
  }, []);

  return { isRecording, start, stop, error };
}
