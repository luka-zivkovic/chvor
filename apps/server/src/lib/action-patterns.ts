import type { PcAction } from "@chvor/shared";

/**
 * Layer 1: Action Router — pattern-matched common tasks.
 * Zero LLM calls. Returns null if no pattern matches.
 */

interface ActionPattern {
  match: RegExp;
  /** Resolve matched groups into actions */
  resolve: (match: RegExpMatchArray) => PcAction[];
}

const PATTERNS: ActionPattern[] = [
  // Keyboard shortcuts
  { match: /^(copy|ctrl[\s+]?c)$/i, resolve: () => [{ action: "key", keys: "ctrl+c" }] },
  { match: /^(paste|ctrl[\s+]?v)$/i, resolve: () => [{ action: "key", keys: "ctrl+v" }] },
  { match: /^(cut|ctrl[\s+]?x)$/i, resolve: () => [{ action: "key", keys: "ctrl+x" }] },
  { match: /^(undo|ctrl[\s+]?z)$/i, resolve: () => [{ action: "key", keys: "ctrl+z" }] },
  { match: /^(redo|ctrl[\s+]?y)$/i, resolve: () => [{ action: "key", keys: "ctrl+y" }] },
  { match: /^(select all|ctrl[\s+]?a)$/i, resolve: () => [{ action: "key", keys: "ctrl+a" }] },
  { match: /^(save|ctrl[\s+]?s)$/i, resolve: () => [{ action: "key", keys: "ctrl+s" }] },
  { match: /^(find|ctrl[\s+]?f)$/i, resolve: () => [{ action: "key", keys: "ctrl+f" }] },
  { match: /^(new tab|ctrl[\s+]?t)$/i, resolve: () => [{ action: "key", keys: "ctrl+t" }] },
  { match: /^(close tab|ctrl[\s+]?w)$/i, resolve: () => [{ action: "key", keys: "ctrl+w" }] },

  // Window management
  { match: /^(switch window|alt[\s+]?tab)$/i, resolve: () => [{ action: "key", keys: "alt+tab" }] },
  { match: /^(close window|alt[\s+]?f4)$/i, resolve: () => [{ action: "key", keys: "alt+F4" }] },
  { match: /^minimize(?: window)?$/i, resolve: () => [{ action: "key", keys: "meta+down" }] },
  { match: /^maximize(?: window)?$/i, resolve: () => [{ action: "key", keys: "meta+up" }] },
  { match: /^(show desktop|meta[\s+]?d)$/i, resolve: () => [{ action: "key", keys: "meta+d" }] },
  { match: /^(task manager|ctrl[\s+]?shift[\s+]?escape)$/i, resolve: () => [{ action: "key", keys: "ctrl+shift+escape" }] },

  // Navigation
  { match: /^press enter$/i, resolve: () => [{ action: "key", keys: "enter" }] },
  { match: /^press escape$/i, resolve: () => [{ action: "key", keys: "escape" }] },
  { match: /^press tab$/i, resolve: () => [{ action: "key", keys: "tab" }] },
  { match: /^press (f\d+)$/i, resolve: (m) => [{ action: "key", keys: m[1].toUpperCase() }] },

  // Scroll
  { match: /^scroll (up|down|left|right)$/i, resolve: (m) => [{ action: "scroll", direction: m[1].toLowerCase() as PcAction["direction"] }] },
  { match: /^scroll (up|down|left|right) (\d+)$/i, resolve: (m) => [{ action: "scroll", direction: m[1].toLowerCase() as PcAction["direction"], amount: parseInt(m[2]) }] },
  { match: /^page down$/i, resolve: () => [{ action: "key", keys: "pagedown" }] },
  { match: /^page up$/i, resolve: () => [{ action: "key", keys: "pageup" }] },

  // Type text
  { match: /^type ["'](.+)["']$/i, resolve: (m) => [{ action: "type", text: m[1] }] },

  // Wait
  { match: /^wait(?: (\d+))?(?:\s*(?:ms|milliseconds?))?$/i, resolve: (m) => [{ action: "wait", duration: m[1] ? parseInt(m[1]) : 1000 }] },
  { match: /^wait (\d+)\s*(?:s|seconds?)$/i, resolve: (m) => [{ action: "wait", duration: parseInt(m[1]) * 1000 }] },
];

/**
 * Try to match a task string against known action patterns.
 * Returns the actions to execute if matched, or null to fall through to the next layer.
 */
export function tryActionRouter(task: string): PcAction[] | null {
  const trimmed = task.trim();

  for (const pattern of PATTERNS) {
    const match = trimmed.match(pattern.match);
    if (match) {
      return pattern.resolve(match);
    }
  }

  return null;
}
