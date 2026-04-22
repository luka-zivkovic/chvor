/**
 * A2UI action grammar.
 *
 * Server-driven surfaces ship arbitrary action strings ("action": "..." on
 * Button, "submitAction": "..." on Form). The client refuses to honor any
 * action that isn't on this allowlist — raw URLs, javascript:, data:, etc.
 * are all silently dropped with a console warning.
 *
 * Allowed grammar:
 *   navigate:<panelId>          — open a panel inside the app shell
 *   emit:<eventName>[?json]     — emit a typed app event (host registers handlers)
 *   noop                        — explicit no-op (default safe value)
 *
 * Anything else parses as null. The host app decides what "navigate:foo" or
 * "emit:foo" actually does — the allowlist here just guarantees no raw URL
 * or arbitrary code path can sneak through.
 */

export type ParsedA2UIAction =
  | { kind: "navigate"; panelId: string }
  | { kind: "emit"; eventName: string; payload?: unknown }
  | { kind: "noop" };

const PANEL_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
const EVENT_NAME_RE = /^[a-z][a-z0-9_.-]{0,63}$/i;

export function parseA2UIAction(raw: unknown): ParsedA2UIAction | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "noop") return { kind: "noop" };

  const colonIdx = trimmed.indexOf(":");
  if (colonIdx === -1) return null;
  const scheme = trimmed.slice(0, colonIdx);
  const rest = trimmed.slice(colonIdx + 1);

  if (scheme === "navigate") {
    if (!PANEL_ID_RE.test(rest)) return null;
    return { kind: "navigate", panelId: rest };
  }
  if (scheme === "emit") {
    // Optional payload after "?" (URL-encoded JSON). Keep payload size capped to
    // avoid surfaces shipping multi-megabyte JSON in an action string.
    const qIdx = rest.indexOf("?");
    if (qIdx === -1) {
      if (!EVENT_NAME_RE.test(rest)) return null;
      return { kind: "emit", eventName: rest };
    }
    const eventName = rest.slice(0, qIdx);
    const payloadRaw = rest.slice(qIdx + 1);
    if (!EVENT_NAME_RE.test(eventName)) return null;
    if (payloadRaw.length > 4_000) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(decodeURIComponent(payloadRaw));
    } catch {
      return null;
    }
    return { kind: "emit", eventName, payload };
  }
  return null;
}

/** Server-side helper: returns a safe action string, or "noop" if the input
 *  isn't on the allowlist. Used at ingestion time so the wire payload can't
 *  carry a raw URL even if the LLM tries.
 */
export function sanitizeA2UIAction(raw: unknown): string {
  return parseA2UIAction(raw) ? (raw as string).trim() : "noop";
}
