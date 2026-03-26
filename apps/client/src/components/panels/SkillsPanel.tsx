import { useEffect } from "react";
import { useSkillStore } from "../../stores/skill-store";
import { useUIStore } from "../../stores/ui-store";
import { useCanvasStore } from "../../stores/canvas-store";
import { useRegistryStore } from "../../stores/registry-store";
import { api } from "../../lib/api";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  prompt: "Prompt",
  workflow: "Workflow",
};

export function SkillsPanel() {
  const { skills, fetchSkills } = useSkillStore();
  const nodes = useCanvasStore((s) => s.nodes);
  const { availableUpdates, checkUpdates } = useRegistryStore();

  useEffect(() => {
    checkUpdates();
  }, []);

  const behavioralSkills = skills.filter(
    (s) => s.skillType === "prompt" || s.skillType === "workflow"
  );

  const handleToggle = async (skillId: string, currentlyEnabled: boolean) => {
    await api.skills.toggle(skillId, !currentlyEnabled);
    fetchSkills();
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
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <p className="text-xs text-muted-foreground">No behavioral skills configured</p>
        <p className="text-[10px] text-muted-foreground/60">
          Behavioral skills shape how the AI responds
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
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
