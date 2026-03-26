import { useState, useEffect } from "react";
import { useCanvasStore } from "../../stores/canvas-store";
import { useSkillStore } from "../../stores/skill-store";
import { useRegistryStore } from "../../stores/registry-store";
import { useUIStore } from "../../stores/ui-store";
import { api } from "../../lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { SkillNodeData } from "../../stores/canvas-store";
import type { SkillConfigParam } from "@chvor/shared";

const SKILL_TYPE_LABELS: Record<string, string> = {
  prompt: "Prompt",
  workflow: "Workflow",
};

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

export function SkillDetailPanel() {
  const detailNodeId = useUIStore((s) => s.detailNodeId);
  const nodes = useCanvasStore((s) => s.nodes);
  const { skills, fetchSkills } = useSkillStore();
  const [expanded, setExpanded] = useState(false);

  const node = nodes.find((n) => n.id === detailNodeId);
  if (!node) return <p className="text-xs text-muted-foreground">Node not found</p>;

  const data = node.data as unknown as SkillNodeData;
  const skill = skills.find((s) => s.id === data.skillId);

  if (!skill) {
    return (
      <p className="text-xs text-muted-foreground">
        Skill not found: {data.skillId}
      </p>
    );
  }

  const isEnabled = skill.enabled !== false;

  const handleToggle = async () => {
    await api.skills.toggle(skill.id, !isEnabled);
    fetchSkills();
  };

  const handleDelete = async () => {
    if (skill.source === "bundled") return;
    if (!confirm(`Delete skill "${skill.metadata.name}"?`)) return;
    try {
      await api.skills.delete(skill.id);
      fetchSkills();
      useUIStore.getState().closePanel();
    } catch (err) {
      console.error("[skill] delete failed:", err);
    }
  };

  const handleExport = async () => {
    try {
      const content = await api.skills.exportSkill(skill.id);
      const blob = new Blob([content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${skill.id}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[skill] export failed:", err);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Skill Info */}
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Skill Details
        </h3>
        <div className="rounded-xl border border-border/50 bg-muted/20 p-3">
          <p className="text-sm font-medium">{skill.metadata.name}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {skill.metadata.description}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="default" className="rounded-full text-[10px] font-medium">
              {SKILL_TYPE_LABELS[skill.skillType] ?? skill.skillType}
            </Badge>
            {skill.metadata.category && (
              <Badge variant="secondary" className="rounded-full text-[10px]">
                {skill.metadata.category}
              </Badge>
            )}
            <Badge variant="secondary" className="rounded-full text-[10px]">
              v{skill.metadata.version}
            </Badge>
            <Badge variant="secondary" className="rounded-full text-[10px]">
              {skill.source}
            </Badge>
          </div>
        </div>
      </section>

      {/* Enable/Disable */}
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Skill Control
        </h3>
        <div className="flex items-center justify-between rounded-xl border border-border/50 bg-muted/20 p-3">
          <div>
            <span className="text-xs text-foreground/80">
              {isEnabled ? "Enabled" : "Disabled"}
            </span>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {isEnabled ? "This skill is active" : "This skill will not be used"}
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
      {skill.metadata.tags && skill.metadata.tags.length > 0 && (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Tags
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {skill.metadata.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="rounded-full text-[10px]">
                {tag}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {/* Required Credentials */}
      {skill.metadata.requires?.credentials &&
        skill.metadata.requires.credentials.length > 0 && (
          <section>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Required Credentials
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {skill.metadata.requires.credentials.map((cred) => (
                <Badge
                  key={cred}
                  variant="outline"
                  className="rounded-full text-[10px]"
                >
                  {cred}
                </Badge>
              ))}
            </div>
          </section>
        )}

      {/* Instructions (preview with expand) */}
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Instructions
        </h3>
        <div className="rounded-xl border border-border/50 bg-muted/20 p-3">
          <pre className={`text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/70 ${!expanded ? "line-clamp-6" : "max-h-64 overflow-auto"}`}>
            {skill.instructions}
          </pre>
          {skill.instructions.split("\n").length > 6 && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
          )}
        </div>
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

      {/* Per-Skill Configuration */}
      <SkillConfigSection skillId={skill.id} />

      {/* Registry Actions */}
      {skill.source === "registry" && (
        <RegistryActionsSection skillId={skill.id} />
      )}

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
        {skill.source !== "bundled" && (
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

function SkillConfigSection({ skillId }: { skillId: string }) {
  const [params, setParams] = useState<SkillConfigParam[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    setConfigError(null);
    api.skills.getConfig(skillId).then((data) => {
      setParams(data.params);
      setValues(data.values);
    }).catch((err) => {
      console.warn("[skill-config] failed to load config:", err);
      setConfigError("Failed to load configuration");
    });
  }, [skillId]);

  if (configError) {
    return (
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Configuration
        </h3>
        <p className="text-[10px] text-destructive">{configError}</p>
      </section>
    );
  }

  if (params.length === 0) return null;

  const handleSave = async () => {
    setSaving(true);
    setConfigError(null);
    try {
      await api.skills.updateConfig(skillId, values);
    } catch (err) {
      setConfigError("Failed to save configuration");
      console.warn("[skill-config] save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Configuration
      </h3>
      <div className="space-y-2 rounded-xl border border-border/50 bg-muted/20 p-3">
        {params.map((param) => (
          <div key={param.name}>
            <label className="text-[10px] font-medium text-foreground/80">{param.name}</label>
            <p className="text-[9px] text-muted-foreground mb-1">{param.description}</p>
            {param.type === "boolean" ? (
              <button
                onClick={() => setValues((v) => ({ ...v, [param.name]: !v[param.name] }))}
                className={`h-5 w-9 rounded-full transition-colors ${
                  values[param.name] ? "bg-primary" : "bg-muted-foreground/30"
                }`}
              >
                <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${
                  values[param.name] ? "translate-x-[18px]" : "translate-x-0.5"
                }`} />
              </button>
            ) : (
              <input
                type={param.type === "number" ? "number" : "text"}
                value={String(values[param.name] ?? "")}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    [param.name]: param.type === "number" ? Number(e.target.value) : e.target.value,
                  }))
                }
                className="w-full rounded border border-border/50 bg-background px-2 py-1 text-[10px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            )}
          </div>
        ))}
        <Button
          variant="default"
          size="sm"
          className="mt-1 h-6 text-[10px]"
          disabled={saving}
          onClick={handleSave}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
        {configError && (
          <p className="mt-1 text-[10px] text-destructive">{configError}</p>
        )}
      </div>
    </section>
  );
}

function RegistryActionsSection({ skillId }: { skillId: string }) {
  const { availableUpdates, applyUpdate, checkUpdates } = useRegistryStore();
  const { fetchSkills } = useSkillStore();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    checkUpdates();
  }, []);

  const update = availableUpdates.find((u) => u.id === skillId);

  const handleUpdate = async () => {
    setLoading(true);
    try {
      await applyUpdate(skillId);
      fetchSkills();
    } finally {
      setLoading(false);
    }
  };

  const handleUninstall = async () => {
    setLoading(true);
    try {
      await api.registry.uninstall(skillId);
      fetchSkills();
    } finally {
      setLoading(false);
    }
  };

  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Registry
      </h3>
      <div className="space-y-2">
        {update && (
          <div className="flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <div>
              <p className="text-[10px] font-medium text-amber-500">Update available</p>
              <p className="text-[9px] text-muted-foreground">
                v{update.current} → v{update.available}
              </p>
            </div>
            <Button
              size="sm"
              className="h-6 text-[10px]"
              disabled={loading}
              onClick={handleUpdate}
            >
              {loading ? "..." : "Update"}
            </Button>
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs text-destructive hover:text-destructive"
          disabled={loading}
          onClick={handleUninstall}
        >
          Uninstall
        </Button>
      </div>
    </section>
  );
}
