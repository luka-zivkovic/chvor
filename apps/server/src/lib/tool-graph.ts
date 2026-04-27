import {
  bumpEdge,
  decayAllStrengths as dbDecayAll,
  getEdgesAmong,
  getNodes,
  getOrCreateNode,
  pairKey,
  updateNode,
  type ToolEdge,
  type ToolNode,
} from "../db/tool-graph-store.ts";

/**
 * Cognitive Tool Graph (Phase G).
 *
 * Treats tools the way chvor treats memory:
 *   - Each tool has a STRENGTH that rises with success and decays with disuse.
 *   - Pairs of tools used together successfully form a HEBBIAN edge.
 *   - Per-turn ranking uses a composite score across multiple signals.
 *
 * This module is the algorithm layer. It never reads/writes events directly;
 * the orchestrator calls `recordToolOutcome` after each tool call and
 * `rankTools` when building the per-turn bag.
 *
 * Fail-safes built in (per `unified-model.md` §6 in the design):
 *   - Strength floor (0.1) — nodes never decay to zero.
 *   - Trial boost — newly created nodes start at 1.5 strength + a 20-turn
 *     grace period before decay can bite.
 *   - Always-available tools (criticality tag) bypass the score entirely
 *     in the orchestrator's filter step; the graph just observes them.
 */

// Tunable constants — kept as exports so tests + the debug route can read them.

/** Strength floor — nodes asymptote here, never below. */
export const STRENGTH_FLOOR = 0.1;
/** Strength ceiling — prevents one runaway-popular tool from dominating. */
export const STRENGTH_CEILING = 2.0;
/** Multiplicative success factor + additive bonus → settles ~1.4 after a few wins. */
export const SUCCESS_MULTIPLIER = 1.05;
export const SUCCESS_ADDITIVE = 0.02;
/** Multiplicative failure factor — failures are punished more than successes reward. */
export const FAILURE_MULTIPLIER = 0.9;
/** Decay multiplier applied each periodic tick. */
export const DECAY_MULTIPLIER = 0.98;
/** Initial strength for a brand-new tool node. */
export const INITIAL_STRENGTH = 1.5;
/** How many invocations a new node enjoys before decay can apply (currently advisory — see updateAfterSuccess). */
export const DEFAULT_TRIAL_BOOST = 20;
/** Hebbian weight increment per successful co-use. */
export const EDGE_INCREMENT = 0.1;

// ── Outcome recording ──────────────────────────────────────────

export interface RecordOutcomeArgs {
  toolName: string;
  success: boolean;
  /** Other tools that already succeeded earlier in the same turn. */
  recentlySucceeded?: string[];
}

export interface RecordOutcomeResult {
  before: ToolNode;
  after: ToolNode;
  /** Edges newly bumped (canonical pair keys) — for canvas events. */
  edgesBumped: Array<{ a: string; b: string }>;
}

/**
 * Record a single tool outcome:
 *   - Updates the node's strength + counters
 *   - For successes, bumps Hebbian edges to every prior success in the same turn
 */
export function recordToolOutcome(args: RecordOutcomeArgs): RecordOutcomeResult {
  const before = getOrCreateNode(args.toolName, {
    initialStrength: INITIAL_STRENGTH,
    trialBoost: DEFAULT_TRIAL_BOOST,
  });
  const now = new Date().toISOString();

  let strength = before.strength;
  if (args.success) {
    strength = Math.min(STRENGTH_CEILING, strength * SUCCESS_MULTIPLIER + SUCCESS_ADDITIVE);
  } else {
    strength = Math.max(STRENGTH_FLOOR, strength * FAILURE_MULTIPLIER);
  }

  updateNode(args.toolName, {
    strength,
    invocationDelta: 1,
    successDelta: args.success ? 1 : 0,
    failureDelta: args.success ? 0 : 1,
    consumeTrialBoost: 1,
    lastUsedAt: now,
  });

  const edgesBumped: Array<{ a: string; b: string }> = [];
  if (args.success && args.recentlySucceeded?.length) {
    for (const peer of args.recentlySucceeded) {
      if (peer === args.toolName) continue;
      // Make sure the peer node exists first so the FK-style join queries
      // later work without surprise nulls.
      getOrCreateNode(peer, { initialStrength: INITIAL_STRENGTH, trialBoost: DEFAULT_TRIAL_BOOST });
      bumpEdge(args.toolName, peer, EDGE_INCREMENT);
      edgesBumped.push({ a: args.toolName < peer ? args.toolName : peer, b: args.toolName < peer ? peer : args.toolName });
    }
  }

  const after: ToolNode = {
    ...before,
    strength,
    invocationCount: before.invocationCount + 1,
    successCount: before.successCount + (args.success ? 1 : 0),
    failureCount: before.failureCount + (args.success ? 0 : 1),
    trialBoostRemaining: Math.max(0, before.trialBoostRemaining - 1),
    lastUsedAt: now,
  };

  return { before, after, edgesBumped };
}

