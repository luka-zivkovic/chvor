import { useEffect } from "react";
import { useFeatureStore } from "../../stores/feature-store";
import { useUIStore } from "../../stores/ui-store";
import { useCanvasStore } from "../../stores/canvas-store";
import { api } from "../../lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { RegistrySearchBar } from "../registry/RegistrySearchBar";
import { EmptyState } from "../ui/empty-state";

const TYPE_LABELS: Record<string, string> = {
  prompt: "Prompt",
  workflow: "Workflow",
};

export function SkillsPanel() {
  const { skills, fetchSkills } = useFeatureStore();
  const nodes = useCanvasStore((s) => s.nodes);
  const { availableUpdates, checkUpdates } = useFeatureStore();

  useEffect(() => {
    checkUpdates();
  }, [checkUpdates]);

  const behavioralSkills = skills.filter(
    (s) => s.skillType === "prompt" || s.skillType === "workflow"
  );

  const handleToggle = async (skillId: string, currentlyEnabled: boolean) => {
    try {
      await api.skills.toggle(skillId, !currentlyEnabled);
      fetchSkills();
    } catch (err) {
      toast.error("Failed to toggle skill");
      console.error("[skill] toggle failed:", err);
    }
  };

  const handleRowClick = (skillId: string) => {
    const nodeId = nodes.find(
      (n) => n.type === "skill" && (n.data as { skillId?: string }).skillId === skillId
    )?.id;
    if (nodeId) {
      useUIStore.getState().openNodeDetail("skill-detail", nodeId);
    }
  };

  if (behavioralSkills.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <RegistrySearchBar kind="skill" onInstalled={fetchSkills} />
        <EmptyState
          size="compact"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v6m0 10v6M4.22 4.22l4.24 4.24m7.08 7.08 4.24 4.24M1 12h6m10 0h6M4.22 19.78l4.24-4.24m7.08-7.08 4.24-4.24" />
            </svg>
          }
          title="No behavioral skills configured"
          description="Search the registry above to discover and install skills."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Registry search */}
      <RegistrySearchBar kind="skill" onInstalled={fetchSkills} />

      {/* Update indicator */}
      {availableUpdates.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-[10px] text-amber-500">
            {availableUpdates.length} skill update{availableUpdates.length > 1 ? "s" : ""} available
          </span>
        </div>
      )}

      {behavioralSkills.map((skill) => {
        const isEnabled = skill.enabled !== false;
        return (
          <div
            key={skill.id}
            className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/10 p-3 transition-colors hover:bg-muted/20 cursor-pointer"
            onClick={() => handleRowClick(skill.id)}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "text-xs font-medium",
                  isEnabled ? "text-foreground" : "text-muted-foreground"
                )}>
                  {skill.metadata.name}
                </span>
                <span className="rounded-full border border-border/50 px-1.5 py-px text-[8px] font-mono uppercase tracking-wider text-muted-foreground">
                  {TYPE_LABELS[skill.skillType] ?? skill.skillType}
                </span>
              </div>
              {skill.metadata.description && (
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {skill.metadata.description}
                </p>
              )}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleToggle(skill.id, isEnabled);
              }}
              role="switch"
              aria-checked={isEnabled}
              aria-label={`Toggle ${skill.metadata.name}`}
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
