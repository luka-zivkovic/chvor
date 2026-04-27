import { useEffect, useState } from "react";
import { useFeatureStore } from "../../stores/feature-store";
import { MemoryList } from "../memory/MemoryList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function MemoryPanel() {
  const { fetchMemories: fetchAll, clearAll, addMemory, memories, memoriesLoading: loading, memoriesError: error } = useFeatureStore();
  const [confirmClear, setConfirmClear] = useState(false);
  const [newFact, setNewFact] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleClearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    await clearAll();
    setConfirmClear(false);
  };

  const handleAddFact = async () => {
    const trimmed = newFact.trim();
    if (!trimmed) return;
    await addMemory(trimmed);
    setNewFact("");
  };

  const filtered = search.trim()
    ? memories.filter((m) =>
        m.content.toLowerCase().includes(search.toLowerCase())
      )
    : memories;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Facts [{filtered.length}]
        </h3>
        {memories.length > 0 && (
          <Button
            variant={confirmClear ? "destructive" : "ghost"}
            size="sm"
            onClick={handleClearAll}
            onBlur={() => setConfirmClear(false)}
          >
            {confirmClear ? "Confirm Clear?" : "Clear All"}
          </Button>
        )}
      </div>

      <div className="flex gap-2">
        <Input
          value={newFact}
          onChange={(e) => setNewFact(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAddFact();
          }}
          placeholder="Add a fact..."
          className="h-8 text-xs"
        />
        <Button
          size="sm"
          onClick={handleAddFact}
          disabled={!newFact.trim()}
          className="h-8 shrink-0"
        >
          Add
        </Button>
      </div>

      {memories.length > 5 && (
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search memories..."
          className="h-8 text-xs"
        />
      )}

      {loading && (
        <p className="text-xs text-muted-foreground">Loading...</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!loading && !error && <MemoryList memories={filtered} />}
    </div>
  );
}
