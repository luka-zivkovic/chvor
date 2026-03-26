// Screen capture
export { captureScreen, getScreenSize, TARGET_WIDTH, TARGET_HEIGHT } from "./screen.ts";
export type { CapturedScreenshot } from "./screen.ts";

// Input simulation
export { executeAction, bboxToCoordinate } from "./input.ts";
export type { ActionInput } from "./input.ts";

// Shell execution
export { executeShellCommand } from "./shell.ts";
export type { ShellResult } from "./shell.ts";

// Accessibility tree
export { queryA11yTree, serializeA11yTree, findNodeById } from "./a11y/index.ts";
export type { A11yNode, A11yTree } from "./a11y/types.ts";
export type { SerializeOptions } from "./a11y/serialize.ts";
