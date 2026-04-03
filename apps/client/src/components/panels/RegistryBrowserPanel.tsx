import { useEffect, useState } from "react";
import { useRegistryStore, type RegistryEntryWithStatus } from "../../stores/registry-store";
import { useSkillStore } from "../../stores/skill-store";
import { useToolStore } from "../../stores/tool-store";
import { useScheduleStore } from "../../stores/schedule-store";
import { useCredentialStore } from "../../stores/credential-store";
import { TemplateSetupWizard } from "../templates/TemplateSetupWizard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { RegistryEntryKind, TemplateManifest } from "@chvor/shared";

const CATEGORIES = [
  { value: "", label: "All" },
  { value: "ai", label: "AI" },
  { value: "communication", label: "Communication" },
  { value: "data", label: "Data" },
  { value: "developer", label: "Developer" },
  { value: "file", label: "File" },
  { value: "productivity", label: "Productivity" },
  { value: "web", label: "Web" },
];

const KIND_FILTERS: { value: RegistryEntryKind | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "skill", label: "Skills" },
  { value: "tool", label: "Tools" },
  { value: "template", label: "Templates" },
];

function EntryCard({
  entry,
  onInstall,
  onUninstall,
  onTemplateClick,
}: {
  entry: RegistryEntryWithStatus;
  onInstall: (id: string, kind?: RegistryEntryKind) => void;
  onUninstall: (id: string) => void;
  onTemplateClick?: (entry: RegistryEntryWithStatus) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleAction = async (action: "install" | "uninstall") => {
    setLoading(true);
    try {
      if (action === "install") await onInstall(entry.id, entry.kind);
      else await onUninstall(entry.id);
    } finally {
      setLoading(false);
    }
  };

  const isTemplate = entry.kind === "template";

  return (
    <div
      className="rounded-lg border border-border/50 bg-muted/10 p-3 transition-colors hover:bg-muted/20 cursor-pointer"
      onClick={() => isTemplate && onTemplateClick ? onTemplateClick(entry) : setExpanded(!expanded)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">
              {entry.name}
            </span>
            <span className="text-[10px] text-muted-foreground font-mono">
              v{entry.version}
            </span>
            {entry.kind !== "skill" && (
              <Badge variant="outline" className="rounded-full text-[8px] px-1.5 py-0 capitalize">
                {entry.kind}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground line-clamp-2">
            {entry.description}
          </p>
        </div>
        {isTemplate ? (
          <Button
            size="sm"
            variant={entry.installed ? "outline" : "default"}
            className="h-6 shrink-0 text-[10px] px-2"
            disabled={loading}
            onClick={(e) => {
              e.stopPropagation();
              if (entry.installed) handleAction("uninstall");
              else onTemplateClick?.(entry);
            }}
          >
            {loading ? "..." : entry.installed ? "Uninstall" : "Set up"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant={entry.installed ? "outline" : "default"}
            className="h-6 shrink-0 text-[10px] px-2"
            disabled={loading}
            onClick={(e) => {
              e.stopPropagation();
              handleAction(entry.installed ? "uninstall" : "install");
            }}
          >
            {loading ? "..." : entry.installed ? "Uninstall" : "Install"}
          </Button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {entry.category && (
          <Badge variant="secondary" className="rounded-full text-[8px] px-1.5 py-0">
            {entry.category}
          </Badge>
        )}
        {entry.tags?.slice(0, 3).map((tag) => (
          <Badge key={tag} variant="outline" className="rounded-full text-[8px] px-1.5 py-0">
            {tag}
          </Badge>
        ))}
        {entry.installed && (
          <Badge variant="default" className="rounded-full text-[8px] px-1.5 py-0">
            installed
          </Badge>
        )}
      </div>

      {expanded && (
        <div className="mt-3 border-t border-border/30 pt-2 text-[10px] text-muted-foreground space-y-1">
          {entry.author && <p>Author: {entry.author}</p>}
          {entry.license && <p>License: {entry.license}</p>}
          {entry.downloads !== undefined && <p>Downloads: {entry.downloads}</p>}
          {entry.dependencies && entry.dependencies.length > 0 && (
            <p>Dependencies: {entry.dependencies.join(", ")}</p>
          )}
          {entry.includes && entry.includes.length > 0 && (
            <p>Includes: {entry.includes.join(", ")}</p>
          )}
          {entry.requires?.credentials && entry.requires.credentials.length > 0 && (
            <p>Requires: {entry.requires.credentials.join(", ")}</p>
          )}
          {entry.installed && entry.installedVersion && entry.installedVersion !== entry.version && (
            <p className="text-amber-500">
              Update available: v{entry.installedVersion} → v{entry.version}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function RegistryBrowserPanel() {
  const {
    entries,
    loading,
    error,
    searchQuery,
    categoryFilter,
    kindFilter,
    availableUpdates,
    search,
    install,
    uninstall,
    applyAllUpdates,
    checkUpdates,
    setKindFilter,
  } = useRegistryStore();
  const { fetchSkills } = useSkillStore();
  const { fetchTools } = useToolStore();
  const { fetchAll: fetchSchedules } = useScheduleStore();
  const { fetchAll: fetchCredentials } = useCredentialStore();

  const [inputValue, setInputValue] = useState(searchQuery);
  const [activeTemplate, setActiveTemplate] = useState<{ id: string; manifest: TemplateManifest } | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);

  useEffect(() => {
    search();
    checkUpdates();
  }, []);

  const handleSearch = () => {
    search(inputValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  const refreshCapabilities = () => {
    fetchSkills();
    fetchTools();
    fetchSchedules();
    fetchCredentials();
  };

  const handleInstall = async (id: string, kind?: RegistryEntryKind) => {
    await install(id, kind);
    refreshCapabilities();
  };

  const handleUninstall = async (id: string) => {
    await uninstall(id);
    refreshCapabilities();
  };

  const handleTemplateClick = async (entry: RegistryEntryWithStatus) => {
    setTemplateLoading(true);
    setTemplateError(null);
    try {
      const manifest = await api.templates.getManifest(entry.id);
      setActiveTemplate({ id: entry.id, manifest });
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : String(err));
    } finally {
      setTemplateLoading(false);
    }
  };

  const handleTemplateActivate = async () => {
    if (!activeTemplate) return;
    try {
      await install(activeTemplate.id, "template");
      refreshCapabilities();
      setActiveTemplate(null);
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Template wizard modal */}
      {activeTemplate && (
        <TemplateSetupWizard
          template={activeTemplate.manifest}
          onComplete={handleTemplateActivate}
          onCancel={() => setActiveTemplate(null)}
        />
      )}

      {/* Template loading/error */}
      {templateLoading && (
        <div className="flex items-center justify-center rounded-lg border border-border/50 bg-muted/10 px-3 py-4">
          <span className="text-[10px] text-muted-foreground">Loading template...</span>
        </div>
      )}
      {templateError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[10px] text-destructive">{templateError}</p>
        </div>
      )}

      {/* Update banner */}
      {availableUpdates.length > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <span className="text-[10px] text-amber-500">
            {availableUpdates.length} update{availableUpdates.length > 1 ? "s" : ""} available
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-5 text-[10px] px-2 border-amber-500/30 text-amber-500 hover:bg-amber-500/10"
            onClick={() => applyAllUpdates().then(refreshCapabilities)}
          >
            Update All
          </Button>
        </div>
      )}

      {/* Search */}
      <div className="flex gap-1.5">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search registry..."
          className="flex-1 rounded-md border border-border/50 bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[10px] px-2"
          onClick={handleSearch}
        >
          Search
        </Button>
      </div>

      {/* Kind filter */}
      <div className="flex gap-1">
        {KIND_FILTERS.map(({ value, label }) => (
          <button
            key={label}
            onClick={() => setKindFilter(value)}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[9px] font-medium transition-colors",
              kindFilter === value
                ? "bg-primary text-primary-foreground"
                : "bg-muted/20 text-muted-foreground hover:bg-muted/40",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap gap-1">
        {CATEGORIES.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => search(inputValue, value)}
            className={cn(
              "rounded-full px-2 py-0.5 text-[9px] transition-colors",
              (categoryFilter ?? "") === value
                ? "bg-primary text-primary-foreground"
                : "bg-muted/20 text-muted-foreground hover:bg-muted/40",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-4 text-center">
          <p className="text-[10px] text-destructive">{error}</p>
          <Button
            size="sm"
            variant="outline"
            className="h-5 text-[10px] px-2"
            onClick={() => search(inputValue)}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Results */}
      {loading ? (
        <p className="py-8 text-center text-[10px] text-muted-foreground">
          Searching registry...
        </p>
      ) : !error && entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
          <p className="text-xs text-muted-foreground">No entries found</p>
          <p className="text-[10px] text-muted-foreground/60">
            {searchQuery
              ? "Try a different search term"
              : "The registry appears empty"}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[10px] text-muted-foreground">
            {entries.length} {kindFilter ? `${kindFilter}${entries.length !== 1 ? "s" : ""}` : `entr${entries.length !== 1 ? "ies" : "y"}`}
          </p>
          {entries.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              onInstall={handleInstall}
              onUninstall={handleUninstall}
              onTemplateClick={handleTemplateClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
