import { cn } from "@/lib/utils";
import type { KnowledgeResource } from "@chvor/shared";

interface ResourceCardProps {
  resource: KnowledgeResource;
  onDelete: (id: string) => void;
}

const TYPE_ICONS: Record<string, string> = {
  pdf: "PDF",
  docx: "DOC",
  txt: "TXT",
  markdown: "MD",
  url: "URL",
  image: "IMG",
};

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: "bg-yellow-500/10", text: "text-yellow-500", label: "Pending" },
  processing: { bg: "bg-blue-500/10", text: "text-blue-500", label: "Processing" },
  completed: { bg: "bg-green-500/10", text: "text-green-500", label: "Done" },
  failed: { bg: "bg-red-500/10", text: "text-red-500", label: "Failed" },
};

export function ResourceCard({ resource, onDelete }: ResourceCardProps) {
  const status = STATUS_STYLES[resource.status] ?? STATUS_STYLES.pending;
  const typeLabel = TYPE_ICONS[resource.type] ?? resource.type.toUpperCase();

  return (
    <div className="group flex items-center gap-3 rounded-lg border border-border/30 px-3 py-2.5 transition-colors hover:border-border/60">
      {/* Type badge */}
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
        {typeLabel}
      </span>

      {/* Title + meta */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{resource.title}</p>
        <div className="mt-0.5 flex items-center gap-2">
          <span className={cn("rounded px-1.5 py-0.5 text-[9px] font-medium", status.bg, status.text)}>
            {status.label}
          </span>
          {resource.status === "completed" && (
            <span className="text-[10px] text-muted-foreground">
              {resource.memoryCount} fact{resource.memoryCount !== 1 ? "s" : ""}
            </span>
          )}
          {resource.status === "processing" && (
            <span className="text-[10px] text-muted-foreground animate-pulse">
              extracting...
            </span>
          )}
          {resource.status === "failed" && resource.error && (
            <span className="truncate text-[10px] text-red-400" title={resource.error}>
              {resource.error}
            </span>
          )}
        </div>
      </div>

      {/* Delete button */}
      <button
        onClick={() => onDelete(resource.id)}
        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
        title="Delete resource"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    </div>
  );
}
