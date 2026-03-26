import type { A11yTree } from "./types.ts";

/**
 * Linux accessibility tree via AT-SPI2 / D-Bus.
 *
 * TODO: Implement using dbus-next to talk to AT-SPI2.
 * For now returns null (graceful degradation to vision layer).
 */
export async function queryA11yTreeLinux(_opts?: { maxDepth?: number }): Promise<A11yTree | null> {
  console.warn("[a11y-linux] Linux accessibility tree not yet implemented, falling back to vision");
  return null;
}
