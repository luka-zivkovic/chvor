import { useState, useEffect, useRef, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSkillStore } from "../../stores/skill-store";
import { useToolStore } from "../../stores/tool-store";
import type { RegistryEntry, RegistryEntryKind } from "@chvor/shared";

type SearchResult = RegistryEntry & { installed: boolean; installedVersion: string | null };

interface Props {
  kind: RegistryEntryKind;
  onInstalled?: () => void;
}

export function RegistrySearchBar({ kind, onInstalled }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const doSearch = useCallback(async (q: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = await api.registry.search({ q: q || undefined, kind });
      if (controller.signal.aborted) return;
      setResults(data.filter((e) => e.kind !== "template"));
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [kind]);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (!expanded) setExpanded(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
  };

  const handleFocus = () => {
    if (!expanded) {
      setExpanded(true);
      doSearch(query);
    }
  };

  const handleInstall = async (entry: SearchResult) => {
    setInstalling((prev) => new Set(prev).add(entry.id));
    try {
      await api.registry.install(entry.id, entry.kind);
      useSkillStore.getState().fetchSkills();
      useToolStore.getState().fetchTools();
      setResults((prev) =>
        prev.map((r) => r.id === entry.id ? { ...r, installed: true, installedVersion: r.version } : r),
      );
      onInstalled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling((prev) => { const next = new Set(prev); next.delete(entry.id); return next; });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Search input */}
      <div
        className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/10 px-2.5 py-1.5 transition-colors focus-within:border-primary/40"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/50">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onFocus={handleFocus}
          placeholder={`Search registry for ${kind}s...`}
          className="flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
        />
        {expanded && (
          <button
            onClick={() => { setExpanded(false); setQuery(""); setResults([]); }}
            className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Results (when expanded) */}
      {expanded && (
        <div className="flex flex-col gap-1 max-h-[280px] overflow-y-auto">
          {loading && results.length === 0 ? (
            <p className="py-4 text-center text-[10px] text-muted-foreground">Searching...</p>
          ) : error ? (
            <div className="px-2 py-3 text-center">
              <p className="text-[10px] text-destructive">{error}</p>
              <Button size="sm" variant="outline" className="mt-1.5 h-5 text-[9px] px-2" onClick={() => doSearch(query)}>
                Retry
              </Button>
            </div>
          ) : results.length === 0 ? (
            <p className="py-4 text-center text-[10px] text-muted-foreground">
              {query ? "No results found" : "No entries available"}
            </p>
          ) : (
            results.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/30 bg-muted/5 px-2.5 py-2 transition-colors hover:bg-muted/15"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium text-foreground truncate">{entry.name}</span>
                    <span className="text-[8px] text-muted-foreground/50 font-mono">v{entry.version}</span>
                  </div>
                  <p className="mt-0.5 text-[9px] text-muted-foreground line-clamp-1">{entry.description}</p>
                  <div className="mt-1 flex gap-1">
                    {entry.category && (
                      <Badge variant="secondary" className="rounded-full text-[7px] px-1 py-0">{entry.category}</Badge>
                    )}
                    {entry.tags?.slice(0, 2).map((tag) => (
                      <Badge key={tag} variant="outline" className="rounded-full text-[7px] px-1 py-0">{tag}</Badge>
                    ))}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={entry.installed ? "outline" : "default"}
                  className="h-6 shrink-0 text-[9px] px-2"
                  disabled={entry.installed || installing.has(entry.id)}
                  onClick={() => handleInstall(entry)}
                >
                  {installing.has(entry.id) ? "..." : entry.installed ? "Installed" : "Install"}
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
