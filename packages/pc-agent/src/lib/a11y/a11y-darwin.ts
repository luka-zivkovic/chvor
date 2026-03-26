import type { A11yTree } from "./types.ts";

/**
 * macOS accessibility tree via AppleScript/JXA bridge.
 *
 * TODO: Implement using AXorcist Swift CLI or JXA accessibility APIs.
 * For now returns null (graceful degradation to vision layer).
 */
export async function queryA11yTreeDarwin(_opts?: { maxDepth?: number }): Promise<A11yTree | null> {
  console.warn("[a11y-darwin] macOS accessibility tree not yet implemented, falling back to vision");
  return null;
}
