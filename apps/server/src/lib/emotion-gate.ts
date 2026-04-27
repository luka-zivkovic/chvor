import type {
  EmotionBucket,
  EmotionGatedToolsEvent,
  RiskTag,
  ToolGroupId,
} from "@chvor/shared";
import { getNativeToolGroupMap } from "./native-tools.ts";
import { loadTools } from "./capability-loader.ts";
import { getLatestEmotion } from "../db/emotion-store.ts";

/**
 * Phase H — Emotion-modulated risk gate.
 *
 * The genuinely-novel chvor bit: the user's affective state gates which
 * tools the LLM can call this turn. When VAD lands in the
 * `frustrated` / `hostile` buckets, we mask `destructive`-tagged tools
 * from the per-turn bag — the platform refuses to take dangerous
 * actions when the human is upset.
 *
 * Layers cleanly on top of:
 *   - Phase C tool-groups (the safety floor)
 *   - Phase D1 SecurityAnalyzer (run-time risk classification)
 *   - Phase G Cognitive Tool Graph (per-turn ranking)
 *
 * Tools tagged `criticality: always-available` bypass the gate (recall,
 * self-healing, etc. — same contract as everywhere else).
 */

// ── Settings ──────────────────────────────────────────────────

/** Default ON. Users opt out with CHVOR_EMOTION_GATE=0|false|off|no. */
export function isEmotionGateEnabled(): boolean {
  const raw = (process.env.CHVOR_EMOTION_GATE ?? "1").toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

// ── VAD → bucket ──────────────────────────────────────────────

/**
 * Map a VAD point into one of four behavioural buckets.
 * Thresholds chosen to be conservative — only the genuinely angry /
 * frustrated states gate tools; mild negativity stays neutral.
 */
export function bucketFromVAD(vad: { valence: number; arousal: number }): EmotionBucket {
  const v = vad.valence;
  const a = vad.arousal;

  // Hostile: clearly negative valence + high arousal → angry, agitated
  if (v <= -0.5 && a >= 0.4) return "hostile";

  // Frustrated: negative valence (any arousal level)
  if (v <= -0.25) return "frustrated";

  // Collaborative: positive valence + non-trivial activation
  if (v >= 0.4 && a >= 0.1) return "collaborative";

  return "neutral";
}

// ── Group-default risk classification ────────────────────────

/**
 * Default risk tag per tool-group when an explicit `riskTag` isn't
 * declared on the module / frontmatter. Conservative — when in doubt,
 * lean toward `moderate`.
 */
const GROUP_RISK_DEFAULT: Record<ToolGroupId, RiskTag> = {
  core: "safe",
  web: "safe",
  knowledge: "moderate",
  daemon: "moderate",
  files: "moderate",
  registry: "moderate",
  "skill-mgmt": "moderate",
  webhook: "moderate",
  a2ui: "safe",
  image: "safe",
  model: "safe",
  browser: "moderate",
  // External-effect groups: destructive by default.
  shell: "destructive",
  sandbox: "destructive",
  pc: "destructive",
  credentials: "destructive",
  social: "destructive",
  // Catch-alls — assume the worst until tagged explicitly.
  git: "moderate",
  crm: "destructive",
  comms: "destructive",
  dev: "moderate",
  data: "moderate",
  "integrations-other": "moderate",
};

export function defaultRiskForGroup(group: ToolGroupId | undefined): RiskTag {
  if (!group) return "moderate";
  return GROUP_RISK_DEFAULT[group] ?? "moderate";
}

// ── Tool risk lookup ─────────────────────────────────────────

/**
 * Effective risk tag + criticality for a single qualified tool name. Reads:
 *   1. Native module map (returns explicit riskTag or computes from group)
 *   2. MCP / synth tool frontmatter (riskTag override or group default)
 *
 * Cached per call into a Map so we don't re-walk the registry twice.
 */
export function buildToolRiskMap(): Map<string, { riskTag: RiskTag; alwaysAvailable: boolean }> {
  const out = new Map<string, { riskTag: RiskTag; alwaysAvailable: boolean }>();

  // Native tools.
  const nativeMap = getNativeToolGroupMap();
  for (const [name, tag] of Object.entries(nativeMap)) {
    const risk: RiskTag = tag.riskTag ?? defaultRiskForGroup(tag.group);
    out.set(name, { riskTag: risk, alwaysAvailable: tag.criticality === "always-available" });
  }

  // MCP + synth tools: declared in frontmatter. Their qualified names follow
  // `{toolId}__{endpointOrMcpToolName}` conventions, but we don't know the
  // endpoint subset until tool-builder runs. Store classification at the
  // toolId-prefix level so any endpoint inherits it.
  for (const t of loadTools()) {
    if (!t.mcpServer) continue;
    const risk: RiskTag = t.metadata.riskTag ?? defaultRiskForGroup(t.metadata.group);
    const aa = t.metadata.criticality === "always-available";
    // Store the bare toolId so the lookup below catches every endpoint.
    out.set(t.id, { riskTag: risk, alwaysAvailable: aa });
  }

  return out;
}

/**
 * Look up the effective risk tag for a qualified tool name. Falls through
 * the prefix when an exact match isn't found (covers MCP / synth endpoints
 * stored at the toolId level).
 */
export function lookupToolRisk(
  toolName: string,
  riskMap: Map<string, { riskTag: RiskTag; alwaysAvailable: boolean }>
): { riskTag: RiskTag; alwaysAvailable: boolean } {
  const exact = riskMap.get(toolName);
  if (exact) return exact;
  const sep = toolName.indexOf("__");
  if (sep > 0) {
    const prefix = toolName.slice(0, sep);
    const fromPrefix = riskMap.get(prefix);
    if (fromPrefix) return fromPrefix;
  }
  // Unknown tool — be conservative.
  return { riskTag: "moderate", alwaysAvailable: false };
}

// ── Filter ────────────────────────────────────────────────────

export interface ApplyEmotionGateArgs {
  defs: Record<string, unknown>;
  vad: { valence: number; arousal: number; dominance: number } | null;
  /** Optional override map for tests / non-default classifications. */
  riskMap?: Map<string, { riskTag: RiskTag; alwaysAvailable: boolean }>;
}

export interface ApplyEmotionGateResult {
  defs: Record<string, unknown>;
  bucket: EmotionBucket;
  masked: Array<{ toolName: string; riskTag: RiskTag }>;
  bypassed: string[];
  event: EmotionGatedToolsEvent | null;
}

/**
 * Filter a built tool-def map through the emotion gate.
 *
 *   - `hostile` → mask both `destructive` AND `moderate` tools (cooling-off).
 *   - `frustrated` → mask `destructive` only (safe + moderate still fly).
 *   - `collaborative` / `neutral` → no-op.
 *   - Always-available tools survive every bucket.
 *
 * Returns the filtered defs + a structured event the orchestrator can emit
 * on the brain canvas. `event` is null when nothing changed (avoid noisy
 * canvas updates).
 */
export function applyEmotionGate<T>({
  defs,
  vad,
  riskMap,
}: {
  defs: Record<string, T>;
  vad: { valence: number; arousal: number; dominance: number } | null;
  riskMap?: Map<string, { riskTag: RiskTag; alwaysAvailable: boolean }>;
}): {
  defs: Record<string, T>;
  bucket: EmotionBucket;
  masked: Array<{ toolName: string; riskTag: RiskTag }>;
  bypassed: string[];
  event: EmotionGatedToolsEvent | null;
} {
  const safeVad = vad ?? { valence: 0, arousal: 0, dominance: 0 };
  const bucket = bucketFromVAD(safeVad);

  if (bucket === "neutral" || bucket === "collaborative") {
    return { defs, bucket, masked: [], bypassed: [], event: null };
  }

  const map = riskMap ?? buildToolRiskMap();
  const out: Record<string, T> = {};
  const masked: Array<{ toolName: string; riskTag: RiskTag }> = [];
  const bypassed: string[] = [];

  // Risk levels that get masked per bucket.
  const maskDestructive = bucket === "hostile" || bucket === "frustrated";
  const maskModerate = bucket === "hostile";

  for (const [name, def] of Object.entries(defs)) {
    const { riskTag, alwaysAvailable } = lookupToolRisk(name, map);
    const willMask =
      (riskTag === "destructive" && maskDestructive) ||
      (riskTag === "moderate" && maskModerate);

    if (!willMask) {
      out[name] = def;
      continue;
    }
    if (alwaysAvailable) {
      // Bypassed — record it so the canvas can show "x tools spared via
      // criticality". Don't drop the tool from the bag.
      bypassed.push(name);
      out[name] = def;
      continue;
    }
    masked.push({ toolName: name, riskTag });
  }

  const event: EmotionGatedToolsEvent = {
    bucket,
    vad: safeVad,
    masked,
    bypassed,
    toolCountAfter: Object.keys(out).length,
    reason:
      bucket === "hostile"
        ? "cooling-off — destructive + moderate tools masked"
        : "frustrated — destructive tools masked",
  };

  return { defs: out, bucket, masked, bypassed, event };
}

// ── Convenience: read VAD for a session ──────────────────────

/**
 * Best-effort VAD lookup for a given session. Returns null when the
 * session has no recorded emotion yet (bucket falls back to neutral
 * → no gating, which is the right default).
 */
export function getSessionVAD(
  sessionId: string | undefined
): { valence: number; arousal: number; dominance: number } | null {
  if (!sessionId) return null;
  try {
    const snap = getLatestEmotion(sessionId);
    return snap ? snap.vad : null;
  } catch (err) {
    console.warn(
      "[emotion-gate] getLatestEmotion failed:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
