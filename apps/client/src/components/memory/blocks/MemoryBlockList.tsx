import type { MemoryBlockRecord } from "@chvor/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MemoryBlockMetadata } from "./MemoryBlockMetadata";

export function MemoryBlockList({
  records,
  selectedId,
  loading,
  nextCursor,
  onSelect,
  onLoadMore,
}: {
  records: MemoryBlockRecord[];
  selectedId: string | null;
  loading: boolean;
  nextCursor: string | null;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
}) {
  return (
    <div className="space-y-2">
      {records.length === 0 && !loading ? (
        <div className="rounded-lg border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
          No stable beliefs match these filters on the loaded pages.
        </div>
      ) : (
        <div className="space-y-2" aria-label="Stable belief blocks">
          {records.map((record) => (
          <button
            key={record.id}
            type="button"
            aria-pressed={record.id === selectedId}
            onClick={() => onSelect(record.id)}
            className={cn(
              "w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              record.id === selectedId
                ? "border-primary/60 bg-primary/5"
                : "border-border/60 bg-card hover:bg-muted/20"
            )}
          >
            <p className="break-words text-xs font-semibold text-foreground">
              {record.document.label}
            </p>
            {record.document.description !== null && (
              <p className="mt-1 line-clamp-2 break-words text-[10px] text-muted-foreground">
                {record.document.description}
              </p>
            )}
            <div className="mt-3">
              <MemoryBlockMetadata record={record} compact />
            </div>
          </button>
          ))}
        </div>
      )}
      {nextCursor && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={loading}
          onClick={onLoadMore}
        >
          {loading ? "Loading…" : "Load more blocks"}
        </Button>
      )}
    </div>
  );
}
