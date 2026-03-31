import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { toast } from "sonner";

interface Props {
  kind: "skill" | "tool";
  id: string;
  name: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function EditInstructionsDialog({ kind, id, name, onClose, onSaved }: Props) {
  const [original, setOriginal] = useState("");
  const [value, setValue] = useState("");
  const [hasOverride, setHasOverride] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const fetcher = kind === "skill" ? api.skills.getInstructions : api.tools.getInstructions;
    fetcher(id)
      .then((data) => {
        setOriginal(data.original);
        setValue(data.override ?? data.original);
        setHasOverride(data.hasOverride);
      })
      .catch(() => toast.error("Failed to load instructions"))
      .finally(() => setLoading(false));
  }, [kind, id]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const updater = kind === "skill" ? api.skills.updateInstructions : api.tools.updateInstructions;
      await updater(id, value);
      setHasOverride(true);
      toast.success("Instructions saved");
      onSaved?.();
    } catch {
      toast.error("Failed to save instructions");
    } finally {
      setSaving(false);
    }
  }, [kind, id, value, onSaved]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    try {
      const resetter = kind === "skill" ? api.skills.resetInstructions : api.tools.resetInstructions;
      await resetter(id);
      setValue(original);
      setHasOverride(false);
      toast.success("Instructions reset to original");
      onSaved?.();
    } catch {
      toast.error("Failed to reset instructions");
    } finally {
      setSaving(false);
    }
  }, [kind, id, original, onSaved]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-border bg-card p-5 shadow-xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{name}</h2>
            <span className="text-[10px] text-muted-foreground">Edit Instructions</span>
            {hasOverride && (
              <Badge variant="secondary" className="rounded-full text-[9px]">Modified</Badge>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Editor */}
        {loading ? (
          <div className="flex h-64 items-center justify-center text-xs text-muted-foreground">Loading...</div>
        ) : (
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-80 font-mono text-xs leading-relaxed bg-input/50"
            placeholder="Skill instructions..."
          />
        )}

        {/* Actions */}
        <div className="mt-4 flex items-center justify-between">
          <div>
            {hasOverride && (
              <Button variant="ghost" size="sm" onClick={handleReset} disabled={saving} className="text-[11px] text-muted-foreground">
                Reset to Original
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving || loading}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
