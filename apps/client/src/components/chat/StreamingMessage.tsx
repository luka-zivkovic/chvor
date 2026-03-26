import type { MediaArtifact } from "@chvor/shared";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { prettifyToolName, sanitizeMessageContent } from "@/lib/chat-utils";

interface StreamingTool {
  name: string;
  status: "running" | "done";
  result?: string;
  media?: MediaArtifact[];
}

interface Props {
  content: string | null;
  tools: StreamingTool[];
}

export function StreamingMessage({ content, tools }: Props) {
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-1.5 mb-1">
        <img src="/bot-avatar-512.png" alt="Chvor" className="h-4 w-4 shrink-0 rounded-full" />
        <span className="text-[10px] font-medium text-muted-foreground">
          Chvor
        </span>
      </div>

      {/* Tool indicators */}
      {tools.length > 0 && (
        <div className="ml-5 mb-2 flex flex-col gap-1">
          {tools.map((tool) => (
            <div key={tool.name}>
              <div className="flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor: tool.status === "done"
                      ? "var(--status-completed)"
                      : "var(--status-running)",
                  }}
                />
                <span className="font-mono text-[10px] text-muted-foreground">
                  {prettifyToolName(tool.name)}
                </span>
                {tool.status === "running" && (
                  <span className="text-[10px] text-muted-foreground/50 animate-pulse">running...</span>
                )}
              </div>
              {tool.media?.filter((m) => m.mediaType === "image").map((m) => (
                <img
                  key={m.id}
                  src={m.url}
                  alt={m.filename ?? ""}
                  className="mt-1 ml-3 max-w-[120px] max-h-[80px] rounded border border-border/30 object-cover"
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Streaming text content */}
      <div
        className="ml-5 border-l-2 pl-3 py-1"
        style={{ borderColor: "var(--border)" }}
      >
        {content ? (
          <MarkdownRenderer content={sanitizeMessageContent(content)} />
        ) : tools.length === 0 ? (
          <span className="text-sm text-muted-foreground/50">...</span>
        ) : null}
        {/* Blinking cursor */}
        <span className="inline-block w-[2px] h-[14px] bg-primary/60 align-text-bottom animate-pulse ml-0.5" />
      </div>
    </div>
  );
}
