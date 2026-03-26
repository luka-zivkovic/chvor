import type { MediaArtifact } from "@chvor/shared";

interface Props {
  media: MediaArtifact[];
}

export function MediaRenderer({ media }: Props) {
  if (!media.length) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {media.map((m) => {
        switch (m.mediaType) {
          case "image":
            return (
              <div key={m.id} className="group relative inline-block">
                <img
                  src={m.url}
                  alt={m.filename ?? "Generated image"}
                  className="max-w-[300px] max-h-[300px] rounded-lg border border-border/50 object-cover"
                />
                <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <a
                    href={m.url}
                    download={m.filename ?? "image.png"}
                    className="rounded-md p-1.5 backdrop-blur-sm text-foreground/70 hover:text-foreground transition-colors"
                    style={{ background: "var(--glass-bg)", border: "1px solid var(--glass-border)" }}
                    title="Download"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </a>
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md p-1.5 backdrop-blur-sm text-foreground/70 hover:text-foreground transition-colors"
                    style={{ background: "var(--glass-bg)", border: "1px solid var(--glass-border)" }}
                    title="Open in new tab"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                </div>
              </div>
            );
          case "audio":
            return (
              <audio key={m.id} controls src={m.url} className="max-w-full" />
            );
          case "video":
            return (
              <video
                key={m.id}
                controls
                src={m.url}
                className="max-w-[400px] rounded-lg border border-border/50"
              />
            );
          case "file":
            return (
              <a
                key={m.id}
                href={m.url}
                download={m.filename}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
                style={{ background: "var(--glass-bg)", border: "1px solid var(--glass-border)" }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {m.filename ?? "Download"}
                {m.sizeBytes != null && (
                  <span className="text-muted-foreground/50">
                    ({m.sizeBytes < 1024 ? `${m.sizeBytes}B` : `${Math.round(m.sizeBytes / 1024)}KB`})
                  </span>
                )}
              </a>
            );
        }
      })}
    </div>
  );
}
