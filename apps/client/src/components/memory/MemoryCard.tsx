import { useState, useRef } from "react";
import type { Memory } from "@chvor/shared";
import { useMemoryStore } from "../../stores/memory-store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";

interface Props {
  memory: Memory;
}

const CATEGORY_COLORS: Record<string, string> = {
  profile: "text-blue-400",
  preference: "text-purple-400",
  entity: "text-green-400",
  event: "text-amber-400",
  pattern: "text-cyan-400",
  case: "text-rose-400",
};

export function MemoryCard({ memory }: Props) {
  const { removeMemory, updateMemory } = useMemoryStore();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(memory.content);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const handleEdit = () => {
    setEditing(true);
    setEditValue(memory.content);
    setConfirmDelete(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSave = async () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === memory.content) {
      setEditing(false);
      return;
    }
    await updateMemory(memory.id, trimmed);
    setEditing(false);
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await removeMemory(memory.id);
  };

  const strengthPercent = Math.round((memory.strength ?? 1) * 100);

  return (
    <Card className="border-l-2 border-l-border transition-colors hover:border-border/80">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editing ? (
              <Textarea
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleSave}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSave();
                  }
                  if (e.key === "Escape") {
                    setEditing(false);
                    setEditValue(memory.content);
                  }
                }}
                rows={2}
                className="resize-none"
              />
            ) : (
              <p
                className="cursor-pointer text-sm text-foreground"
                onClick={handleEdit}
                title="Click to edit"
              >
                {memory.content}
              </p>
            )}
            <div className="mt-1.5 flex items-center gap-2">
              <span className={`font-mono text-[10px] font-medium uppercase tracking-widest ${CATEGORY_COLORS[memory.category] ?? "text-muted-foreground"}`}>
                {memory.category}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {memory.sourceChannel}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/60">
                {new Date(memory.createdAt).toLocaleDateString()}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/40" title="Memory strength">
                {strengthPercent}%
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!editing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleEdit}
                className="h-auto px-2 py-1 text-[10px]"
              >
                Edit
              </Button>
            )}
            <Button
              variant={confirmDelete ? "destructive" : "ghost"}
              size="sm"
              onClick={handleDelete}
              onBlur={() => setConfirmDelete(false)}
              className="h-auto px-2 py-1 text-[10px]"
            >
              {confirmDelete ? "Confirm?" : "Del"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
