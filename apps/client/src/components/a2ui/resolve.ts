import type { A2UITextValue } from "@chvor/shared";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function walkPath(path: string, bindings: Record<string, unknown>): unknown {
  const parts = path.split(".");
  let current: unknown = bindings;
  for (const part of parts) {
    if (UNSAFE_KEYS.has(part)) return undefined;
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Resolve an A2UI text value — either a literal string or a data binding.
 * Supports dot-path lookups like "metrics.cpu" into the bindings object.
 */
export function resolveValue(
  value: A2UITextValue,
  bindings: Record<string, unknown>
): string {
  if ("literalString" in value) return value.literalString;
  const result = walkPath(value.binding, bindings);
  return result == null ? "" : String(result);
}

/**
 * Resolve a text value that might be bound to an array (for Table rows, Chart data).
 */
export function resolveArray(
  value: A2UITextValue,
  bindings: Record<string, unknown>
): unknown[] {
  if ("literalString" in value) {
    try {
      const parsed = JSON.parse(value.literalString);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  const result = walkPath(value.binding, bindings);
  return Array.isArray(result) ? result : [];
}
