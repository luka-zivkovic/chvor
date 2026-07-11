import { useCallback, useEffect, useRef, useState } from "react";
import type { TrajectoryDetail, TrajectoryListItem } from "../../lib/api";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { TrajectoryInspector } from "../trajectories/TrajectoryInspector";
import { EmptyState } from "../ui/empty-state";

const STATUS_OPTIONS = [
  "all",
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "aborted",
  "round-limited",
] as const;

function shortTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function summary(record: TrajectoryListItem): string {
  return record.title ?? record.summary ?? `${record.origin.kind} execution`;
}

export function ExecutionsPanel() {
  const [records, setRecords] = useState<TrajectoryListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TrajectoryDetail | null>(null);
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>("all");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listErrorAction, setListErrorAction] = useState<"refresh" | "load more">("refresh");
  const [detailError, setDetailError] = useState<string | null>(null);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const listStatusRef = useRef<string | null>(null);

  const loadDetail = useCallback(async (id: string) => {
    const requestId = ++detailRequest.current;
    setLoadingDetail(true);
    setDetailError(null);
    setDetail(null);
    try {
      const trajectory = await api.trajectories.get(id);
      if (requestId === detailRequest.current) setDetail(trajectory);
    } catch (error) {
      if (requestId !== detailRequest.current) return;
      setDetailError(error instanceof Error ? error.message : "Could not load execution");
    } finally {
      if (requestId === detailRequest.current) setLoadingDetail(false);
    }
  }, []);

  const loadList = useCallback(
    async (cursor?: string) => {
      const requestId = ++listRequest.current;
      const statusChanged = !cursor && listStatusRef.current !== status;
      if (statusChanged) {
        listStatusRef.current = status;
        selectedIdRef.current = null;
        setRecords([]);
        setSelectedId(null);
        setDetail(null);
        setNextCursor(null);
      }
      if (cursor) setLoadingMore(true);
      else setLoadingList(true);
      setListError(null);
      setListErrorAction(cursor ? "load more" : "refresh");
      try {
        const page = await api.trajectories.list({
          limit: 25,
          ...(cursor ? { cursor } : {}),
          ...(status === "all" ? {} : { status }),
        });
        if (requestId !== listRequest.current) return;
        setRecords((current) => (cursor ? [...current, ...page.records] : page.records));
        setNextCursor(page.nextCursor);
        if (!cursor) {
          const latestPreferredId = statusChanged ? null : selectedIdRef.current;
          const nextSelectedId = page.records.some(({ id }) => id === latestPreferredId)
            ? latestPreferredId
            : (page.records[0]?.id ?? null);
          if (nextSelectedId && nextSelectedId === selectedIdRef.current) {
            void loadDetail(nextSelectedId);
          }
          selectedIdRef.current = nextSelectedId;
          setSelectedId(nextSelectedId);
        }
      } catch (error) {
        if (requestId !== listRequest.current) return;
        setListError(error instanceof Error ? error.message : "Could not load executions");
      } finally {
        if (requestId === listRequest.current) {
          setLoadingList(false);
          setLoadingMore(false);
        }
      }
    },
    [loadDetail, status]
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (selectedId) void loadDetail(selectedId);
    else {
      detailRequest.current += 1;
      setDetail(null);
      setLoadingDetail(false);
    }
  }, [loadDetail, selectedId]);

  useEffect(
    () => () => {
      listRequest.current += 1;
      detailRequest.current += 1;
    },
    []
  );

  return (
    <div className="flex min-h-[calc(100vh-9rem)] flex-col gap-4 md:flex-row">
      <aside className="max-h-64 w-full shrink-0 overflow-y-auto border-b border-border/40 pb-3 md:max-h-none md:w-56 md:border-r md:border-b-0 md:pr-3 md:pb-0">
        <label className="mb-3 block font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
            className="mt-1.5 w-full rounded-lg border border-border bg-background/60 px-2 py-2 text-xs text-foreground outline-none focus:border-primary/50"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </label>
        <button
          onClick={() => void loadList()}
          disabled={loadingList}
          className="mb-3 w-full rounded-lg border border-border/40 px-2 py-1.5 text-[9px] text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          {loadingList ? "Refreshing…" : "Refresh"}
        </button>

        {loadingList && records.length === 0 && (
          <p className="py-8 text-center text-xs text-muted-foreground">Loading executions…</p>
        )}
        {listError && records.length === 0 && (
          <EmptyState
            size="compact"
            title="Could not load executions"
            description={listError}
            action={{ label: "Retry", onClick: () => void loadList() }}
          />
        )}
        {!loadingList && !listError && records.length === 0 && (
          <EmptyState
            size="compact"
            title="No executions yet"
            description="Run a chat, schedule, webhook, or daemon task to create a trajectory."
          />
        )}

        <div className="space-y-1.5">
          {records.map((record) => (
            <button
              key={record.id}
              onClick={() => {
                selectedIdRef.current = record.id;
                setSelectedId(record.id);
              }}
              className={cn(
                "w-full rounded-lg border p-2.5 text-left transition-colors",
                selectedId === record.id
                  ? "border-primary/40 bg-primary/10"
                  : "border-border/30 bg-card/20 hover:border-border hover:bg-card/40"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[11px] font-medium">{summary(record)}</span>
                <span className="shrink-0 font-mono text-[8px] uppercase text-muted-foreground">
                  {record.status}
                </span>
              </div>
              <p className="mt-1 text-[9px] text-muted-foreground">
                {record.origin.kind} · {record.stepCount} steps
              </p>
              <p className="mt-1 text-[9px] text-muted-foreground/70">
                {shortTime(record.startedAt)}
              </p>
            </button>
          ))}
        </div>

        {listError && records.length > 0 && (
          <p className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/5 p-2 text-[10px] text-rose-200">
            Could not {listErrorAction} · {listError}
          </p>
        )}

        {nextCursor && !loadingList && (
          <button
            onClick={() => void loadList(nextCursor)}
            disabled={loadingMore}
            className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </aside>

      <main className="min-w-0 flex-1">
        {!selectedId && !loadingList && records.length > 0 && (
          <p className="py-12 text-center text-xs text-muted-foreground">Select an execution.</p>
        )}
        {loadingDetail && (
          <p className="py-12 text-center text-xs text-muted-foreground">Loading execution…</p>
        )}
        {detailError && selectedId && (
          <EmptyState
            title="Could not load execution"
            description={detailError}
            action={{ label: "Retry", onClick: () => void loadDetail(selectedId) }}
          />
        )}
        {detail && <TrajectoryInspector trajectory={detail} />}
      </main>
    </div>
  );
}
