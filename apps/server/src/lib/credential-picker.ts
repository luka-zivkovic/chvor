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
 *   4. **First-match fallback** — alphabetical-by-name to keep the choice
 *      deterministic across runs. When there is more than one candidate the
 *      caller treats this as "ambiguous" and prompts the user instead of
 *      silently using the fallback.
 *
 * Returns `null` when no credential of the requested type exists at all.
 *
 * Note: a usage-context token-overlap scoring tier was removed. For a
 * single-user deployment (0–1 credentials per type) it almost never fired, and
 * silently guessing by free-text overlap is worse UX than asking. The
 * `preferredUsageContext` field is retained on PickContext (callers still pass
 * it) but no longer influences the pick.
 */

export type PickReason =
  | "user-picked"
  | "llm-picked"
  | "tool-pinned"
  | "session-pin"
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
  /**
   * Retained for caller compatibility. No longer used for scoring — kept so
   * the orchestrator/synthesized-caller don't need signature changes.
   */
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

  // Tier 4 — first-match fallback (alphabetical by name → deterministic).
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
