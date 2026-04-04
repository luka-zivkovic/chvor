import { useToolStore } from "../../stores/tool-store";
import { useUIStore } from "../../stores/ui-store";
import { useCanvasStore } from "../../stores/canvas-store";
import { api } from "../../lib/api";
import { cn } from "@/lib/utils";
import { RegistrySearchBar } from "../registry/RegistrySearchBar";

export function ToolsPanel() {
  const { tools, fetchTools } = useToolStore();
  const nodes = useCanvasStore((s) => s.nodes);

  const handleToggle = async (toolId: string, currentlyEnabled: boolean) => {
    await api.tools.toggle(toolId, !currentlyEnabled);
    fetchTools();
  };

  const handleRowClick = (toolId: string) => {
    const nodeId = nodes.find(
      (n) => n.type === "tool" && (n.data as { toolId?: string }).toolId === toolId
    )?.id;
    if (nodeId) {
      useUIStore.getState().openNodeDetail("tool-detail", nodeId);
    }
  };

  if (tools.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <RegistrySearchBar kind="tool" onInstalled={fetchTools} />
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
          <p className="text-xs text-muted-foreground">No tools configured</p>
          <p className="text-[10px] text-muted-foreground/60">
            Search the registry above to discover and install tools
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Registry search */}
      <RegistrySearchBar kind="tool" onInstalled={fetchTools} />

      {tools.map((tool) => {
        const isEnabled = tool.enabled !== false;
        return (
          <div
            key={tool.id}
            className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/10 p-3 transition-colors hover:bg-muted/20 cursor-pointer"
            onClick={() => handleRowClick(tool.id)}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "text-xs font-medium",
                  isEnabled ? "text-foreground" : "text-muted-foreground"
                )}>
                  {tool.metadata.name}
                </span>
                {tool.builtIn && (
                  <span className="rounded-full bg-status-completed/20 px-1.5 py-px text-[8px] font-mono uppercase tracking-wider text-status-completed">
                    built-in
                  </span>
                )}
                <span className="rounded-full border border-border/50 px-1.5 py-px text-[8px] font-mono uppercase tracking-wider text-muted-foreground">
                  {tool.source}
                </span>
              </div>
              {tool.metadata.description && (
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {tool.metadata.description}
                </p>
              )}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleToggle(tool.id, isEnabled);
              }}
              role="switch"
              aria-checked={isEnabled}
              aria-label={`Toggle ${tool.metadata.name}`}
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                isEnabled ? "bg-primary" : "bg-muted-foreground/30"
              )}
            >
              <span className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
                isEnabled ? "left-[18px]" : "left-0.5"
              )} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
