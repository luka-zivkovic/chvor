export type { A11yNode, A11yTree } from "./types.ts";
export { serializeA11yTree, findNodeById } from "./serialize.ts";
export type { SerializeOptions } from "./serialize.ts";

import type { A11yTree } from "./types.ts";

/**
 * Query the OS accessibility tree for the focused window / entire screen.
 * Returns null if accessibility tree is not available on this platform.
 *
 * Platform dispatching:
 * - win32: PowerShell/.NET System.Windows.Automation bridge
 * - darwin: Swift CLI bridge (AXorcist-style)
 * - linux: dbus-next + AT-SPI2
 */
export async function queryA11yTree(opts?: { maxDepth?: number }): Promise<A11yTree | null> {
  const platform = process.platform;

  try {
    if (platform === "win32") {
      const { queryA11yTreeWin32 } = await import("./a11y-win32.ts");
      return await queryA11yTreeWin32(opts);
    } else if (platform === "darwin") {
      const { queryA11yTreeDarwin } = await import("./a11y-darwin.ts");
      return await queryA11yTreeDarwin(opts);
    } else {
      const { queryA11yTreeLinux } = await import("./a11y-linux.ts");
      return await queryA11yTreeLinux(opts);
    }
  } catch (err) {
    console.warn(`[a11y] failed to query accessibility tree on ${platform}:`, (err as Error).message);
    return null;
  }
}
