import { useCallback, useEffect, useRef, useState } from "react";
import { useUIStore } from "../../stores/ui-store";
import { useRuntimeStore } from "../../stores/runtime-store";
import { A2UIHostRenderer } from "./A2UIHostRenderer";
import { cn } from "@/lib/utils";

const MIN_W = 360;
const MIN_H = 300;
const DEFAULT_W = 640;
const DEFAULT_H = 480;

export function A2UIPreviewModal() {
  const open = useUIStore((s) => s.previewModalOpen);
  const close = useUIStore((s) => s.closePreviewModal);
  const openCanvas = useUIStore((s) => s.openCanvas);

  const surfaceList = useRuntimeStore((s) => s.surfaceList);
  const activeSurface = useRuntimeStore((s) => s.activeSurface);
  const activeSurfaceId = useRuntimeStore((s) => s.activeSurfaceId);
  const fetchSurface = useRuntimeStore((s) => s.fetchSurface);
  const fetchSurfaces = useRuntimeStore((s) => s.fetchSurfaces);

  // Position & size
  const [pos, setPos] = useState({ x: -1, y: -1 });
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });

  // Drag state
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  // Resize state
  const resizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // Center on first open
  useEffect(() => {
    if (open && pos.x === -1) {
      setPos({
        x: Math.max(0, (window.innerWidth - size.w) / 2),
        y: Math.max(0, (window.innerHeight - size.h) / 2),
      });
    }
  }, [open, pos.x, size.w, size.h]);

  // Fetch surfaces on open
  useEffect(() => {
    if (open) {
      fetchSurfaces().then(() => {
        const { activeSurfaceId, surfaceList } = useRuntimeStore.getState();
        if (!activeSurfaceId && surfaceList.length > 0) {
          fetchSurface(surfaceList[0].id);
        }
      });
    }
  }, [open, fetchSurfaces, fetchSurface]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close]);

  /* ─── Drag handlers ─── */
  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      // Only drag from header, not buttons
      if ((e.target as HTMLElement).closest("button, select")) return;
      dragging.current = true;
      dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
      e.preventDefault();
    },
    [pos],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({
          x: Math.max(0, Math.min(e.clientX - dragOffset.current.x, window.innerWidth - 100)),
          y: Math.max(0, Math.min(e.clientY - dragOffset.current.y, window.innerHeight - 60)),
        });
      }
      if (resizing.current) {
        const dx = e.clientX - resizeStart.current.x;
        const dy = e.clientY - resizeStart.current.y;
        setSize({
          w: Math.max(MIN_W, resizeStart.current.w + dx),
          h: Math.max(MIN_H, resizeStart.current.h + dy),
        });
      }
    };
    const onUp = () => {
      dragging.current = false;
      resizing.current = false;
    };
    const onResize = () => {
      setPos((p) => ({
        x: Math.max(0, Math.min(p.x, window.innerWidth - 100)),
        y: Math.max(0, Math.min(p.y, window.innerHeight - 60)),
      }));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  /* ─── Resize handler ─── */
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      resizing.current = true;
      resizeStart.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
      e.preventDefault();
      e.stopPropagation();
    },
    [size],
  );

  const expandToCanvas = useCallback(() => {
    close();
    openCanvas(activeSurfaceId ?? undefined);
  }, [close, openCanvas, activeSurfaceId]);

  if (!open) return null;

  return (
    <div
      className="fixed z-40"
      style={{
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
      }}
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: "var(--glass-bg-strong, oklch(0.14 0.007 275 / 0.92))",
          borderColor: "var(--glass-border, oklch(0.30 0.007 275 / 0.4))",
          backdropFilter: "blur(24px) saturate(1.1)",
        }}
      >
        {/* ─── Header (drag handle) ─── */}
        <div
          className="flex shrink-0 cursor-grab items-center gap-2 border-b px-3 py-2 active:cursor-grabbing select-none"
          style={{ borderColor: "var(--glass-border, oklch(0.30 0.007 275 / 0.3))" }}
          onMouseDown={onDragStart}
        >
          {/* Drag indicator */}
          <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0 text-muted-foreground/40" aria-hidden="true">
            <circle cx="2" cy="2" r="1" fill="currentColor" />
            <circle cx="6" cy="2" r="1" fill="currentColor" />
            <circle cx="2" cy="6" r="1" fill="currentColor" />
            <circle cx="6" cy="6" r="1" fill="currentColor" />
          </svg>

          {/* Surface selector */}
          {surfaceList.length > 1 ? (
            <select
              className="min-w-0 flex-1 truncate rounded bg-transparent px-1 py-0.5 text-xs font-medium text-foreground outline-none focus:ring-1 focus:ring-ring"
              value={activeSurfaceId ?? ""}
              onChange={(e) => fetchSurface(e.target.value)}
            >
              {surfaceList.map((s) => (
                <option key={s.id} value={s.id} className="bg-card text-foreground">
                  {s.title}
                </option>
              ))}
            </select>
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {activeSurface?.title ?? "Dashboard Preview"}
            </span>
          )}

          {/* Expand to full canvas */}
          <button
            onClick={expandToCanvas}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
            title="Expand to full canvas"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>

          {/* Close */}
          <button
            onClick={close}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/10 hover:text-destructive"
            title="Close preview"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* ─── Body ─── */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeSurface ? (
            <A2UIHostRenderer surfaceId={activeSurface.surfaceId} surface={activeSurface} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-xs text-muted-foreground">
                {surfaceList.length > 0
                  ? "Loading surface\u2026"
                  : "No surfaces available"}
              </p>
            </div>
          )}
        </div>

        {/* ─── Resize handle (bottom-right corner) ─── */}
        <div
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          onMouseDown={onResizeStart}
          aria-hidden="true"
        >
          <svg
            width="10" height="10" viewBox="0 0 10 10"
            className="absolute bottom-1 right-1 text-muted-foreground/30"
          >
            <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1" />
            <line x1="9" y1="4" x2="4" y2="9" stroke="currentColor" strokeWidth="1" />
            <line x1="9" y1="7" x2="7" y2="9" stroke="currentColor" strokeWidth="1" />
          </svg>
        </div>
      </div>
    </div>
  );
}
