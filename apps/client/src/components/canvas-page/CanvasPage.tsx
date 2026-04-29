import { useEffect, memo } from "react";
import { useRuntimeStore } from "../../stores/runtime-store";
import { useUIStore } from "../../stores/ui-store";
import { A2UIHostRenderer } from "../a2ui/A2UIHostRenderer";
import { cn } from "@/lib/utils";
import type { A2UISurfaceListItem } from "@chvor/shared";

export function CanvasPage() {
  const exitCanvas = useUIStore((s) => s.exitCanvas);
  const surfaceList = useRuntimeStore((s) => s.surfaceList);
  const activeSurface = useRuntimeStore((s) => s.activeSurface);
  const activeSurfaceId = useRuntimeStore((s) => s.activeSurfaceId);
  const fetchSurfaces = useRuntimeStore((s) => s.fetchSurfaces);
  const fetchSurface = useRuntimeStore((s) => s.fetchSurface);
  const deleteSurface = useRuntimeStore((s) => s.deleteSurfaceFromServer);

  // Load surface list on mount and auto-select first surface if none active
  useEffect(() => {
    let cancelled = false;
    fetchSurfaces().then(() => {
      if (cancelled) return;
      const { activeSurfaceId, surfaceList } = useRuntimeStore.getState();
      if (!activeSurfaceId && surfaceList.length > 0) {
        fetchSurface(surfaceList[0].id);
      }
    });
    return () => { cancelled = true; };
  }, [fetchSurfaces, fetchSurface]);

  // Esc to exit
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitCanvas();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [exitCanvas]);

  return (
    <div className="flex h-dvh w-screen bg-background text-foreground">
      {/* Sidebar */}
      <nav className="hidden sm:flex w-48 md:w-64 shrink-0 flex-col border-r border-border bg-card" aria-label="Surface list">
        {/* Sidebar header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <button
            onClick={exitCanvas}
            aria-label="Back to Brain"
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <h2 className="text-sm font-medium">A2UI Canvas</h2>
        </div>

        {/* Surface list */}
        <div className="flex-1 overflow-y-auto p-2">
          {surfaceList.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <p className="text-xs text-muted-foreground">No surfaces yet</p>
              <p className="text-[10px] text-muted-foreground/60">
                Ask the agent to build a dashboard or UI
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5" aria-label="Surfaces">
              {surfaceList.map((item) => (
                <SurfaceListItem
                  key={item.id}
                  item={item}
                  active={item.id === activeSurfaceId}
                  onSelect={fetchSurface}
                  onDelete={deleteSurface}
                />
              ))}
            </ul>
          )}
        </div>
      </nav>

      {/* Main viewer */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {activeSurface ? (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            <A2UIHostRenderer surfaceId={activeSurface.surfaceId} surface={activeSurface} />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-muted-foreground">
                {surfaceList.length > 0
                  ? "Select a surface from the sidebar"
                  : "No surfaces available"}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const SurfaceListItem = memo(function SurfaceListItem({
  item,
  active,
  onSelect,
  onDelete,
}: {
  item: A2UISurfaceListItem;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <li
      className={cn(
        "group flex items-center gap-2 rounded-md transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      )}
    >
      <button
        className="flex-1 min-w-0 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-md"
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(item.id)}
      >
        <p className="text-xs font-medium truncate">{item.title}</p>
        <p className="text-[10px] text-muted-foreground/60 truncate">
          {new Date(item.updatedAt).toLocaleDateString()}
        </p>
      </button>

      <button
        aria-label={`Delete surface ${item.title}`}
        onClick={() => {
          if (window.confirm(`Delete surface "${item.title}"?`)) onDelete(item.id);
        }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-muted-foreground hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-all mr-1"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <line x1="2" y1="2" x2="8" y2="8" />
          <line x1="8" y1="2" x2="2" y2="8" />
        </svg>
      </button>
    </li>
  );
});
