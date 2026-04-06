import { MarkdownRenderer } from "./MarkdownRenderer";
import { prettifyToolName, sanitizeMessageContent } from "@/lib/chat-utils";
import { useAppStore } from "@/stores/app-store";
import type { StreamingTool } from "@/stores/app-store";

interface Props {
  content: string | null;
  tools: StreamingTool[];
}

export function StreamingMessage({ content, tools }: Props) {
  const decisionReason = useAppStore((s) => s.streamingDecisionReason);

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
          {/* Decision reasoning — WHY the AI chose this tool */}
          {decisionReason && (
            <p className="text-[10px] text-muted-foreground/50 italic mb-0.5">
              {decisionReason}
            </p>
          )}
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
              {tool.media?.filter((m) => m.mediaType === "image" && !m.internal).map((m) => (
                <img
                  key={m.id}
                  src={m.url}
                  alt={m.filename ?? ""}
                  className="mt-1 ml-3 max-w-[120px] max-h-[80px] rounded border border-border/30 object-cover"
                />
              ))}
            </div>
          ))}

          {/* Processing spinner — visible when any tool is still running */}
          {tools.some((t) => t.status === "running") && (
            <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/60">
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span>Processing…</span>
            </div>
          )}
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
