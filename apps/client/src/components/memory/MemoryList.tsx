import type { Memory } from "@chvor/shared";
import { MemoryCard } from "./MemoryCard";

interface Props {
  memories: Memory[];
}

export function MemoryList({ memories }: Props) {
  if (memories.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/50">
          <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
          <path d="M8.5 8.5v.01" /><path d="M16 15.5v.01" /><path d="M12 12v.01" />
        </svg>
        <p className="text-[11px] text-muted-foreground">
          No memories yet. Your AI learns from conversations.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {memories.map((m) => (
        <MemoryCard key={m.id} memory={m} />
      ))}
    </div>
  );
}
