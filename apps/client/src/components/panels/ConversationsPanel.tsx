import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAppStore } from "../../stores/app-store";
import { useUIStore } from "../../stores/ui-store";
import { api } from "../../lib/api";
import { cn } from "@/lib/utils";
import type { ConversationSummary, OrchestratorCheckpoint } from "@chvor/shared";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

type TimelineMessage = { id: string; role: "user" | "assistant"; timestamp: string; preview: string };
type TimelineEvent =
  | { kind: "message"; time: number; id: string; message: TimelineMessage }
  | { kind: "checkpoint"; time: number; id: string; checkpoint: OrchestratorCheckpoint };

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function findCheckpointAt(events: OrchestratorCheckpoint[], time: number): OrchestratorCheckpoint | null {
  let selected: OrchestratorCheckpoint | null = null;
  for (const checkpoint of events) {
    if (checkpoint.createdAt <= time) selected = checkpoint;
  }
  return selected;
}

export function ConversationsPanel() {
  const closePanel = useUIStore((s) => s.closePanel);
  const sessionId = useAppStore((s) => s.sessionId);
  const switchConversation = useAppStore((s) => s.switchConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const archiveConversation = useAppStore((s) => s.archiveConversation);
  const updateConversationTitle = useAppStore((s) => s.updateConversationTitle);

  const [tab, setTab] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [timelineFor, setTimelineFor] = useState<ConversationSummary | null>(null);
  const [timeline, setTimeline] = useState<Awaited<ReturnType<typeof api.sessions.timeline>> | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineCursor, setTimelineCursor] = useState(0);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const currentCompositeId = sessionId ? `web:${sessionId}:default` : null;

  // Cleanup debounce timeout on unmount
  useEffect(() => {
    return () => clearTimeout(searchTimeout.current);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.sessions.list({
        archived: tab === "archived",
        search: debouncedSearch || undefined,
      });
      setConversations(data);
    } catch (err) {
      console.error("[conversations] load failed:", err);
    }
    setLoading(false);
  }, [tab, debouncedSearch]);

  useEffect(() => { load(); }, [load]);

  const handleSearch = (value: string) => {
    setSearch(value);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setDebouncedSearch(value), 300);
  };

  const handleSelect = (c: ConversationSummary) => {
    if (c.id !== currentCompositeId) {
      switchConversation(c.id);
    }
    closePanel();
  };

  const handleDelete = async (id: string) => {
    await deleteConversation(id);
    setConfirmDelete(null);
    setContextMenu(null);
    load();
  };

  const handleArchive = async (id: string, archive: boolean) => {
    await archiveConversation(id, archive);
    setContextMenu(null);
    load();
  };

  const handleRename = async (id: string) => {
    const trimmed = renameValue.trim();
    if (trimmed) {
      await updateConversationTitle(id, trimmed);
      load();
    }
    setRenaming(null);
  };

  const openTimeline = async (conversation: ConversationSummary) => {
    setTimelineFor(conversation);
    setTimeline(null);
    setTimelineCursor(0);
    setTimelineLoading(true);
    setContextMenu(null);
    try {
      const data = await api.sessions.timeline(conversation.id);
      setTimeline(data);
      setTimelineCursor(Math.max(0, data.messages.length + data.checkpoints.length - 1));
    } catch (err) {
      console.error("[conversations] timeline failed:", err);
    } finally {
      setTimelineLoading(false);
    }
  };

  const orderedCheckpoints = useMemo(
    () => [...(timeline?.checkpoints ?? [])].sort((a, b) => a.createdAt - b.createdAt),
    [timeline?.checkpoints]
  );

  const timelineEvents = useMemo<TimelineEvent[]>(() => {
    if (!timeline) return [];
    return [
      ...timeline.messages.map((message) => ({
        kind: "message" as const,
        id: message.id,
        time: new Date(message.timestamp).getTime(),
        message,
      })),
      ...orderedCheckpoints.map((checkpoint) => ({
        kind: "checkpoint" as const,
        id: checkpoint.id,
        time: checkpoint.createdAt,
        checkpoint,
      })),
    ].sort((a, b) => a.time - b.time);
  }, [orderedCheckpoints, timeline]);

  const activeTimelineEvent = timelineEvents[Math.min(timelineCursor, Math.max(0, timelineEvents.length - 1))];
  const selectedCheckpoint = activeTimelineEvent
    ? activeTimelineEvent.kind === "checkpoint"
      ? activeTimelineEvent.checkpoint
      : findCheckpointAt(orderedCheckpoints, activeTimelineEvent.time)
    : null;
  const selectedCheckpointIndex = selectedCheckpoint ? orderedCheckpoints.findIndex((c) => c.id === selectedCheckpoint.id) : -1;
  const previousCheckpoint = selectedCheckpointIndex > 0 ? orderedCheckpoints[selectedCheckpointIndex - 1] : null;
  const branchMessageId = useMemo(() => {
    if (!timeline || !activeTimelineEvent) return undefined;
    let candidate: string | undefined;
    for (const message of timeline.messages) {
      if (new Date(message.timestamp).getTime() <= activeTimelineEvent.time) candidate = message.id;
    }
    return candidate;
  }, [activeTimelineEvent, timeline]);

  const currentToolOutcomes = selectedCheckpoint?.state.toolOutcomes ?? [];
  const previousToolOutcomes = previousCheckpoint?.state.toolOutcomes ?? [];
  const newToolOutcomes = currentToolOutcomes.filter(
    (outcome) => !previousToolOutcomes.some((prev) => prev.toolName === outcome.toolName && prev.success === outcome.success)
  );
  const rankingPreview = selectedCheckpoint?.state.ranking.slice(0, 4) ?? [];

  const branchAt = async (messageId?: string) => {
    if (!timelineFor) return;
    const branch = await api.sessions.branch(timelineFor.id, {
      messageId,
      title: `Branch: ${timelineFor.title || "Untitled"}`,
    });
    await useAppStore.getState().loadConversations();
    await switchConversation(branch.id);
    setTimelineFor(null);
    closePanel();
  };

  const handleDeleteAllArchived = async () => {
    setLoading(true);
    await Promise.all(conversations.map((c) => api.sessions.delete(c.id)));
    await useAppStore.getState().loadConversations();
    load();
  };

  return (
    <div className="relative flex flex-col h-full">
      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <input
          type="text"
          placeholder="Search conversations..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="w-full px-3 py-1.5 rounded-md border border-border/30 bg-background text-xs text-foreground placeholder:text-muted-foreground/40 outline-none focus:border-accent/50 transition-colors"
        />
      </div>

      {/* Tabs */}
      <div className="flex px-3 pb-2 gap-1">
        {(["active", "archived"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-1 rounded text-[10px] font-mono uppercase tracking-wider transition-colors",
              tab === t
                ? "bg-accent/20 text-foreground"
                : "text-muted-foreground/50 hover:text-muted-foreground"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-1">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-muted-foreground/50">Loading...</span>
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-muted-foreground/50">
              {search ? "No matching conversations" : tab === "archived" ? "No archived conversations" : "No conversations yet"}
            </span>
          </div>
        ) : (
          conversations.map((c) => (
            <div
              key={c.id}
              onClick={() => handleSelect(c)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ id: c.id, x: e.clientX, y: e.clientY });
              }}
              className={cn(
                "px-3 py-2 mx-1 rounded-md cursor-pointer hover:bg-accent/30 transition-colors group relative",
                c.id === currentCompositeId && "bg-accent/20"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                {renaming === c.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => handleRename(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename(c.id);
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs font-medium bg-transparent border-b border-accent outline-none min-w-0 flex-1"
                    maxLength={100}
                  />
                ) : (
                  <span className="text-xs font-medium truncate">{c.title || "Untitled"}</span>
                )}
                <span className="text-[9px] text-muted-foreground/40 shrink-0">{timeAgo(c.updatedAt)}</span>
              </div>
              {c.preview && (
                <div className="text-[10px] text-muted-foreground/50 truncate mt-0.5">{c.preview}</div>
              )}
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[9px] text-muted-foreground/30">{c.messageCount} messages</span>
              </div>
              {/* Inline "..." trigger */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setContextMenu({ id: c.id, x: e.clientX, y: e.clientY });
                }}
                className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-foreground transition-opacity"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="8" cy="3" r="1.5" />
                  <circle cx="8" cy="8" r="1.5" />
                  <circle cx="8" cy="13" r="1.5" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>

      {/* Delete all archived */}
      {tab === "archived" && conversations.length > 0 && (
        <div className="px-3 py-2 border-t border-border/20">
          <button
            onClick={handleDeleteAllArchived}
            className="w-full py-1.5 rounded text-[10px] text-destructive hover:bg-destructive/10 transition-colors"
          >
            Delete all archived
          </button>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-50 w-36 rounded-md border border-border/50 bg-popover shadow-lg overflow-hidden"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              onClick={() => {
                const c = conversations.find((x) => x.id === contextMenu.id);
                if (c) void openTimeline(c);
              }}
              className="w-full px-3 py-1.5 text-xs text-left hover:bg-accent/30 transition-colors"
            >
              Timeline / branch
            </button>
            <button
              onClick={() => {
                const c = conversations.find((x) => x.id === contextMenu.id);
                setRenameValue(c?.title || "");
                setRenaming(contextMenu.id);
                setContextMenu(null);
              }}
              className="w-full px-3 py-1.5 text-xs text-left hover:bg-accent/30 transition-colors"
            >
              Rename
            </button>
            <button
              onClick={() => handleArchive(contextMenu.id, tab === "active")}
              className="w-full px-3 py-1.5 text-xs text-left hover:bg-accent/30 transition-colors"
            >
              {tab === "active" ? "Archive" : "Unarchive"}
            </button>
            {confirmDelete === contextMenu.id ? (
              <button
                onClick={() => handleDelete(contextMenu.id)}
                className="w-full px-3 py-1.5 text-xs text-left text-destructive hover:bg-destructive/10 transition-colors"
              >
                Confirm delete?
              </button>
            ) : (
              <button
                onClick={() => setConfirmDelete(contextMenu.id)}
                className="w-full px-3 py-1.5 text-xs text-left text-destructive hover:bg-destructive/10 transition-colors"
              >
                Delete
              </button>
            )}
          </div>
        </>
      )}

      {timelineFor && (
        <div className="absolute inset-0 z-40 flex flex-col bg-card/95 backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">{timelineFor.title || "Untitled"}</div>
              <div className="text-[10px] text-muted-foreground/50">Time scrubber / branch history</div>
            </div>
            <button
              onClick={() => setTimelineFor(null)}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Close
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {timelineLoading ? (
              <div className="py-8 text-center text-xs text-muted-foreground/50">Loading timeline…</div>
            ) : timelineEvents.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground/50">No timeline data yet.</div>
            ) : (
              <>
                <div className="mb-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.18em] text-primary/70">Cognition scrubber</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {(timeline?.messages.length ?? 0)} messages · {orderedCheckpoints.length} round snapshot{orderedCheckpoints.length === 1 ? "" : "s"}
                      </div>
                    </div>
                    <button
                      onClick={() => void branchAt(branchMessageId)}
                      className="rounded-md border border-primary/30 px-2 py-1 text-[11px] text-primary hover:bg-primary/10"
                    >
                      Branch at cursor
                    </button>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, timelineEvents.length - 1)}
                    value={Math.min(timelineCursor, Math.max(0, timelineEvents.length - 1))}
                    onChange={(e) => setTimelineCursor(Number(e.target.value))}
                    className="mt-3 w-full accent-primary"
                  />
                  <div className="mt-2 flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground/40">
                    <span>{formatClock(timelineEvents[0].time)}</span>
                    <span>
                      {activeTimelineEvent?.kind === "checkpoint" ? `Round ${activeTimelineEvent.checkpoint.round}` : activeTimelineEvent?.message.role}
                    </span>
                    <span>{formatClock(timelineEvents[timelineEvents.length - 1].time)}</span>
                  </div>
                </div>

                <div className="mb-3 grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-border/25 bg-background/45 p-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Cursor</div>
                    <div className="mt-1 text-xs text-foreground">
                      {activeTimelineEvent?.kind === "message"
                        ? `${activeTimelineEvent.message.role}: ${activeTimelineEvent.message.preview || "…"}`
                        : selectedCheckpoint
                          ? `Round ${selectedCheckpoint.round} checkpoint`
                          : "No checkpoint"}
                    </div>
                    <div className="mt-1 text-[9px] text-muted-foreground/35">
                      {activeTimelineEvent ? new Date(activeTimelineEvent.time).toLocaleString() : "—"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/25 bg-background/45 p-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Replay state</div>
                    <div className="mt-1 text-xs text-foreground">
                      {selectedCheckpoint
                        ? `${selectedCheckpoint.state.model.providerId}/${selectedCheckpoint.state.model.model}`
                        : "No checkpoint selected"}
                    </div>
                    <div className="mt-1 text-[9px] text-muted-foreground/45">
                      {selectedCheckpoint
                        ? `${selectedCheckpoint.state.messages.fitted}/${selectedCheckpoint.state.messages.total} messages fitted · ${selectedCheckpoint.state.memoryIds.length} memories`
                        : "Move the scrubber to a round snapshot."}
                    </div>
                  </div>
                </div>

                {selectedCheckpoint && (
                  <div className="mb-3 rounded-lg border border-border/25 bg-background/40 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Outcome diff</div>
                        <div className="text-[9px] text-muted-foreground/35">
                          vs {previousCheckpoint ? `round ${previousCheckpoint.round}` : "session start"}
                        </div>
                      </div>
                      <button
                        onClick={() => void branchAt(branchMessageId)}
                        className="rounded border border-border/40 px-2 py-1 text-[10px] text-muted-foreground hover:border-primary/40 hover:text-primary"
                      >
                        Branch from this state
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                      <div className="rounded border border-border/20 bg-card/40 p-2">
                        <div className="mb-1 text-muted-foreground/50">Tools this round</div>
                        {currentToolOutcomes.length > 0 ? currentToolOutcomes.slice(0, 5).map((outcome) => (
                          <div key={`${outcome.toolName}-${String(outcome.success)}`} className={outcome.success ? "text-emerald-300/80" : "text-destructive/80"}>
                            {outcome.success ? "✓" : "×"} {outcome.toolName}
                          </div>
                        )) : <div className="text-muted-foreground/35">No tool outcomes</div>}
                      </div>
                      <div className="rounded border border-border/20 bg-card/40 p-2">
                        <div className="mb-1 text-muted-foreground/50">Delta</div>
                        {newToolOutcomes.length > 0 ? newToolOutcomes.slice(0, 5).map((outcome) => (
                          <div key={`new-${outcome.toolName}-${String(outcome.success)}`} className="text-primary/80">
                            + {outcome.toolName} {outcome.success ? "succeeded" : "failed"}
                          </div>
                        )) : <div className="text-muted-foreground/35">No new outcomes</div>}
                      </div>
                    </div>
                    <div className="mt-2 rounded border border-border/20 bg-card/40 p-2 text-[10px]">
                      <div className="mb-1 text-muted-foreground/50">Top tool graph candidates</div>
                      {rankingPreview.length > 0 ? rankingPreview.map((rank) => (
                        <span key={rank.toolName} className="mr-2 inline-flex rounded-full border border-border/30 px-2 py-0.5 text-muted-foreground">
                          {rank.toolName} · {rank.composite.toFixed(2)}
                        </span>
                      )) : <span className="text-muted-foreground/35">No ranking captured</span>}
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  {timelineEvents.map((event, i) => (
                    <button
                      key={`${event.kind}-${event.id}`}
                      onClick={() => setTimelineCursor(i)}
                      className={cn(
                        "w-full rounded-lg border px-2 py-1.5 text-left transition-colors",
                        i === timelineCursor
                          ? "border-primary/35 bg-primary/10"
                          : "border-border/20 bg-background/35 hover:bg-accent/20"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/55">
                          {event.kind === "checkpoint" ? `Round ${event.checkpoint.round}` : event.message.role}
                        </span>
                        <span className="text-[9px] text-muted-foreground/35">{formatClock(event.time)}</span>
                      </div>
                      <div className="line-clamp-1 text-xs text-foreground/70">
                        {event.kind === "checkpoint"
                          ? `${event.checkpoint.state.toolOutcomes.length} tools · ${event.checkpoint.state.memoryIds.length} memories · ${event.checkpoint.state.messages.fitted}/${event.checkpoint.state.messages.total} history`
                          : event.message.preview || "…"}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
