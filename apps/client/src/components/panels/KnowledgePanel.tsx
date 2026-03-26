import { useEffect, useState } from "react";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { UploadZone } from "@/components/knowledge/UploadZone";
import { ResourceCard } from "@/components/knowledge/ResourceCard";

export function KnowledgePanel() {
  const {
    resources,
    loading,
    uploading,
    error,
    fetchAll,
    uploadFile,
    ingestUrl,
    deleteResource,
  } = useKnowledgeStore();

  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const filtered = search
    ? resources.filter((r) =>
        r.title.toLowerCase().includes(search.toLowerCase()) ||
        r.type.toLowerCase().includes(search.toLowerCase()),
      )
    : resources;

  return (
    <div className="flex h-full flex-col">
      {/* Upload section */}
      <div className="shrink-0 border-b border-border/50 px-5 py-4">
        <UploadZone
          onUpload={uploadFile}
          onIngestUrl={ingestUrl}
          uploading={uploading}
        />
      </div>

      {/* Header + search */}
      <div className="flex shrink-0 items-center gap-2 px-5 py-3">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Resources [{filtered.length}]
        </span>
        <div className="flex-1" />
        {resources.length > 5 && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="h-6 w-32 rounded border border-border/50 bg-background px-2 text-[10px] placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none"
          />
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-5 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Resource list */}
      <div className="flex-1 overflow-y-auto px-5 pb-4">
        {loading && resources.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">Loading...</p>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            {resources.length === 0
              ? "No resources yet. Upload a file or paste a URL to get started."
              : "No matching resources."}
          </p>
        ) : (
          <div className="space-y-2">
            {filtered.map((resource) => (
              <ResourceCard
                key={resource.id}
                resource={resource}
                onDelete={deleteResource}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
