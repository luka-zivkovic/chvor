import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MemoryBlockDocumentV1, MemoryBlockRecord } from "@chvor/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MemoryBlockInspector } from "./MemoryBlockInspector";
import { MemoryBlockList } from "./MemoryBlockList";
import {
  assertMutationSize,
  conflictFrom,
  errorMessage,
  provenanceText,
} from "./memory-block-utils";
import { memoryBlocksApi, type ConflictInfo, type MutationResult } from "./types";

const BLOCK_PAGE_SIZE = 20;

type LayerFilter = "all" | MemoryBlockRecord["document"]["layer"];
type ManagerFilter = "all" | MemoryBlockRecord["document"]["managedBy"];
type VerificationFilter = "all" | "verified" | "never";
type ProtectionFilter = "all" | "on" | "off";

function matchesSearch(record: MemoryBlockRecord, query: string): boolean {
  if (!query) return true;
  const document = record.document;
  return [
    record.id,
    document.label,
    document.description ?? "",
    document.content,
    document.layer,
    document.managedBy,
    record.actor.actorType,
    record.actor.actorId ?? "",
    provenanceText(record),
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

export function StableMemoryBlocks() {
  const [records, setRecords] = useState<MemoryBlockRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [head, setHead] = useState<MemoryBlockRecord | null>(null);
  const [headLoading, setHeadLoading] = useState(false);
  const [headError, setHeadError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [editorResetKey, setEditorResetKey] = useState(0);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [search, setSearch] = useState("");
  const [layer, setLayer] = useState<LayerFilter>("all");
  const [manager, setManager] = useState<ManagerFilter>("all");
  const [verification, setVerification] = useState<VerificationFilter>("all");
  const [protection, setProtection] = useState<ProtectionFilter>("all");
  const selectedIdRef = useRef(selectedId);
  const headRef = useRef(head);
  selectedIdRef.current = selectedId;
  headRef.current = head;

  const applyRecord = useCallback((record: MemoryBlockRecord) => {
    if (selectedIdRef.current === record.id) {
      const current = headRef.current;
      if (!current || current.id !== record.id || record.revision >= current.revision) {
        headRef.current = record;
        setHead(record);
      }
    }
    setRecords((current) => {
      const found = current.some(({ id }) => id === record.id);
      return found
        ? current.map((candidate) =>
            candidate.id === record.id && record.revision >= candidate.revision
              ? record
              : candidate
          )
        : [record, ...current];
    });
  }, []);

  const loadList = useCallback(async (cursor?: string) => {
    setListLoading(true);
    setListError(null);
    try {
      const page = await memoryBlocksApi.list({
        limit: BLOCK_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      setRecords((current) => {
        const keepNewer = (record: MemoryBlockRecord) => {
          const existing = current.find(({ id }) => id === record.id);
          return existing && existing.revision > record.revision ? existing : record;
        };
        if (!cursor) return page.records.map(keepNewer);
        const merged = [...current];
        for (const incoming of page.records) {
          const index = merged.findIndex(({ id }) => id === incoming.id);
          if (index === -1) merged.push(incoming);
          else if (incoming.revision > merged[index]!.revision) merged[index] = incoming;
        }
        return merged;
      });
      setNextCursor(page.nextCursor);
      if (!cursor) {
        const current = selectedIdRef.current;
        const retained = current
          ? page.records.find(({ id }) => id === current) ?? null
          : null;
        const nextSelected = retained?.id ?? page.records[0]?.id ?? null;
        setSelectedId(nextSelected);
        if (retained) {
          const prior = headRef.current;
          const accepted =
            prior && prior.id === retained.id && prior.revision > retained.revision
              ? prior
              : retained;
          headRef.current = accepted;
          setHead((currentHead) =>
            currentHead?.id === accepted.id && currentHead.revision > accepted.revision
              ? currentHead
              : accepted
          );
          setHeadError(null);
          setHistoryRefreshKey((value) => value + 1);
          setConflict((active) => {
            if (prior && prior.id === accepted.id && prior.revision < accepted.revision) {
              return {
                expectedRevision: prior.revision,
                actualRevision: accepted.revision,
                latestLoaded: true,
              };
            }
            return active
              ? {
                  ...active,
                  actualRevision: accepted.revision,
                  latestLoaded: true,
                }
              : active;
          });
        } else if (current !== nextSelected) {
          headRef.current = null;
          setHead(null);
        }
      }
    } catch (loadError) {
      setListError(errorMessage(loadError, "Could not load stable beliefs."));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      headRef.current = null;
      setHead(null);
      return;
    }
    let cancelled = false;
    setHeadLoading(true);
    setHeadError(null);
    setConflict(null);
    void memoryBlocksApi
      .get(selectedId)
      .then((record) => {
        if (!cancelled) applyRecord(record);
      })
      .catch((loadError: unknown) => {
        if (!cancelled)
          setHeadError(errorMessage(loadError, "Could not inspect this stable belief."));
      })
      .finally(() => {
        if (!cancelled) setHeadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyRecord, selectedId]);

  const reconcileConflict = useCallback(
    async (
      target: MemoryBlockRecord,
      mutationError: unknown
    ): Promise<MutationResult | null> => {
      const conflictInfo = conflictFrom(mutationError, target.revision);
      if (!conflictInfo) return null;
      if (selectedIdRef.current === target.id) setConflict(conflictInfo);
      let latest = target;
      try {
        latest = await memoryBlocksApi.get(target.id);
        applyRecord(latest);
        if (selectedIdRef.current === target.id) {
          setConflict({
            ...conflictInfo,
            actualRevision: latest.revision,
            latestLoaded: true,
          });
          setHistoryRefreshKey((value) => value + 1);
        }
      } catch (refreshError) {
        if (selectedIdRef.current === target.id) {
          setHeadError(
            `Conflict detected, but the latest head could not be fetched: ${errorMessage(refreshError, "unknown error")}`
          );
        }
      }
      return { kind: "conflict", latest };
    },
    [applyRecord]
  );

  const retryConflictRefresh = useCallback(async () => {
    const targetId = selectedIdRef.current;
    if (!targetId || !conflict) return;
    setHeadError(null);
    try {
      const latest = await memoryBlocksApi.get(targetId);
      if (selectedIdRef.current !== targetId) return;
      applyRecord(latest);
      setConflict((current) =>
        current
          ? { ...current, actualRevision: latest.revision, latestLoaded: true }
          : current
      );
      setHistoryRefreshKey((value) => value + 1);
    } catch (refreshError) {
      if (selectedIdRef.current === targetId) {
        setHeadError(
          `The latest head is still unavailable: ${errorMessage(refreshError, "unknown error")}`
        );
      }
      throw refreshError;
    }
  }, [applyRecord, conflict]);

  const update = useCallback(
    async (document: MemoryBlockDocumentV1): Promise<MutationResult> => {
      if (!head) throw new Error("No stable belief is selected.");
      const target = head;
      const body = { expectedRevision: target.revision, document };
      assertMutationSize(body);
      try {
        const record = await memoryBlocksApi.update(target.id, body);
        applyRecord(record);
        if (selectedIdRef.current === target.id) {
          setConflict(null);
          setEditorResetKey((value) => value + 1);
          setHistoryRefreshKey((value) => value + 1);
        }
        return { kind: "updated", record };
      } catch (mutationError) {
        const reconciled = await reconcileConflict(target, mutationError);
        if (reconciled) return reconciled;
        throw mutationError;
      }
    },
    [applyRecord, head, reconcileConflict]
  );

  const restore = useCallback(
    async (restoredFromRevision: number): Promise<MutationResult> => {
      if (!head) throw new Error("No stable belief is selected.");
      const target = head;
      const body = { expectedRevision: target.revision, restoredFromRevision };
      assertMutationSize(body);
      try {
        const record = await memoryBlocksApi.restore(target.id, body);
        applyRecord(record);
        if (selectedIdRef.current === target.id) {
          setConflict(null);
          setEditorResetKey((value) => value + 1);
          setHistoryRefreshKey((value) => value + 1);
        }
        return { kind: "updated", record };
      } catch (mutationError) {
        const reconciled = await reconcileConflict(target, mutationError);
        if (reconciled) return reconciled;
        throw mutationError;
      }
    },
    [applyRecord, head, reconcileConflict]
  );

  const filteredRecords = useMemo(() => {
    const query = search.toLocaleLowerCase();
    return records.filter((record) => {
      const document = record.document;
      return (
        matchesSearch(record, query) &&
        (layer === "all" || document.layer === layer) &&
        (manager === "all" || document.managedBy === manager) &&
        (verification === "all" ||
          (verification === "verified"
            ? document.verifiedAt !== null
            : document.verifiedAt === null)) &&
        (protection === "all" || (protection === "on" ? document.readOnly : !document.readOnly))
      );
    });
  }, [layer, manager, protection, records, search, verification]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Stable beliefs [{filteredRecords.length} shown / {records.length} loaded]
          </h2>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Structured, versioned memory blocks with immutable audit history.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={listLoading}
          onClick={() => void loadList()}
        >
          Refresh
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Input
          aria-label="Search stable beliefs"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search blocks…"
          className="h-8 text-xs sm:col-span-2"
        />
        <select
          aria-label="Filter by layer"
          value={layer}
          onChange={(event) => setLayer(event.target.value as LayerFilter)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="all">All layers</option>
          <option value="identity">Identity</option>
          <option value="human">Human</option>
          <option value="procedural">Procedural</option>
        </select>
        <select
          aria-label="Filter by manager"
          value={manager}
          onChange={(event) => setManager(event.target.value as ManagerFilter)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="all">All managers</option>
          <option value="user">User-managed</option>
          <option value="agent">Agent-managed</option>
        </select>
        <select
          aria-label="Filter by verification"
          value={verification}
          onChange={(event) => setVerification(event.target.value as VerificationFilter)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="all">Any verification</option>
          <option value="verified">Verified</option>
          <option value="never">Never verified</option>
        </select>
        <select
          aria-label="Filter by agent protection"
          value={protection}
          onChange={(event) => setProtection(event.target.value as ProtectionFilter)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs sm:col-start-2 lg:col-start-5"
        >
          <option value="all">Any agent protection</option>
          <option value="on">Prevent agent changes: On</option>
          <option value="off">Prevent agent changes: Off</option>
        </select>
      </div>

      {listError && (
        <p role="alert" className="text-xs text-destructive">
          {listError}
        </p>
      )}
      {listLoading && records.length === 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading stable beliefs…
        </p>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.7fr)]">
        {(!listError || records.length > 0) && (
          <MemoryBlockList
            records={filteredRecords}
            selectedId={selectedId}
            loading={listLoading}
            nextCursor={nextCursor}
            onSelect={setSelectedId}
            onLoadMore={() => {
              if (nextCursor) void loadList(nextCursor);
            }}
          />
        )}
        <MemoryBlockInspector
          key={selectedId ?? "no-selection"}
          record={head?.id === selectedId ? head : null}
          loading={headLoading}
          error={headError}
          conflict={conflict}
          editorResetKey={editorResetKey}
          historyRefreshKey={historyRefreshKey}
          onClearConflict={() => setConflict(null)}
          onRetryConflict={retryConflictRefresh}
          onUpdate={update}
          onRestore={restore}
        />
      </div>
    </div>
  );
}
