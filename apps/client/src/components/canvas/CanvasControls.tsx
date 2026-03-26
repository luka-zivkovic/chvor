import { useReactFlow } from "@xyflow/react";

export function CanvasControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <div
      className="react-flow__panel !bottom-4 !left-4 !right-auto !top-auto"
      style={{ position: "absolute" }}
    >
      <div
        className="flex items-center gap-0.5 rounded-full px-1 py-0.5 opacity-30 transition-opacity duration-200 hover:opacity-100"
        style={{
          background: "var(--glass-bg-strong)",
          backdropFilter: "blur(16px)",
          border: "1px solid var(--glass-border)",
          height: 32,
        }}
      >
        <button
          onClick={() => zoomOut({ duration: 200 })}
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
          title="Zoom out"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          onClick={() => fitView({ padding: 0.3, duration: 300 })}
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
          title="Fit to view"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6" />
            <path d="M9 21H3v-6" />
            <path d="M21 3l-7 7" />
            <path d="M3 21l7-7" />
          </svg>
        </button>
        <button
          onClick={() => zoomIn({ duration: 200 })}
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
          title="Zoom in"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
