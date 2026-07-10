import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import type { ModelDef } from "@chvor/shared";
import { CAPABILITY_COLORS, formatCost, formatCtx } from "./model-utils";

/* ─── Model Dropdown ─── */

export function ModelDropdown({
  models,
  selectedModelId,
  onSelect,
  loading,
  allowFreeText,
}: {
  models: ModelDef[];
  selectedModelId: string;
  onSelect: (modelId: string) => void;
  loading: boolean;
  allowFreeText?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [freeText, setFreeText] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);

  const selectedModel = models.find((m) => m.id === selectedModelId);

  const filtered = search
    ? models.filter((m) =>
        m.name.toLowerCase().includes(search.toLowerCase()) ||
        m.id.toLowerCase().includes(search.toLowerCase())
      )
    : models;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus search on open
  useEffect(() => {
    if (open) {
      searchRef.current?.focus();
      setHighlightIdx(0);
    }
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlightIdx]) {
        onSelect(filtered[highlightIdx].id);
        setOpen(false);
        setSearch("");
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setSearch("");
    }
  };

  return (
    <div ref={dropdownRef} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
          open ? "border-primary/50 bg-primary/5" : "border-border/50 bg-muted/5 hover:border-border/80"
        )}
      >
        <div className="flex-1 min-w-0">
          {selectedModel ? (
            <div>
              <p className="text-xs font-medium text-foreground truncate">{selectedModel.name}</p>
              <div className="flex items-center gap-2 mt-0.5">
                {selectedModel.contextWindow > 0 && (
                  <span className="text-[9px] text-muted-foreground">
                    {formatCtx(selectedModel.contextWindow)} ctx
                  </span>
                )}
                {selectedModel.cost && (
                  <span className="text-[9px] text-muted-foreground">
                    {formatCost(selectedModel.cost)}/M
                  </span>
                )}
              </div>
            </div>
          ) : selectedModelId ? (
            <p className="text-xs text-foreground truncate">{selectedModelId}</p>
          ) : (
            <p className="text-xs text-muted-foreground/50">Select a model...</p>
          )}
        </div>
        {loading ? (
          <span className="text-[9px] text-muted-foreground animate-pulse shrink-0">loading...</span>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-border/50 bg-card shadow-lg overflow-hidden">
          {/* Search */}
          {(models.length > 4 || allowFreeText) && (
            <div className="border-b border-border/30 p-1.5">
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setHighlightIdx(0); }}
                onKeyDown={handleKeyDown}
                placeholder={allowFreeText ? "Search or type model ID..." : "Search models..."}
                className="w-full rounded bg-transparent px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/40 outline-none"
              />
            </div>
          )}

          {/* Model list */}
          <div className="max-h-[240px] overflow-y-auto py-1">
            {filtered.length === 0 && !allowFreeText && (
              <p className="px-3 py-2 text-[10px] text-muted-foreground/60">No models found</p>
            )}
            {filtered.map((m, idx) => {
              const isSelected = m.id === selectedModelId;
              const isHighlighted = idx === highlightIdx;
              return (
                <button
                  key={m.id}
                  onClick={() => { onSelect(m.id); setOpen(false); setSearch(""); }}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  className={cn(
                    "flex w-full flex-col items-start px-3 py-2 text-left transition-colors",
                    isHighlighted ? "bg-primary/10" : "hover:bg-muted/20",
                    isSelected && "border-l-2 border-primary"
                  )}
                >
                  <div className="flex w-full items-center gap-2">
                    <span className={cn("text-xs font-medium", isSelected ? "text-primary" : "text-foreground")}>
                      {m.name}
                    </span>
                    {isSelected && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-primary ml-auto shrink-0">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    {m.contextWindow > 0 && (
                      <span className="rounded bg-muted/30 px-1 py-0.5 text-[9px] text-muted-foreground">
                        {formatCtx(m.contextWindow)}
                      </span>
                    )}
                    {m.cost && (
                      <span className="rounded bg-muted/30 px-1 py-0.5 text-[9px] text-muted-foreground">
                        {formatCost(m.cost)}/M
                      </span>
                    )}
                    {m.capabilities?.map((cap) => (
                      <span key={cap} className={cn("rounded px-1 py-0.5 text-[9px]", CAPABILITY_COLORS[cap] ?? "bg-muted/30 text-muted-foreground")}>
                        {cap}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}

            {/* Free text option when search doesn't match */}
            {allowFreeText && search.trim() && !filtered.some((m) => m.id === search.trim()) && (
              <button
                onClick={() => { onSelect(search.trim()); setOpen(false); setSearch(""); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 border-t border-border/20"
              >
                <span className="text-xs text-muted-foreground">Use custom:</span>
                <span className="text-xs font-medium text-foreground font-mono">{search.trim()}</span>
              </button>
            )}
          </div>

          {/* Free text input for providers that support it */}
          {allowFreeText && !search && (
            <div className="border-t border-border/30 p-2">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={freeText}
                  onChange={(e) => setFreeText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && freeText.trim()) {
                      onSelect(freeText.trim());
                      setFreeText("");
                      setOpen(false);
                    }
                  }}
                  placeholder="Custom model ID..."
                  className="flex-1 rounded border border-border/50 bg-transparent px-2 py-1 font-mono text-[10px] text-foreground placeholder:text-muted-foreground/40 outline-none"
                />
                <button
                  onClick={() => { if (freeText.trim()) { onSelect(freeText.trim()); setFreeText(""); setOpen(false); } }}
                  disabled={!freeText.trim()}
                  className="rounded bg-primary/15 px-2 py-1 text-[10px] font-medium text-primary hover:bg-primary/25 disabled:opacity-40"
                >
                  Use
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
