// NOTE: Keep in sync with @chvor/shared/src/types/pc-control.ts (A11yNode, A11yTree).
// Cannot import directly due to rootDir constraints in this package's tsconfig.

/** A single node in the OS accessibility tree */
export interface A11yNode {
  /** Stable integer ID for action targeting */
  id: number;
  /** Element role: button, textfield, menuitem, heading, link, etc. */
  role: string;
  /** Accessible name / label */
  name: string;
  /** Current value (for inputs, sliders, etc.) */
  value?: string;
  /** Bounding box in native screen coords [x, y, width, height] */
  bbox?: [number, number, number, number];
  /** Element states: focused, expanded, checked, disabled, etc. */
  states?: string[];
  /** Child elements */
  children?: A11yNode[];
}

/** The full accessibility tree for a window or screen */
export interface A11yTree {
  platform: string;
  timestamp: string;
  root: A11yNode;
  /** Total number of nodes in the tree */
  nodeCount: number;
}
