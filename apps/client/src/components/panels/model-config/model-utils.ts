/* ─── Helpers ─── */

export function formatCtx(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${Math.round(tokens / 1_000)}K`;
}

export function formatCost(cost: { input: number; output: number }): string {
  return `$${cost.input}/${cost.output}`;
}

export const CAPABILITY_COLORS: Record<string, string> = {
  vision: "bg-purple-500/15 text-purple-400",
  reasoning: "bg-blue-500/15 text-blue-400",
  toolUse: "bg-emerald-500/15 text-emerald-400",
  code: "bg-amber-500/15 text-amber-400",
};
