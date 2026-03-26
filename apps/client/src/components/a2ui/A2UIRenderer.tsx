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
  if (d > MAX_RENDER_DEPTH) return null;

  const seen = visited ?? new Set<string>();
  if (seen.has(nodeId)) return null; // circular reference guard
  seen.add(nodeId);

  const entry = surface.components[nodeId];
  if (!entry) return null;

  const comp = entry.component;
  const childRenderNode = (childId: string, s: A2UISurface) =>
    renderNode(childId, s, seen, d + 1);

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
      return <A2UIButton key={nodeId} spec={comp.Button} bindings={surface.bindings} />;
    }
    if ("Form" in comp) {
      return <A2UIForm key={nodeId} spec={comp.Form} surface={surface} renderNode={childRenderNode} />;
    }
    if ("Input" in comp) {
      return <A2UIInput key={nodeId} spec={comp.Input} />;
    }
    if ("Chart" in comp) {
      return <A2UIChart key={nodeId} spec={comp.Chart} bindings={surface.bindings} />;
    }
  } catch {
    return (
      <p className="text-xs text-destructive">
        Error rendering component "{nodeId}"
      </p>
    );
  }

  return null;
}

export function A2UIRenderer({ surfaceId, surface }: { surfaceId: string; surface: A2UISurface }) {
  if (!surface.root || !surface.rendering) {
    return (
      <p className="text-xs text-muted-foreground text-center py-8">
        Building surface...
      </p>
    );
  }

  return <div className="a2ui-surface">{renderNode(surface.root, surface, new Set(), 0)}</div>;
}
