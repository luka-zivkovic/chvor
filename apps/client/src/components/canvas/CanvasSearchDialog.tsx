import { useState, useEffect, useRef, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useSkillStore } from "../../stores/skill-store";
import { useToolStore } from "../../stores/tool-store";
import type { RegistryEntry, RegistryEntryKind } from "@chvor/shared";

type SearchResult = RegistryEntry & { installed: boolean; installedVersion: string | null };

const KIND_PILLS: { value: RegistryEntryKind | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "skill", label: "Skills" },
  { value: "tool", label: "Tools" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  initialKind?: RegistryEntryKind | null;
}

export function CanvasSearchDialog({ open, onClose, initialKind = null }: Props) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<RegistryEntryKind | null>(initialKind);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setQuery("");
      setResults([]);
      setError(null);
      // Fetch initial results
      doSearch("", initialKind);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, initialKind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  // Clean up debounce on unmount
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid closing from the same click that opened it
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 100);
    return () => { clearTimeout(timer); document.removeEventListener("mousedown", handler); };
  }, [open, onClose]);

  const doSearch = useCallback(async (q: string, k: RegistryEntryKind | null) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.registry.search({
        q: q || undefined,
        kind: k || undefined,
      });
      // Filter out templates — they need the setup wizard, not one-click install
      setResults(data.filter((e) => e.kind !== "template"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value, kind), 300);
  };

  const handleKindChange = (k: RegistryEntryKind | null) => {
    setKind(k);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    doSearch(query, k);
  };

  const handleInstall = async (entry: SearchResult) => {
    setInstalling((prev) => new Set(prev).add(entry.id));
    try {
      await api.registry.install(entry.id, entry.kind);
      // Refresh stores so canvas re-renders
      useSkillStore.getState().fetchSkills();
      useToolStore.getState().fetchTools();
      // Update local result state
      setResults((prev) =>
        prev.map((r) => r.id === entry.id ? { ...r, installed: true, installedVersion: r.version } : r),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling((prev) => { const next = new Set(prev); next.delete(entry.id); return next; });
    }
  };

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      className="fixed left-1/2 top-1/2 z-50 flex w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl"
      style={{
        background: "var(--glass-bg-strong)",
        backdropFilter: "blur(20px) saturate(1.1)",
        WebkitBackdropFilter: "blur(20px) saturate(1.1)",
        border: "1px solid var(--glass-border)",
        boxShadow: "0 8px 32px oklch(0 0 0 / 0.5), 0 0 0 1px oklch(1 0 0 / 0.03)",
        maxHeight: "min(520px, 70vh)",
      }}
    >
      {/* Search input */}
      <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: "var(--glass-border)" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Search skills & tools..."
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
        />
        <kbd className="hidden sm:inline-flex items-center rounded border border-border/50 px-1.5 py-0.5 text-[9px] text-muted-foreground/60 font-mono">
          ESC
        </kbd>
      </div>

      {/* Kind filter pills */}
      <div className="flex gap-1 px-3 py-2" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        {KIND_PILLS.map(({ value, label }) => (
          <button
            key={label}
            onClick={() => handleKindChange(value)}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[9px] font-medium transition-colors",
              kind === value
                ? "bg-primary text-primary-foreground"
                : "bg-muted/20 text-muted-foreground hover:bg-muted/40",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1.5" style={{ maxHeight: "calc(min(520px, 70vh) - 90px)" }}>
        {loading && results.length === 0 ? (
          <p className="py-8 text-center text-[10px] text-muted-foreground">Searching...</p>
        ) : error ? (
          <div className="px-2 py-4 text-center">
            <p className="text-[10px] text-destructive">{error}</p>
            <Button size="sm" variant="outline" className="mt-2 h-5 text-[10px] px-2" onClick={() => doSearch(query, kind)}>
              Retry
            </Button>
          </div>
        ) : results.length === 0 ? (
          <p className="py-8 text-center text-[10px] text-muted-foreground">
            {query ? "No results found" : "No entries available"}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {results.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--glass-bg)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium text-foreground truncate">{entry.name}</span>
                    <span className="text-[9px] text-muted-foreground/60 font-mono">v{entry.version}</span>
                    {entry.kind === "tool" && (
                      <Badge variant="outline" className="rounded-full text-[7px] px-1 py-0">tool</Badge>
                    )}
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
