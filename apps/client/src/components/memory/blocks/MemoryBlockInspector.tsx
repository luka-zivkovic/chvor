import { useEffect, useState } from "react";
import type { MemoryBlockDocumentV1, MemoryBlockRecord } from "@chvor/shared";
import { Button } from "@/components/ui/button";
import { ConfirmMemoryActionDialog } from "./ConfirmMemoryActionDialog";
import { MemoryBlockEditor } from "./MemoryBlockEditor";
import { MemoryBlockHistory } from "./MemoryBlockHistory";
import { MemoryBlockMetadata } from "./MemoryBlockMetadata";
import { canonicalNow, errorMessage, prettyJson } from "./memory-block-utils";
import type { ConflictInfo, MutationResult } from "./types";

interface PendingRestore {
  revision: number;
  undo: boolean;
}

export function MemoryBlockInspector({
  record,
  loading,
  error,
  conflict,
  editorResetKey,
  historyRefreshKey,
  onClearConflict,
  onRetryConflict,
  onUpdate,
  onRestore,
}: {
  record: MemoryBlockRecord | null;
  loading: boolean;
  error: string | null;
  conflict: ConflictInfo | null;
  editorResetKey: number;
  historyRefreshKey: number;
  onClearConflict: () => void;
  onRetryConflict: () => Promise<void>;
  onUpdate: (document: MemoryBlockDocumentV1) => Promise<MutationResult>;
  onRestore: (revision: number) => Promise<MutationResult>;
}) {
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);

  useEffect(() => {
    setEditorDirty(false);
  }, [editorResetKey, record?.id]);

  if (loading && record === null) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading stable belief…
      </p>
    );
  }
  if (error && record === null) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {error}
      </p>
    );
  }
  if (record === null) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
        Select a stable belief to inspect it.
      </div>
    );
  }

  const quickUpdate = async (document: MemoryBlockDocumentV1) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await onUpdate(document);
    } catch (mutationError) {
      setActionError(errorMessage(mutationError, "Could not update the stable belief."));
    } finally {
      setActionBusy(false);
    }
  };

  const confirmRestore = async () => {
    if (!pendingRestore) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await onRestore(pendingRestore.revision);
      setPendingRestore(null);
    } catch (restoreError) {
      setActionError(errorMessage(restoreError, "Could not restore the revision."));
    } finally {
      setActionBusy(false);
    }
  };

  const retryConflict = async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await onRetryConflict();
    } catch (refreshError) {
      setActionError(errorMessage(refreshError, "Could not fetch the latest head."));
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {pendingRestore && (
        <ConfirmMemoryActionDialog
          title={
            pendingRestore.undo
              ? "Undo previous revision?"
              : `Restore revision ${pendingRestore.revision}?`
          }
          description={
            pendingRestore.undo
              ? `This creates a new immutable revision by restoring revision ${pendingRestore.revision} (current revision minus one).`
              : `This creates a new immutable revision from revision ${pendingRestore.revision}. Existing history is not changed.`
          }
          confirmLabel={pendingRestore.undo ? "Confirm undo" : "Confirm restore"}
          busy={actionBusy}
          onCancel={() => setPendingRestore(null)}
          onConfirm={() => void confirmRestore()}
        />
      )}

      {conflict && (
        <div
          role="alert"
          className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
        >
          <p className="font-semibold">A newer revision was saved elsewhere.</p>
          {conflict.latestLoaded ? (
            <>
              <p className="mt-1">
                Expected revision {conflict.expectedRevision}; latest revision{" "}
                {conflict.actualRevision ?? record.revision}. The latest head is shown below. Your
                correction draft was preserved—review it against the latest head before
                continuing. Nothing was retried.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={onClearConflict}
              >
                I reviewed the latest head
              </Button>
            </>
          ) : (
            <>
              <p className="mt-1">
                Expected revision {conflict.expectedRevision}; reported latest revision{" "}
                {conflict.actualRevision ?? "unknown"}. The canonical head could not be loaded,
                so editing remains disabled and the draft remains preserved.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={actionBusy}
                onClick={() => void retryConflict()}
              >
                {actionBusy ? "Refreshing…" : "Retry latest head"}
              </Button>
            </>
          )}
        </div>
      )}
      {(error || actionError) && (
        <p
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
        >
          {actionError ?? error}
        </p>
      )}

      <section aria-labelledby="current-snapshot-heading" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="current-snapshot-heading" className="text-sm font-semibold text-foreground">
              {record.document.label}
            </h2>
            <p className="break-all font-mono text-[9px] text-muted-foreground">{record.id}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionBusy || Boolean(conflict) || editorDirty}
              title={editorDirty ? "Save or discard the correction draft first" : undefined}
              onClick={() =>
                void quickUpdate({ ...record.document, readOnly: !record.document.readOnly })
              }
            >
              {record.document.readOnly ? "Allow agent changes" : "Prevent agent changes"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionBusy || Boolean(conflict) || editorDirty}
              title={editorDirty ? "Save or discard the correction draft first" : undefined}
              onClick={() => void quickUpdate({ ...record.document, verifiedAt: canonicalNow() })}
            >
              Verify now
            </Button>
          </div>
        </div>
        <MemoryBlockMetadata record={record} />
        <div>
          <p className="mb-1 text-[10px] font-medium text-foreground">Current full snapshot</p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/10 p-3 font-mono text-[10px]">
            {prettyJson(record.document)}
          </pre>
        </div>
      </section>

      <MemoryBlockEditor
        key={`${record.id}:${editorResetKey}`}
        current={record}
        disabled={Boolean(conflict)}
        onSubmit={onUpdate}
        onDirtyChange={setEditorDirty}
      />

      <MemoryBlockHistory
        key={record.id}
        current={record}
        refreshKey={historyRefreshKey}
        actionsDisabled={editorDirty || Boolean(conflict) || actionBusy}
        onRequestRestore={(revision, undo) => setPendingRestore({ revision, undo })}
      />
    </div>
  );
}
