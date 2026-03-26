import { useAppStore } from "../../stores/app-store";

/** Estimates token usage from message content lengths. Rough heuristic: ~4 chars per token. */
function estimateTokens(messages: { content: string; role: string }[]): number {
  let total = 0;
  for (const msg of messages) {
    total += Math.ceil(msg.content.length / 4);
  }
  return total;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function TokenCounter() {
  const messages = useAppStore((s) => s.messages);
  const tokens = estimateTokens(messages);

  if (tokens === 0) return null;

  return (
    <div
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
      style={{
        background: "var(--glass-bg)",
        border: "1px solid var(--glass-border)",
      }}
      title={`Estimated tokens: ${tokens} (input + output)`}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
      <span className="font-mono text-[9px] font-medium text-muted-foreground">
        {formatTokens(tokens)} tokens
      </span>
    </div>
  );
}
