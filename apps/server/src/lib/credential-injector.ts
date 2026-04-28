/**
 * Sealed credential injection (Phase E2).
 *
 * Three primitives, in increasing strictness:
 *
 *   1. `injectPlaceholders(value, data)` — substitutes `{{credentials.X[.field]}}`
 *      placeholders in a string with raw credential values. Used at the very
 *      last possible moment before the value crosses to the external system
 *      (HTTP header, browser fill, env var). The substituted string is never
 *      stored or logged — callers must pass it directly to the boundary API.
 *
 *   2. `withSecretSeal(secrets, fn)` — runs `fn` with `secrets` registered as
 *      "active" in a process-local set. Any code path that calls
 *      `redactKnownSecrets` while the seal is open will see those values
 *      replaced with `«credential»`. Use this around the in-flight tool call
 *      so audit / event-store / activity-log writes can defensively scrub.
 *
 *   3. `redactKnownSecrets(value)` — walks strings (or any JSON-able value)
 *      and replaces every occurrence of any active secret with the marker.
 *      Idempotent + safe on already-redacted text.
 *
 * Why a seal-and-scrub layer in addition to never-storing-values?
 *
 * The synthesized-caller's `applyAuth` already keeps secrets out of the args
 * object the LLM sees. But several non-LLM paths still write side data to
 * disk: the activity log records request/response bodies, the audit log
 * records error strings, the event store writes args + observation payloads.
 * If a future feature ever passes a credential value through one of those
 * paths (or the LLM hallucinates one back into a tool arg), the seal acts as
 * a final defensive scrub — analogous to `truncateForStorage`'s size cap.
 *
 * The injector is the *only* place that should touch raw credential values.
 * Every other module imports the redactor.
 */

const PLACEHOLDER_RE = /\{\{credentials\.([^}]+)\}\}/g;

const REDACT_MARKER = "«credential»";
/** Don't bother redacting tiny secrets — too many false positives. */
const MIN_SCRUB_LENGTH = 6;

/** Active secrets across all in-flight calls, keyed by raw value. */
const activeSecrets = new Set<string>();

/**
 * Field names whose values are non-secret connection metadata (URLs,
 * usernames, regions, etc.). Excluded from the seal so common words like
 * "admin" or "us-east-1" don't get scrubbed in unrelated audit text.
 */
const NON_SECRET_FIELD_NAMES = new Set<string>([
  "username", "user", "email", "tenant", "tenantId", "tenant_id",
  "region", "host", "hostname", "port", "endpoint", "domain", "name",
  "apiUrl", "api_url", "baseUrl", "base_url", "url", "issuer", "audience",
]);

/**
 * Pick the values from `cred.data` that should be sealed during a call.
 * Anything that isn't on the non-secret allowlist is included; values that
 * are too short to scrub safely are skipped.
 */
export function extractSecretValues(data: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== "string") continue;
    if (NON_SECRET_FIELD_NAMES.has(k)) continue;
    if (v.length < MIN_SCRUB_LENGTH) continue;
    out.push(v);
  }
  return out;
}

/** Internal: ref-count so nested seals don't drop a still-active secret. */
const secretRefcount = new Map<string, number>();

function parseCredRef(ref: string): { type: string; field?: string } {
  const dotIdx = ref.indexOf(".");
  if (dotIdx === -1) return { type: ref };
  return { type: ref.slice(0, dotIdx), field: ref.slice(dotIdx + 1) };
}

function extractCredValue(data: Record<string, string>, field?: string): string | undefined {
  if (field) return data[field];
  return data.apiKey ?? data.token ?? data.key ?? Object.values(data)[0];
}

/**
 * Substitute every `{{credentials.X[.field]}}` placeholder in `template` with
 * the matching raw value from `data`. Throws on a missing placeholder so the
 * caller (synthesized-caller, browser-tool) surfaces a typed error rather
 * than emitting a half-substituted secret.
 *
 * If `data` is keyed by credential type (the common shape from
 * `credential-resolver`), pass `byType: true`. If it's already a single
 * credential's `data` object, pass `byType: false`.
 */
