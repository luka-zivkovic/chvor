// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

export type PcSafetyLevel = "supervised" | "semi-autonomous" | "autonomous";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type PcActionType =
  | "screenshot"
  | "mouse_move"
  | "left_click"
  | "right_click"
  | "double_click"
  | "middle_click"
  | "type"
  | "key"
  | "scroll"
  | "wait";

export interface PcAction {
  action: PcActionType;
  coordinate?: [number, number];
  text?: string;
  /** Key combo e.g. "ctrl+c", "alt+tab" */
  keys?: string;
  /** Scroll direction */
  direction?: "up" | "down" | "left" | "right";
  /** Scroll amount */
  amount?: number;
  /** Wait duration in ms */
  duration?: number;
}

export interface PcActionResult {
  success: boolean;
  error?: string;
  /** Screenshot taken after the action (if applicable) */
  screenshot?: PcScreenshot;
}

// ---------------------------------------------------------------------------
// Agent info & screenshots
// ---------------------------------------------------------------------------

export interface PcAgentInfo {
  id: string;
  hostname: string;
  os: string;
  /** Native screen resolution */
  screenWidth: number;
  screenHeight: number;
  connectedAt: string;
  status: "connected" | "busy" | "disconnected";
}

export interface PcScreenshot {
  /** Base64-encoded image data */
  data: string;
  width: number;
  height: number;
  timestamp: string;
  mimeType?: "image/jpeg" | "image/png";
}

// ---------------------------------------------------------------------------
// Accessibility tree
// ---------------------------------------------------------------------------

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

export interface A11yTree {
  platform: string;
  timestamp: string;
  root: A11yNode;
  /** Total number of nodes in the tree */
  nodeCount: number;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type PipelineLayer = "action-router" | "a11y" | "vision";

export interface PcTaskResult {
  success: boolean;
  layerUsed: PipelineLayer;
  summary: string;
  actions: PcAction[];
  screenshot?: PcScreenshot;
  error?: string;
}

// ---------------------------------------------------------------------------
// Mode & config
// ---------------------------------------------------------------------------

export type PcMode = "local" | "remote";

export interface PcControlConfig {
  enabled: boolean;
  safetyLevel: PcSafetyLevel;
  localAvailable: boolean;
  connectedAgents: PcAgentInfo[];
}

// ---------------------------------------------------------------------------
// WebSocket protocol (server <-> PC agent)
// ---------------------------------------------------------------------------

/** Messages sent from server to the PC agent */
export type PcServerMessage =
  | { type: "action"; id: string; action: PcAction }
  | { type: "screenshot"; id: string }
  | { type: "shell"; id: string; command: string; cwd?: string }
  | { type: "a11y_tree"; id: string; maxDepth?: number }
  | { type: "ping" };

/** Messages sent from PC agent to the server */
export type PcAgentMessage =
  | { type: "hello"; hostname: string; os: string; screenWidth: number; screenHeight: number }
  | { type: "screenshot"; id: string; data: string; width: number; height: number; mimeType?: string }
  | { type: "action.result"; id: string; success: boolean; error?: string }
  | { type: "shell.result"; id: string; stdout: string; stderr: string; exitCode: number }
  | { type: "a11y_tree"; id: string; tree: A11yTree | null }
  | { type: "pong" };
