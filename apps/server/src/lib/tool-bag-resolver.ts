import type { Tool, ToolBagScope } from "@chvor/shared";
import { rankTools, type ScoreBreakdown } from "./tool-graph.ts";
import { semanticScoresFor } from "./tool-embeddings.ts";
import { getNativeToolGroupMap } from "./native-tools.ts";
import { getRecentSuccessfulToolsForSession } from "../db/event-store.ts";

/**
 * Tool-bag ordering resolver (Phase G+).
 *
 * Ranks the per-turn tool bag by the Cognitive Tool Graph's composite score
 * so the LLM sees the most-likely-relevant tools first. Pure ordering — no
 * tools are added or removed by this layer.
 *
 * Why ranking-only:
 *   - Phase C, D1 + Phase H already filter the bag (groups, denied, emotion
 *     gate). Anything that survives those layers is something we're willing
 *     to expose. Reordering is pure upside; dropping is a separate decision.
 *   - Small models are sensitive to system-prompt order — putting the
 *     highest-scoring tool first measurably improves selection quality.
 *   - Vercel AI SDK passes `tools` as an object whose key order is
 *     preserved, so reordering the def map is enough.
 *
 * Inputs gathered here so callers stay simple:
 *   - `recentTools`  — last successful tool names for this session
 *                      (queried from action_events)
 *   - `semanticScores` — per-candidate cosine similarity to the user query
 *   - `groupOf`      — native + frontmatter tool-group lookup
 */

export interface ResolveBagOrderingArgs {
  /** Tool descriptors that survived skill scoping + emotion gate. */
  candidates: Tool[];
  /**
   * Native tool def names already in the bag (e.g. "native__web_search") —
   * native tools don't appear in `candidates` because they live behind the
   * registry abstraction. We rank them too.
   */
  nativeNames: string[];
  /** User's last message (best-effort plain text). */
  query: string;
  /** Active scope from `resolveSkillBag` — supplies the category signal. */
  scope: ToolBagScope;
  /** Session id for recent-tool history lookup. */
  sessionId?: string;
  /** Cap for the recent-tools window. */
  recentLimit?: number;
}

export interface ResolveBagOrderingResult {
  /** Ranked tool names — most-likely-relevant first. */
  ranking: ScoreBreakdown[];
  /** The tool names recent-tools came from. */
  recentTools: string[];
  /** True when the embedder produced semantic scores for ≥ 1 candidate. */
  semanticActive: boolean;
}

/**
 * Compute the ranking for the per-turn tool bag. Always returns — failures
 * downgrade to "no signal for this candidate" rather than throwing.
 */
export async function resolveBagOrdering(
  args: ResolveBagOrderingArgs
): Promise<ResolveBagOrderingResult> {
  // Build the candidate name list. For MCP/synth Tools we use the toolId as
  // the canonical name (matching the embedder's storage convention) plus
  // every native tool name as-is.
  const allCandidates = [
    ...args.nativeNames,
    ...args.candidates.map((t) => t.id),
  ];

  // Recent-tools history (one DB query, cheap).
  let recentTools: string[] = [];
  if (args.sessionId) {
    try {
      recentTools = getRecentSuccessfulToolsForSession(args.sessionId, args.recentLimit ?? 10);
    } catch (err) {
      console.warn(
        "[tool-bag-resolver] recent-tools lookup failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // Semantic scores — empty Map when embedder is unavailable; rankTools
  // gracefully degrades to strength + co-activation + category in that case.
  let semanticScores = new Map<string, number>();
  if (args.query.trim().length > 0) {
    semanticScores = await semanticScoresFor(args.query, allCandidates);
  }

  // Group-of lookup. Native tools come from the module map; MCP/synth tools
  // expose `metadata.group` directly.
  const nativeMap = getNativeToolGroupMap();
  const candidateGroups = new Map<string, string>();
  for (const t of args.candidates) {
    if (t.metadata.group) candidateGroups.set(t.id, t.metadata.group);
  }
  const groupOf = (toolName: string): string | undefined => {
    const direct = nativeMap[toolName]?.group;
    if (direct) return direct;
    if (candidateGroups.has(toolName)) return candidateGroups.get(toolName);
    // Endpoint fall-through: "github__create_issue" → "github"
    const sep = toolName.indexOf("__");
    if (sep > 0) {
      const prefix = toolName.slice(0, sep);
      const fromCandidates = candidateGroups.get(prefix);
      if (fromCandidates) return fromCandidates;
      const fromNative = nativeMap[prefix]?.group;
      if (fromNative) return fromNative;
    }
    return undefined;
  };

  // Active groups for category-match scoring. The "*" sentinel means
  // permissive — every group counts as active.
  const groupsArray = Array.from(args.scope.groups);
  const activeGroups = groupsArray.includes("*")
    ? Array.from(new Set(allCandidates.map(groupOf).filter((g): g is string => !!g)))
    : (groupsArray.filter((g) => g !== "*") as string[]);

  const ranking = rankTools(allCandidates, {
    recentTools,
    activeGroups,
    groupOf,
    semanticScores: semanticScores.size > 0 ? semanticScores : undefined,
  });

  return {
    ranking,
    recentTools,
    semanticActive: semanticScores.size > 0,
  };
}

/**
 * Reorder a tool def map so its iteration order matches `ranking`. Tools
 * not present in the ranking keep their relative order at the end.
 *
 * Generic on T so the caller can keep its existing type (Vercel AI SDK
 * tool defs, or anything else key'd by qualified tool name).
 */
export function reorderDefsByRanking<T>(
  defs: Record<string, T>,
  ranking: ScoreBreakdown[]
): Record<string, T> {
  const out: Record<string, T> = {};
  const seen = new Set<string>();

  // Walk the ranking in order. For each entry, emit the exact-match def AND
  // every endpoint-prefix def ("github" → "github__create_issue", etc.) so
  // the toolId's score governs *all* of its endpoints' position in the bag.
  for (const r of ranking) {
    if (r.toolName in defs && !seen.has(r.toolName)) {
      out[r.toolName] = defs[r.toolName];
      seen.add(r.toolName);
    }
    const prefix = `${r.toolName}__`;
    for (const [name, def] of Object.entries(defs)) {
      if (seen.has(name)) continue;
      if (name.startsWith(prefix)) {
        out[name] = def;
        seen.add(name);
      }
    }
  }
  // Tail: anything we never matched, in original order.
  for (const [name, def] of Object.entries(defs)) {
    if (!seen.has(name)) out[name] = def;
  }
  return out;
}

/**
 * Reorder a Tool array (used by `buildSystemPrompt`) to match the ranking.
 * Tools not in the ranking keep their relative order at the end.
 */
export function reorderToolsByRanking(
  tools: Tool[],
  ranking: ScoreBreakdown[]
): Tool[] {
  const positionByName = new Map<string, number>();
  ranking.forEach((r, i) => positionByName.set(r.toolName, i));
  return [...tools].sort((a, b) => {
    const pa = positionByName.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const pb = positionByName.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}
