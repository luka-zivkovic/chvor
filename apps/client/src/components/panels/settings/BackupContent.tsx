import { useEffect, useState } from "react";
import type * as React from "react";
import { toast } from "sonner";
import { useConfigStore } from "../../../stores/config-store";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const INTERVAL_OPTIONS = [
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Every 24 hours" },
  { value: 48, label: "Every 48 hours" },
  { value: 168, label: "Weekly" },
];

const MAX_AGE_OPTIONS = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
  { value: 0, label: "Forever" },
];

export function BackupContent() {
  const {
    backups, backupConfig: config, creating, restoring, backupError: error,
    fetchBackups, fetchBackupConfig: fetchConfig, updateBackupConfig: updateConfig, createBackup, deleteBackup, restoreBackup,
  } = useConfigStore();
  const [pendingRestoreFile, setPendingRestoreFile] = useState<File | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [localMaxCount, setLocalMaxCount] = useState<string>("");
  const configMaxCount = config?.maxCount;

  useEffect(() => {
    fetchBackups();
    fetchConfig();
  }, [fetchBackups, fetchConfig]);

  useEffect(() => {
    if (configMaxCount !== undefined) setLocalMaxCount(String(configMaxCount));
  }, [configMaxCount]);

  const handleRestoreSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingRestoreFile(file);
    e.target.value = "";
  };

  const handleRestoreConfirm = async () => {
    if (!pendingRestoreFile) return;
    const file = pendingRestoreFile;
    setPendingRestoreFile(null);
    const success = await restoreBackup(file);
    if (success) {
      toast.success("Restore complete. The server is restarting — please refresh in a few seconds.");
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmId) return;
    await deleteBackup(deleteConfirmId);
    setDeleteConfirmId(null);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleExportTemplate = async () => {
    try {
      const yaml = await api.templates.exportYaml();
      const blob = new Blob([yaml], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "template.yaml";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Template exported");
    } catch {
      toast.error("Failed to export template");
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Export as Template */}
      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
          Export as Template
        </h3>
        <p className="text-[10px] text-muted-foreground mb-2">
          Export your current assistant configuration (persona, skills, tools, schedules) as a shareable template. Credential secrets are not included.
        </p>
        <Button size="sm" variant="outline" onClick={handleExportTemplate}>
          Export Template
        </Button>
      </section>

      {/* Manual Backup / Restore */}
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Manual Backup & Restore
      </h3>

      <div className="flex gap-2">
        <Button size="sm" onClick={() => createBackup()} disabled={creating}>
          {creating ? "Creating..." : "Create Backup"}
        </Button>
        <label className="cursor-pointer">
          <span className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted">
            {restoring ? "Restoring..." : "Restore from File"}
          </span>
          <input type="file" accept=".chvor-backup" className="hidden" onChange={handleRestoreSelect} disabled={restoring} />
        </label>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Backup List */}
      {backups.length > 0 && (
        <div className="border-t border-border pt-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            Backups [{backups.length}]
          </h3>
          {backups.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-md border border-border/50 p-2 mb-1.5">
              <div>
                <p className="text-xs text-foreground truncate max-w-[200px]">{b.filename}</p>
                <p className="text-[10px] text-muted-foreground">
                  {new Date(b.createdAt).toLocaleString()} · {formatSize(b.sizeBytes)}
                </p>
              </div>
              <div className="flex gap-1">
                <a
                  href={`/api/backup/download/${encodeURIComponent(b.id)}`}
                  download
                  className="inline-flex items-center rounded-md px-2 py-1 text-[10px] font-medium text-foreground hover:bg-muted"
                >
                  Download
                </a>
                <Button size="sm" variant="ghost" className="text-destructive text-[10px]" onClick={() => setDeleteConfirmId(b.id)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Auto-Backup Settings */}
      {config && (
        <div className="border-t border-border pt-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            Scheduled Backups
          </h3>

          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer mb-3">
            <input
              type="checkbox"
              className="rounded border-border"
              checked={config.enabled}
              onChange={(e) => updateConfig({ enabled: e.target.checked })}
            />
            Enable automatic backups
          </label>

          {config.enabled && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Interval</label>
                <select
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={config.intervalHours}
                  onChange={(e) => updateConfig({ intervalHours: Number(e.target.value) })}
                >
                  {INTERVAL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Max backups to keep</label>
                <input
                  type="number"
                  min={1}
                  className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={localMaxCount}
                  onChange={(e) => setLocalMaxCount(e.target.value)}
                  onBlur={() => {
                    const n = Math.max(1, parseInt(localMaxCount, 10) || 1);
                    setLocalMaxCount(String(n));
                    if (n !== config.maxCount) updateConfig({ maxCount: n });
                  }}
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Max age</label>
                <select
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={config.maxAgeDays}
                  onChange={(e) => updateConfig({ maxAgeDays: Number(e.target.value) })}
                >
                  {MAX_AGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {config.lastRunAt && (
                <p className="text-[10px] text-muted-foreground/60">
                  Last backup: {new Date(config.lastRunAt).toLocaleString()}
                </p>
              )}
              {config.lastError && (
                <p className="text-[10px] text-destructive">
                  Last error: {config.lastError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Restore confirmation */}
      {pendingRestoreFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-background p-5 shadow-lg max-w-sm">
            <p className="text-sm font-medium text-foreground mb-2">Confirm Restore</p>
            <p className="text-xs text-muted-foreground mb-4">
              This will replace your current database, skills, and tools with the backup contents. A safety backup will be created first. The server will restart.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setPendingRestoreFile(null)}>Cancel</Button>
              <Button size="sm" variant="destructive" onClick={handleRestoreConfirm} disabled={restoring}>
                {restoring ? "Restoring..." : "Restore"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-background p-5 shadow-lg max-w-sm">
            <p className="text-sm font-medium text-foreground mb-2">Delete Backup</p>
            <p className="text-xs text-muted-foreground mb-4">
              This backup will be permanently deleted. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
              <Button size="sm" variant="destructive" onClick={handleDeleteConfirm}>Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
