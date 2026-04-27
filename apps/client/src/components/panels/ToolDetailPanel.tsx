import { useState } from "react";
import { useCanvasStore } from "../../stores/canvas-store";
import { useFeatureStore } from "../../stores/feature-store";
import { useUIStore } from "../../stores/ui-store";
import { api } from "../../lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ToolNodeData } from "../../stores/canvas-store";
import { EditInstructionsDialog } from "../capabilities/EditInstructionsDialog";

function statusDotClass(status: string): string {
  switch (status) {
    case "running":
      return "bg-status-running animate-pulse";
    case "completed":
      return "bg-status-completed";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

export function ToolDetailPanel() {
  const detailNodeId = useUIStore((s) => s.detailNodeId);
  const nodes = useCanvasStore((s) => s.nodes);
  const { tools, fetchTools } = useFeatureStore();
  const [expanded, setExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const node = nodes.find((n) => n.id === detailNodeId);
  if (!node) return <p className="text-xs text-muted-foreground">Node not found</p>;

  const data = node.data as unknown as ToolNodeData;
  const tool = tools.find((t) => t.id === data.toolId);

  if (!tool) {
    return (
      <p className="text-xs text-muted-foreground">
        Tool not found: {data.toolId}
      </p>
    );
  }

  const isEnabled = tool.enabled !== false;

  const handleToggle = async () => {
    await api.tools.toggle(tool.id, !isEnabled);
    fetchTools();
  };

  const handleExport = async () => {
    try {
      const content = await api.tools.exportTool(tool.id);
      const blob = new Blob([content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${tool.id}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[tool] export failed:", err);
    }
  };

  const handleDelete = async () => {
    if (tool.builtIn) return;
    if (!confirm(`Delete tool "${tool.metadata.name}"?`)) return;
    try {
      await api.tools.delete(tool.id);
      fetchTools();
      useUIStore.getState().closePanel();
    } catch (err) {
      console.error("[tool] delete failed:", err);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Tool Info */}
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tool Details
        </h3>
        <div className="rounded-xl border border-border/50 bg-muted/20 p-3">
          <p className="text-sm font-medium">{tool.metadata.name}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {tool.metadata.description}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tool.builtIn && (
              <Badge variant="default" className="rounded-full text-[10px] font-medium bg-status-completed/20 text-status-completed border-0">
                Built-in
              </Badge>
            )}
            {tool.metadata.category && (
              <Badge variant="secondary" className="rounded-full text-[10px]">
                {tool.metadata.category}
              </Badge>
            )}
            {tool.metadata.author && (
              <Badge variant="secondary" className="rounded-full text-[10px]">
                by {tool.metadata.author}
              </Badge>
            )}
            <Badge variant="secondary" className="rounded-full text-[10px]">
              v{tool.metadata.version}
            </Badge>
            <Badge variant="secondary" className="rounded-full text-[10px]">
              {tool.source}
            </Badge>
          </div>
        </div>
      </section>

      {/* Enable/Disable */}
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tool Control
        </h3>
        <div className="flex items-center justify-between rounded-xl border border-border/50 bg-muted/20 p-3">
          <div>
            <span className="text-xs text-foreground/80">
              {isEnabled ? "Enabled" : "Disabled"}
            </span>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {isEnabled ? "This tool is active" : "This tool will not be used"}
            </p>
          </div>
          <Button
            variant={isEnabled ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs"
            onClick={handleToggle}
          >
            {isEnabled ? "Disable" : "Enable"}
          </Button>
        </div>
      </section>

      {/* Tags */}
      {tool.metadata.tags && tool.metadata.tags.length > 0 && (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Tags
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {tool.metadata.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="rounded-full text-[10px]">
                {tag}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {/* MCP Server */}
      {tool.mcpServer && (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            MCP Server
          </h3>
          <div className="rounded-xl border border-border/50 bg-muted/20 p-3">
            <p className="font-mono text-xs text-foreground/80">
              {tool.mcpServer.command}
            </p>
            {tool.mcpServer.args && tool.mcpServer.args.length > 0 && (
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                {tool.mcpServer.args.join(" ")}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Required Credentials */}
      {tool.metadata.requires?.credentials &&
        tool.metadata.requires.credentials.length > 0 && (
          <section>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Required Credentials
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {tool.metadata.requires.credentials.map((cred) => (
                <Badge key={cred} variant="outline" className="rounded-full text-[10px]">
                  {cred}
                </Badge>
              ))}
            </div>
          </section>
        )}

      {/* Instructions (preview with expand) */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Instructions
          </h3>
          {"hasOverride" in tool && (tool as { hasOverride?: boolean }).hasOverride && (
            <Badge variant="secondary" className="rounded-full text-[9px]">Modified</Badge>
          )}
        </div>
        <div className="rounded-xl border border-border/50 bg-muted/20 p-3">
          <pre className={`text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/70 ${!expanded ? "line-clamp-6" : "max-h-64 overflow-auto"}`}>
            {tool.instructions}
          </pre>
          <div className="mt-2 flex items-center gap-2">
            {tool.instructions.split("\n").length > 6 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "Show less" : "Show more"}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px]"
              onClick={() => setEditOpen(true)}
            >
              Edit Instructions
            </Button>
          </div>
        </div>
        {editOpen && (
          <EditInstructionsDialog
            kind="tool"
            id={tool.id}
            name={tool.metadata.name}
            onClose={() => setEditOpen(false)}
            onSaved={() => { setEditOpen(false); fetchTools(); }}
          />
        )}
      </section>

      {/* Status */}
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Status
        </h3>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${statusDotClass(data.executionStatus)}`} />
          <span className="text-xs capitalize text-muted-foreground">
            {data.executionStatus}
          </span>
        </div>
      </section>

      {/* Actions */}
      <section className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={handleExport}
        >
          Export
        </Button>
        {!tool.builtIn && (
          <Button
            variant="destructive"
            size="sm"
            className="h-7 text-xs"
            onClick={handleDelete}
          >
            Delete
          </Button>
        )}
      </section>
    </div>
  );
}
