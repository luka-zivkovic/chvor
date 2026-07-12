import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryBlockRecord } from "@chvor/shared";
import { Button } from "@/components/ui/button";
import { MemoryBlockMetadata } from "./MemoryBlockMetadata";
import { errorMessage, prettyJson, sameDocument } from "./memory-block-utils";
import { memoryBlocksApi } from "./types";

const HISTORY_PAGE_SIZE = 10;

export function MemoryBlockHistory({
  current,
  refreshKey,
  actionsDisabled,
  onRequestRestore,
}: {
  current: MemoryBlockRecord;
  refreshKey: number;
  actionsDisabled: boolean;
  onRequestRestore: (revision: number, undo: boolean) => void;
}) {
  const [revisions, setRevisions] = useState<MemoryBlockRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemoryBlockRecord | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(
    async (cursor?: string) => {
      const request = ++requestSequence.current;
      setLoading(true);
      setError(null);
      try {
        const page = await memoryBlocksApi.revisions(current.id, {
          limit: HISTORY_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        if (request !== requestSequence.current) return;
        setRevisions((existing) => (cursor ? [...existing, ...page.revisions] : page.revisions));
        setNextCursor(page.nextCursor);
        if (!cursor) setSelected(null);
      } catch (loadError) {
        if (request !== requestSequence.current) return;
        setError(errorMessage(loadError, "Could not load immutable history."));
      } finally {
        if (request === requestSequence.current) setLoading(false);
      }
    },
    [current.id]
  );

  useEffect(() => {
    requestSequence.current += 1;
    setRevisions([]);
    setNextCursor(null);
    setSelected(null);
    setError(null);
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load, refreshKey]);

  return (
    <section aria-labelledby="memory-history-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="memory-history-heading" className="text-xs font-semibold text-foreground">
            Immutable history
          </h3>
          <p className="text-[10px] text-muted-foreground">Newest revision first</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled || current.revision <= 1}
          title={actionsDisabled ? "Save or discard the correction draft first" : undefined}
          onClick={() => onRequestRestore(current.revision - 1, true)}
        >
          Undo previous revision
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {loading && revisions.length === 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading history…
        </p>
      )}

      <div className="space-y-2">
        {revisions.map((record) => (
          <article key={record.revision} className="rounded-lg border border-border/60 p-3">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-foreground">
                  Revision {record.revision} · {record.operation}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {record.updatedAt}
                  {record.restoredFromRevision !== null
                    ? ` · restored from revision ${record.restoredFromRevision}`
                    : ""}
                </p>
              </div>
              <div className="flex gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(record)}>
                  Compare full revision
                </Button>
                {record.revision < current.revision && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={actionsDisabled}
                    title={
                      actionsDisabled ? "Save or discard the correction draft first" : undefined
                    }
                    onClick={() => onRequestRestore(record.revision, false)}
                  >
                    Restore
                  </Button>
                )}
              </div>
            </div>
            <MemoryBlockMetadata record={record} />
          </article>
        ))}
      </div>

      {nextCursor && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={loading}
          onClick={() => void load(nextCursor)}
        >
          {loading ? "Loading…" : "Load older revisions"}
        </Button>
      )}

      {selected && (
        <section
          aria-label={`Revision ${selected.revision} comparison`}
          className="rounded-lg border border-primary/30 bg-primary/5 p-3"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-foreground">
              Revision {selected.revision} vs current revision {current.revision}
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(null)}>
              Close comparison
            </Button>
          </div>
          <p className="mb-3 text-[10px] text-muted-foreground">
            Full snapshots are{" "}
            {sameDocument(selected.document, current.document) ? "identical" : "different"}.
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <p className="mb-1 text-[10px] font-medium text-foreground">Selected full revision</p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[9px]">
                {prettyJson(selected.document)}
              </pre>
            </div>
            <div>
              <p className="mb-1 text-[10px] font-medium text-foreground">Current full revision</p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[9px]">
                {prettyJson(current.document)}
              </pre>
            </div>
          </div>
        </section>
      )}
    </section>
  );
}
