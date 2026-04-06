// apps/client/src/components/chat/AudioPlayback.tsx
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface Props {
  audioUrl: string;
  autoPlay?: boolean;
}

export function AudioPlayback({ audioUrl, autoPlay = false }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      el.currentTime = 0;
      setPlaying(false);
    } else {
      el.play()
        .then(() => setBlocked(false))
        .catch(() => setBlocked(true));
      setPlaying(true);
    }
  };

  return (
    <>
      <audio
        ref={audioRef}
        src={audioUrl}
        autoPlay={autoPlay}
        onEnded={() => setPlaying(false)}
        onError={() => setPlaying(false)}
      />
      <button
        onClick={toggle}
        title={blocked ? "Tap to play" : playing ? "Stop" : "Play"}
        className={cn(
          "ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full transition-all",
          playing
            ? "text-primary animate-pulse"
            : "text-muted-foreground/40 hover:text-muted-foreground"
        )}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="none"
        >
          {playing && !blocked ? (
            <rect x="6" y="6" width="12" height="12" rx="1" />
          ) : (
            <path d="M11 5L6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
          )}
        </svg>
      </button>
    </>
  );
}