// ── Periodic decay ─────────────────────────────────────────────

export function decayStrengths(): { rowsAffected: number; rate: number; floor: number } {
  const rowsAffected = dbDecayAll(DECAY_MULTIPLIER, STRENGTH_FLOOR);
  return { rowsAffected, rate: DECAY_MULTIPLIER, floor: STRENGTH_FLOOR };
}

// ── Composite scoring + ranking ───────────────────────────────

export interface ScoreContext {
  /** Tools recently fired in this conversation (most recent last). */
  recentTools?: string[];
  /** Active tool groups (e.g. ["core","web"]) — used as the category signal. */
  activeGroups?: string[];
  /** Per-tool group lookup; if omitted, category contribution is 0. */
  groupOf?: (toolName: string) => string | undefined;
}

export interface ScoreBreakdown {
  toolName: string;
  strength: number;
  coActivation: number;
  category: number;
  composite: number;
}

const W_STRENGTH = 0.5;
const W_CO_ACTIVATION = 0.3;
const W_CATEGORY = 0.2;

/**
 * Compute a composite score for a single tool given the current context.
 * Range is roughly 0..2 — useful for relative ordering, not absolute meaning.
 *
 * NOTE on coverage: semantic-match (Phase F) and emotion-risk (Phase H) are
 * intentionally absent. They'll plug in later as additional weighted signals.
 */
export function scoreTool(
  node: ToolNode | null,
  toolName: string,
  edgesByPair: Map<string, ToolEdge>,
  ctx: ScoreContext
): ScoreBreakdown {
  const strength = node ? clamp01(node.strength / STRENGTH_CEILING) : 0.5; // unknown tool → neutral
  const recent = ctx.recentTools ?? [];

  // Co-activation: average edge weight to recently-used tools.
  let coActivation = 0;
  if (recent.length > 0) {
    let sum = 0;
    let counted = 0;
    for (const peer of recent) {
      if (peer === toolName) continue;
      const [a, b] = pairKey(toolName, peer);
      const edge = edgesByPair.get(`${a}|${b}`);
      if (edge) {
        sum += edge.weight;
        counted++;
      }
    }
    coActivation = counted > 0 ? sum / counted : 0;
  }

  // Category match: 1 when the tool's group is in the active set, else 0.
  let category = 0;
  if (ctx.activeGroups?.length && ctx.groupOf) {
    const g = ctx.groupOf(toolName);
    category = g && ctx.activeGroups.includes(g) ? 1 : 0;
  }

  const composite =
    W_STRENGTH * strength + W_CO_ACTIVATION * coActivation + W_CATEGORY * category;

  return { toolName, strength, coActivation, category, composite };
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Rank a candidate set of tool names by composite score. Returns tools
 * sorted by descending composite score, with the per-signal breakdown so
 * the canvas/debug route can show "why this order".
 */
export function rankTools(
  candidates: string[],
  ctx: ScoreContext = {}
): ScoreBreakdown[] {
  if (candidates.length === 0) return [];

  const nodes = getNodes(candidates);

  // Pull every edge among (candidates ∪ recent) so co-activation lookups are O(1).
  const pool = new Set<string>(candidates);
  for (const t of ctx.recentTools ?? []) pool.add(t);
  const edges = getEdgesAmong(Array.from(pool));
  const edgesByPair = new Map<string, ToolEdge>();
  for (const e of edges) edgesByPair.set(`${e.toolA}|${e.toolB}`, e);

  return candidates
    .map((name) => scoreTool(nodes.get(name) ?? null, name, edgesByPair, ctx))
    .sort((a, b) => b.composite - a.composite);
}
