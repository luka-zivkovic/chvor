import { Component, useState } from "react";
import type { A2UISurface } from "@chvor/shared";
import {
  A2UIText,
  A2UIColumn,
  A2UIRow,
  A2UIImage,
  A2UITable,
  A2UIButton,
  A2UIForm,
  A2UIInput,
  A2UIChart,
} from "./components";

const MAX_RENDER_DEPTH = 50;

function renderNode(
  nodeId: string,
  surface: A2UISurface,
  visited?: Set<string>,
  depth?: number,
): React.ReactNode {
  const d = depth ?? 0;
  if (d > MAX_RENDER_DEPTH) {
    console.warn(`[a2ui] max depth exceeded for "${nodeId}"`);
    return null;
  }

  const seen = visited ?? new Set<string>();
  if (seen.has(nodeId)) {
    console.warn(`[a2ui] circular ref: "${nodeId}"`);
    return null;
  }
  seen.add(nodeId);

  const entry = surface.components[nodeId];
  if (!entry) {
    console.warn(`[a2ui] component "${nodeId}" not found in surface. Available: [${Object.keys(surface.components).join(", ")}]`);
    return (
      <p className="text-xs text-amber-500/80 border border-amber-500/20 rounded px-2 py-1 my-1">
        Missing component &ldquo;{nodeId}&rdquo;
      </p>
    );
  }

  const comp = entry.component;
  if (!comp || typeof comp !== "object") {
    console.warn(`[a2ui] component "${nodeId}" has invalid definition:`, comp);
    return (
      <p className="text-xs text-destructive border border-destructive/20 rounded px-2 py-1 my-1">
        Invalid component &ldquo;{nodeId}&rdquo; — no definition
      </p>
    );
  }

  // Clone `seen` per child so siblings don't pollute each other's ancestor sets
  // (also prevents React StrictMode double-render from corrupting the shared Set)
  const childRenderNode = (childId: string, s: A2UISurface) =>
    renderNode(childId, s, new Set(seen), d + 1);

  try {
    if ("Text" in comp) {
      return <A2UIText key={nodeId} spec={comp.Text} bindings={surface.bindings} />;
    }
    if ("Column" in comp) {
      return <A2UIColumn key={nodeId} spec={comp.Column} surface={surface} renderNode={childRenderNode} />;
    }
    if ("Row" in comp) {
      return <A2UIRow key={nodeId} spec={comp.Row} surface={surface} renderNode={childRenderNode} />;
    }
    if ("Image" in comp) {
      return <A2UIImage key={nodeId} spec={comp.Image} bindings={surface.bindings} />;
    }
    if ("Table" in comp) {
      return <A2UITable key={nodeId} spec={comp.Table} bindings={surface.bindings} />;
    }
    if ("Button" in comp) {
      return <A2UIButton key={nodeId} sourceId={nodeId} spec={comp.Button} bindings={surface.bindings} />;
    }
    if ("Form" in comp) {
      return <A2UIForm key={nodeId} sourceId={nodeId} spec={comp.Form} surface={surface} renderNode={childRenderNode} />;
    }
    if ("Input" in comp) {
      return <A2UIInput key={nodeId} spec={comp.Input} />;
    }
    if ("Chart" in comp) {
      return <A2UIChart key={nodeId} spec={comp.Chart} bindings={surface.bindings} />;
    }
  } catch (err) {
    console.error(`[a2ui] render error for "${nodeId}":`, err);
    return (
      <p role="alert" className="text-xs text-destructive">
        Error rendering component &ldquo;{nodeId}&rdquo;
      </p>
    );
  }

  // Unknown component type — show fallback with actual keys for debugging
  const compType = Object.keys(comp).join(", ") || "unknown";
  console.warn(`[a2ui] unknown component type for "${nodeId}": keys=[${compType}]`, comp);
  return (
    <p className="text-xs text-amber-500/80 border border-amber-500/20 rounded px-2 py-1">
      Unknown component &ldquo;{nodeId}&rdquo; (type: {compType})
    </p>
  );
}

/* ─── Error Boundary ─── */

interface EBProps {
  children: React.ReactNode;
  surfaceId: string;
}

interface EBState {
  error: Error | null;
}

class A2UIErrorBoundary extends Component<EBProps, EBState> {
  state: EBState = { error: null };

