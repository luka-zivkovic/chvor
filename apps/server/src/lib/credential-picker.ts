import { listCredentials } from "../db/credential-store.ts";
import { getSessionPin } from "../db/session-pin-store.ts";

/**
 * Tiered credential picker (Phase E).
 *
 * When `{{credentials.X}}` references a type with multiple instances, this
 * function decides which one to use. Order:
 *
 *   1. **Pinned by tool config** — synth tools may declare a hard-coded
 *      `credentialId` in their frontmatter; deterministic and author-set.
 *   2. **Session pin** — user pinned `(session, type)` via Settings or the
 *      AI's prior turn (durable, survives restart). User intent outranks
 *      LLM choice so pins are not silently overridden.
 *   3. **LLM-picked** — a synthesized tool call may pass a safe metadata-only
 *      `credentialId` enum chosen from the exposed options.
 *   4. **Skill `preferredUsageContext` match** — score each candidate by
 *      token-overlap between the credential's `usage_context` and the
 *      union of `preferredUsageContext` from active skills. Wins only when
 *      one candidate strictly beats the rest.
 *   5. **First-match fallback** — alphabetical-by-name to keep the choice
 *      deterministic across runs (replaces the old DB-order heuristic).
 *
 * Returns `null` when no credential of the requested type exists at all.
 */

export type PickReason =
  | "llm-picked"
  | "tool-pinned"
  | "session-pin"
  | "context-match"
  | "single-match"
  | "first-match-fallback";

export interface PickContext {
  /** Safe explicit choice from an LLM-visible credentialId enum. */
  llmPickedId?: string;
  /** Optional whitelist of credential IDs allowed in this call. */
  allowedCredentialIds?: string[];
  /** Optional whitelist of credential types allowed in this turn. */
  allowedCredentialTypes?: string[];
  /** Optional session id — required for "session-pin" tier. */
  sessionId?: string | null;
  /** Optional pinning by tool frontmatter (synth tools). */
  toolPinnedId?: string;
  /** Optional context tokens from active skills' `preferredUsageContext`. */
  preferredUsageContext?: string[];
}

export interface PickResult {
  credentialId: string;
  reason: PickReason;
  /** Total candidates of this type before tiers narrowed the choice. */
  candidateCount: number;
  /** Detail string suitable for canvas event / debug log. */
  detail?: string;
}

/**
 * Tokenize a free-text usage_context into lowercase word tokens.
 * Splits on non-alphanumerics so "work, enterprise" → ["work","enterprise"].
 */
function tokenize(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/**
 * Pick a credential for a type given the current call context.
 * Returns null when no candidate of the requested type exists.
 */
export function pickCredential(credentialType: string, ctx: PickContext = {}): PickResult | null {
  if (
    ctx.allowedCredentialTypes &&
    ctx.allowedCredentialTypes.length > 0 &&
    !ctx.allowedCredentialTypes.includes(credentialType)
  ) {
    return null;
  }

  const all = listCredentials();
  let candidates = all.filter((c) => c.type === credentialType);
  if (ctx.allowedCredentialIds && ctx.allowedCredentialIds.length > 0) {
    const allowed = new Set(ctx.allowedCredentialIds);
    candidates = candidates.filter((c) => allowed.has(c.id));
  }
  if (candidates.length === 0) {
    return null;
  }

  // Tier 1 — explicit tool pin (synth credentialId in frontmatter)
  if (ctx.toolPinnedId) {
    const m = candidates.find((c) => c.id === ctx.toolPinnedId);
    if (m) {
      return {
        credentialId: m.id,
        reason: "tool-pinned",
        candidateCount: candidates.length,
        detail: `tool config pins credential ${m.id}`,
      };
    }
    // Pinned id no longer matches — fall through.
  }

  // Tier 2 — session pin. Durable user intent outranks LLM choice; if the
  // user pinned a credential for this session, that wins even when the LLM
  // suggested something different.
  if (ctx.sessionId) {
    try {
      const pin = getSessionPin(ctx.sessionId, credentialType);
      if (pin) {
        const m = candidates.find((c) => c.id === pin.credentialId);
        if (m) {
          return {
            credentialId: m.id,
            reason: "session-pin",
            candidateCount: candidates.length,
            detail: `session pin → "${m.name}"`,
          };
        }
        // Pinned cred has been deleted — fall through. Caller may want to
        // clear the dangling pin; we don't do it implicitly here so a
        // freshly-recreated cred with the same id isn't silently re-pinned.
      }
    } catch (err) {
      console.warn(
        "[credential-picker] session pin lookup failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // Tier 3 — explicit LLM choice from a schema enum. Invalid choices fall
  // through so legacy callers can recover through context/fallback;
  // synthesized-caller performs a stricter preflight and returns a clean error.
  if (ctx.llmPickedId) {
    const m = candidates.find((c) => c.id === ctx.llmPickedId);
    if (m) {
      return {
        credentialId: m.id,
        reason: "llm-picked",
        candidateCount: candidates.length,
        detail: `LLM selected credential "${m.name}"`,
      };
    }
  }

  // Single match — deterministic without further tiers
  if (candidates.length === 1) {
    return {
      credentialId: candidates[0].id,
      reason: "single-match",
      candidateCount: 1,
      detail: `only candidate: "${candidates[0].name}"`,
    };
  }

  // Tier 4 — context-match: score by usage_context token overlap
  const wanted = new Set<string>();
  for (const t of ctx.preferredUsageContext ?? []) {
    for (const tok of tokenize(t)) wanted.add(tok);
  }
  if (wanted.size > 0) {
    const scored = candidates
      .map((c) => ({ cred: c, score: overlap(tokenize(c.usageContext), wanted) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (top.score > 0 && (scored.length === 1 || scored[1].score < top.score)) {
      return {
        credentialId: top.cred.id,
        reason: "context-match",
        candidateCount: candidates.length,
        detail: `usage_context overlap (${top.score}) → "${top.cred.name}"`,
      };
    }
  }

  // Tier 5 — first-match fallback (alphabetical by name → deterministic).
  // Byte-wise compare (not localeCompare) so the same data dir picks the
  // same credential regardless of which machine's locale runs the server.
  const sorted = [...candidates].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chosen = sorted[0];
  return {
    credentialId: chosen.id,
    reason: "first-match-fallback",
    candidateCount: candidates.length,
    detail: `no clear winner — falling back to alphabetically-first "${chosen.name}"`,
  };
}
