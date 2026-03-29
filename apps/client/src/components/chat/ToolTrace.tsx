import { useState } from "react";
import type { ToolTraceEntry } from "@/stores/app-store";
import { prettifyToolName } from "@/lib/chat-utils";

function StatusDot({ status }: { status: ToolTraceEntry["status"] }) {
  const color =
    status === "completed" ? "var(--status-completed)" :
    status === "failed" ? "var(--status-failed)" :
    "var(--status-running)";
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${status === "running" ? "animate-pulse" : ""}`}
      style={{ background: color }}
    />
  );
}

function TraceRow({ entry }: { entry: ToolTraceEntry }) {
  const [showOutput, setShowOutput] = useState(false);
  const hasOutput = entry.output || entry.error;

  return (
    <div className="rounded-md border border-border/20 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <StatusDot status={entry.status} />
        <span className="font-mono text-[10px] text-muted-foreground">
          {prettifyToolName(entry.name)}
        </span>
        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/30">
          {entry.status}
        </span>
        {hasOutput && (
          <button
            onClick={() => setShowOutput(!showOutput)}
            className="shrink-0 text-[9px] text-primary/50 hover:text-primary transition-colors"
          >
            {showOutput ? "hide" : "output"}
          </button>
        )}
      </div>
      {entry.reason && (
        <p className="mt-0.5 text-[9px] text-muted-foreground/40 italic">
          {entry.reason}
        </p>
      )}
      {showOutput && entry.output && (
        <pre className="mt-1 max-h-24 overflow-auto rounded bg-background/50 p-1.5 text-[9px] text-muted-foreground/50 font-mono whitespace-pre-wrap break-all">
          {entry.output}{entry.truncated && <span className="text-muted-foreground/30"> …(truncated)</span>}
        </pre>
      )}
      {showOutput && entry.error && (
        <pre className="mt-1 rounded bg-destructive/5 p-1.5 text-[9px] text-destructive/70 font-mono whitespace-pre-wrap break-all">
          {entry.error}
        </pre>
      )}
    </div>
  );
}

export function ToolTrace({ tools }: { tools: ToolTraceEntry[] }) {
  const [expanded, setExpanded] = useState(false);

  if (tools.length === 0) return null;

  const failed = tools.filter((t) => t.status === "failed").length;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground/60"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="font-mono">
          {tools.length} tool{tools.length === 1 ? "" : "s"} used
        </span>
        {failed > 0 && (
          <span className="text-destructive/50">
            ({failed} failed)
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1 pl-4">
          {tools.map((tool, i) => (
            <TraceRow key={`${tool.name}-${i}`} entry={tool} />
          ))}
        </div>
      )}
    </div>
  );
}