export interface InjectOptions {
  /** Map credential type → data object. */
  byType?: Map<string, Record<string, string>>;
  /** Single credential's data — used when the placeholder is implicit. */
  data?: Record<string, string>;
  /** URL-encode each substituted value. */
  urlEncode?: boolean;
}

export function injectPlaceholders(template: string, opts: InjectOptions): string {
  if (!template.includes("{{credentials.")) return template;
  return template.replace(PLACEHOLDER_RE, (_match, credRef: string) => {
    const { type, field } = parseCredRef(credRef);
    const data = opts.byType?.get(type) ?? opts.data;
    if (!data) {
      throw new Error(
        `[credential-injector] no credential data for type "${type}" — caller must resolve before injection`,
      );
    }
    const value = extractCredValue(data, field);
    if (!value) {
      throw new Error(
        `[credential-injector] credential "${type}"${field ? ` field "${field}"` : ""} has no usable value`,
      );
    }
    return opts.urlEncode ? encodeURIComponent(value) : value;
  });
}

/**
 * True if `template` contains at least one `{{credentials...}}` placeholder.
 * Cheap pre-check the synthesized-caller / browser-tool can use before
 * calling `injectPlaceholders`.
 */
export function hasCredentialPlaceholder(template: string): boolean {
  return template.includes("{{credentials.");
}

// ── Active-secret registry + scrubber ──────────────────────────

/**
 * Register a set of raw credential values as "active" for the duration of
 * `fn`. Anywhere downstream that calls `redactKnownSecrets` (event store,
 * activity log, error logger) will see them replaced with the marker. Safe
 * to nest — the registry ref-counts.
 */
export async function withSecretSeal<T>(
  secrets: Iterable<string>,
  fn: () => Promise<T>,
): Promise<T> {
  const added: string[] = [];
  for (const raw of secrets) {
    if (!raw || raw.length < MIN_SCRUB_LENGTH) continue;
    activeSecrets.add(raw);
    secretRefcount.set(raw, (secretRefcount.get(raw) ?? 0) + 1);
    added.push(raw);
  }
  try {
    return await fn();
  } finally {
    for (const raw of added) {
      const next = (secretRefcount.get(raw) ?? 1) - 1;
      if (next <= 0) {
        secretRefcount.delete(raw);
        activeSecrets.delete(raw);
      } else {
        secretRefcount.set(raw, next);
      }
    }
  }
}

/** Synchronous variant for tests + non-async call sites. */
export function withSecretSealSync<T>(secrets: Iterable<string>, fn: () => T): T {
  const added: string[] = [];
  for (const raw of secrets) {
    if (!raw || raw.length < MIN_SCRUB_LENGTH) continue;
    activeSecrets.add(raw);
    secretRefcount.set(raw, (secretRefcount.get(raw) ?? 0) + 1);
    added.push(raw);
  }
  try {
    return fn();
  } finally {
    for (const raw of added) {
      const next = (secretRefcount.get(raw) ?? 1) - 1;
      if (next <= 0) {
        secretRefcount.delete(raw);
        activeSecrets.delete(raw);
      } else {
        secretRefcount.set(raw, next);
      }
    }
  }
}

/** True when at least one secret is currently sealed. */
export function hasActiveSecrets(): boolean {
  return activeSecrets.size > 0;
}

/**
 * Replace every active secret in `text` with `«credential»`. O(secrets ×
 * text.length). Returns input unchanged when no secrets are active so the
 * common path is free.
 */
export function redactKnownSecretsInString(text: string): string {
  if (activeSecrets.size === 0) return text;
  let out = text;
  for (const raw of activeSecrets) {
    if (out.includes(raw)) out = out.split(raw).join(REDACT_MARKER);
  }
  return out;
}

/**
 * Walk `value` (string / object / array / primitive) and redact every active
 * secret. Returns a structurally identical copy; never mutates the input.
 */
export function redactKnownSecrets<T>(value: T): T {
  if (activeSecrets.size === 0) return value;
  return walk(value) as T;
}

function walk(v: unknown): unknown {
  if (typeof v === "string") return redactKnownSecretsInString(v);
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(walk);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(val);
    }
    return out;
  }
  return v;
}

/** Test/inspection helper. */
export function _activeSecretCount(): number {
  return activeSecrets.size;
}
