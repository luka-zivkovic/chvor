import { useEffect, useState } from "react";
import { useA2UIStore } from "../../stores/a2ui-store";
import { useUIStore } from "../../stores/ui-store";
import { A2UIRenderer } from "../a2ui/A2UIRenderer";
import { cn } from "@/lib/utils";
import type { A2UISurfaceListItem, A2UISurface } from "@chvor/shared";

export function CanvasPage() {
  const exitCanvas = useUIStore((s) => s.exitCanvas);
  const surfaceList = useA2UIStore((s) => s.surfaceList);
  const activeSurface = useA2UIStore((s) => s.activeSurface);
  const activeSurfaceId = useA2UIStore((s) => s.activeSurfaceId);
  const fetchSurfaces = useA2UIStore((s) => s.fetchSurfaces);
  const fetchSurface = useA2UIStore((s) => s.fetchSurface);
  const deleteSurface = useA2UIStore((s) => s.deleteSurfaceFromServer);

  // Load surface list on mount
  useEffect(() => {
    fetchSurfaces();
  }, [fetchSurfaces]);

  // Esc to exit
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitCanvas();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [exitCanvas]);

  return (
    <div className="flex h-screen w-screen bg-background text-foreground">
      {/* Sidebar */}
      <div className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
        {/* Sidebar header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <button
            onClick={exitCanvas}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title="Back to Brain"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <span className="text-sm font-medium">A2UI Canvas</span>
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
            surfaceList.map((item) => (
              <SurfaceListItem
                key={item.id}
                item={item}
                active={item.id === activeSurfaceId}
                onSelect={() => fetchSurface(item.id)}
                onDelete={() => deleteSurface(item.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Main viewer */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {activeSurface ? (
          <div className="flex-1 overflow-y-auto p-6">
            <A2UIRenderer surfaceId={activeSurface.surfaceId} surface={activeSurface} />
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
      </div>
    </div>
  );
}

function SurfaceListItem({
  item,
  active,
  onSelect,
  onDelete,
}: {
  item: A2UISurfaceListItem;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md px-3 py-2 cursor-pointer transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      )}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{item.title}</p>
        <p className="text-[10px] text-muted-foreground/60 truncate">
          {new Date(item.updatedAt).toLocaleDateString()}
        </p>
      </div>

      {hovered && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(`Delete surface "${item.title}"?`)) onDelete();
          }}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive transition-colors"
          title="Delete surface"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="2" y1="2" x2="8" y2="8" />
            <line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        </button>
      )}
    </div>
  );
}