  static getDerivedStateFromError(error: Error): EBState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[a2ui] render crash on surface "${this.props.surfaceId}":`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">Surface render error</p>
          <p className="mt-1 text-xs text-muted-foreground">{this.state.error.message}</p>
          <button
            className="mt-2 text-xs text-muted-foreground underline hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ─── Diagnostics panel ─── */

function SurfaceDiagnostics({ surfaceId, surface }: { surfaceId: string; surface: A2UISurface }) {
  const [expanded, setExpanded] = useState(false);
  const entries = Object.entries(surface.components);
  const rootEntry = surface.root ? surface.components[surface.root] : null;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-xs">
      <p className="font-medium text-amber-400 mb-2">Surface rendered empty — diagnostics</p>
      <div className="space-y-1 text-muted-foreground">
        <p>Surface ID: <span className="text-foreground font-mono">{surfaceId}</span></p>
        <p>Root: <span className="text-foreground font-mono">{surface.root ?? "(null)"}</span></p>
        <p>Root in map: <span className={rootEntry ? "text-green-400" : "text-destructive"}>{rootEntry ? "yes" : "NO"}</span></p>
        <p>Rendering: <span className="text-foreground">{String(surface.rendering)}</span></p>
        <p>Components: <span className="text-foreground">{entries.length}</span></p>
        <p>Bindings keys: <span className="text-foreground">{Object.keys(surface.bindings).join(", ") || "(none)"}</span></p>
      </div>

      {entries.length > 0 && (
        <button
          className="mt-3 text-amber-400 underline hover:text-amber-300"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide" : "Show"} component tree
        </button>
      )}

      {expanded && (
        <div className="mt-2 space-y-2 max-h-60 overflow-y-auto">
          {entries.map(([id, entry]) => {
            const typeKeys = entry.component ? Object.keys(entry.component) : [];
            const isRoot = id === surface.root;
            return (
              <div key={id} className={`rounded border px-2 py-1 font-mono ${isRoot ? "border-primary/40 bg-primary/5" : "border-border/30"}`}>
                <span className="text-foreground">{id}</span>
                {isRoot && <span className="ml-1 text-primary text-[10px]">(root)</span>}
                <span className="ml-2 text-muted-foreground">type: {typeKeys.join(", ") || "?"}</span>
                <pre className="mt-1 text-[10px] text-muted-foreground/70 whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                  {JSON.stringify(entry.component, null, 2)}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Renderer ─── */

export function A2UIRenderer({ surfaceId, surface }: { surfaceId: string; surface: A2UISurface }) {
  const componentCount = Object.keys(surface.components).length;
  const isBuilding = !surface.root || !surface.rendering;

  return (
    <>
      <p aria-live="polite" className="sr-only">
        {isBuilding ? "Building surface" : "Surface ready"}
      </p>
      {isBuilding ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16">
          <div className="h-6 w-6 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
          <p className="text-sm text-muted-foreground">Building surface&hellip;</p>
          <div className="mt-2 rounded-md border border-border/40 bg-muted/20 px-4 py-3 text-xs text-muted-foreground max-w-sm">
            <p className="font-medium mb-1">Surface: {surfaceId}</p>
            <p>{componentCount} component{componentCount !== 1 ? "s" : ""} registered</p>
            {!surface.root && <p className="text-amber-500/80 mt-1">Waiting for root component&hellip;</p>}
            {surface.root && !surface.rendering && (
              <p className="text-amber-500/80 mt-1">Root set to &ldquo;{surface.root}&rdquo; but rendering not started</p>
            )}
          </div>
          {/* Show diagnostics even in building state so we can debug */}
          {componentCount > 0 && (
            <div className="mt-4 w-full max-w-lg">
              <SurfaceDiagnostics surfaceId={surfaceId} surface={surface} />
            </div>
          )}
        </div>
      ) : (
        <A2UIErrorBoundary key={surfaceId} surfaceId={surfaceId}>
          <SurfaceContent surfaceId={surfaceId} surface={surface} />
        </A2UIErrorBoundary>
      )}
    </>
  );
}

/** Wrapper that detects empty render output and shows diagnostics */
function SurfaceContent({ surfaceId, surface }: { surfaceId: string; surface: A2UISurface }) {
  if (!surface.root) {
    return <SurfaceDiagnostics surfaceId={surfaceId} surface={surface} />;
  }
  const rendered = renderNode(surface.root, surface, new Set(), 0);

  if (!rendered) {
    return <SurfaceDiagnostics surfaceId={surfaceId} surface={surface} />;
  }

  return (
    <div className="a2ui-surface" role="region" aria-label={`Surface: ${surfaceId}`}>
      {rendered}
    </div>
  );
}
