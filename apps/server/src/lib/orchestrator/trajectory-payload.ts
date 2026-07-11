import { sanitizeTrajectoryValue, type TrajectoryJsonValue } from "@chvor/shared";

const MAX_NODES = 20_000;
const MAX_BYTES = 1_000_000;
const MAX_STRING_BYTES = 64_000;

interface PayloadState {
  seen: WeakSet<object>;
  nodes: number;
  bytes: number;
  secrets: readonly string[];
}

function redactExactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0 && redacted.includes(secret)) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted;
}

function boundedString(value: string, state: PayloadState): string {
  const redacted = redactExactSecrets(value, state.secrets);
  const remaining = MAX_BYTES - state.bytes;
  if (remaining <= 0) return "";
  const allowed = Math.min(remaining, MAX_STRING_BYTES);
  const byteLength = Buffer.byteLength(redacted);
  if (byteLength <= allowed) {
    state.bytes += byteLength;
    return redacted;
  }
  const suffix = "[TRUNCATED]";
  const suffixBytes = Buffer.byteLength(suffix);
  if (allowed < suffixBytes) {
    state.bytes = MAX_BYTES;
    return "";
  }
  const prefixBudget = allowed - suffixBytes;
  let prefix = redacted.slice(0, prefixBudget);
  while (Buffer.byteLength(prefix) > prefixBudget) {
    prefix = prefix.slice(0, Math.floor(prefix.length * 0.75));
  }
  state.bytes += Buffer.byteLength(prefix) + suffixBytes;
  return `${prefix}${suffix}`;
}

function toBoundedValue(value: unknown, state: PayloadState, depth = 0): TrajectoryJsonValue {
  state.nodes += 1;
  if (depth > 32 || state.nodes > MAX_NODES || state.bytes >= MAX_BYTES) return "";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedString(value, state);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return boundedString(value.toString(), state);
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function") {
    return boundedString(`[Function${value.name ? ` ${value.name}` : ""}]`, state);
  }
  if (typeof value === "symbol") {
    return boundedString(value.description ? `[Symbol ${value.description}]` : "[Symbol]", state);
  }

  if (state.seen.has(value)) return "[Circular]";
  state.seen.add(value);
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? "Invalid Date" : value.toISOString();
  if (value instanceof Error) {
    return {
      name: boundedString(value.name, state),
      message: boundedString(value.message, state),
      ...(value.stack ? { stack: boundedString(value.stack, state) } : {}),
    };
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `[binary ${value.byteLength} bytes]`;
  }
  if (Array.isArray(value)) {
    const output: TrajectoryJsonValue[] = [];
    for (const entry of value) {
      if (state.nodes >= MAX_NODES || state.bytes >= MAX_BYTES) break;
      output.push(toBoundedValue(entry, state, depth + 1));
    }
    return output;
  }

  const output: Record<string, TrajectoryJsonValue> = {};
  for (const key in value) {
    state.nodes += 1;
    if (state.nodes >= MAX_NODES || state.bytes >= MAX_BYTES) break;
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    const safeKey = boundedString(key, state);
    if (!safeKey) break;
    output[safeKey] = "value" in descriptor
      ? toBoundedValue(descriptor.value, state, depth + 1)
      : "[Accessor]";
  }
  return output;
}

export function sanitizeTrajectoryPayload(
  value: unknown,
  secrets: Iterable<string> = []
): TrajectoryJsonValue {
  try {
    // Replace longer overlapping credentials first so redacting `abc` cannot
    // leave the suffix of `abcdef` visible as `[REDACTED]def`.
    const orderedSecrets = Array.from(new Set(secrets))
      .filter((secret) => secret.length > 0)
      .sort((left, right) => right.length - left.length);
    const state: PayloadState = {
      seen: new WeakSet(),
      nodes: 0,
      bytes: 0,
      secrets: orderedSecrets,
    };
    return sanitizeTrajectoryValue(toBoundedValue(value, state));
  } catch {
    return "[Unserializable trajectory payload]";
  }
}

export function sanitizeTrajectoryString(value: string, secrets: Iterable<string> = []): string {
  const sanitized = sanitizeTrajectoryPayload(value, secrets);
  return typeof sanitized === "string" ? sanitized : "[Unserializable trajectory text]";
}
