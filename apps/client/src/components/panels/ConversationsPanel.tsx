import { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../../stores/app-store";
import { useUIStore } from "../../stores/ui-store";
import { api } from "../../lib/api";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "@chvor/shared";

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

  const handleDeleteAllArchived = async () => {
    setLoading(true);
    await Promise.all(conversations.map((c) => api.sessions.delete(c.id)));
    await useAppStore.getState().loadConversations();
    load();
  };

  return (
    <div className="flex flex-col h-full">
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
    </div>
  );
}
