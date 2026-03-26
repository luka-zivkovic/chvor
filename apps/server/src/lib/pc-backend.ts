import type { PcAction, PcActionResult, PcScreenshot, A11yTree } from "@chvor/shared";

/**
 * Unified interface for PC control backends (local or remote).
 * All native tools and the pipeline work against this interface.
 */
export interface PcBackend {
  readonly mode: "local" | "remote";
  readonly id: string;
  readonly hostname: string;
  readonly os: string;
  readonly screenSize: { width: number; height: number };

  /** Capture the screen as a compressed image */
  captureScreen(): Promise<PcScreenshot>;

  /** Execute a mouse/keyboard action */
  executeAction(action: PcAction): Promise<PcActionResult>;

  /** Execute a shell command */
  executeShell(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  /** Query the OS accessibility tree. Returns null if not available. */
  queryA11yTree(opts?: { maxDepth?: number }): Promise<A11yTree | null>;
}
