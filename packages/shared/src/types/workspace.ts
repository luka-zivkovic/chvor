export type WorkspaceMode = "constellation";

export interface Workspace {
  id: string;
  name: string;
  mode: WorkspaceMode;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
  viewport: { x: number; y: number; zoom: number };
  settings: WorkspaceSettings;
  createdAt: string;
  updatedAt: string;
}

export type NodeType = "brain" | "skill" | "tool" | "trigger" | "output";

export interface WorkspaceNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: BrainNodeData | SkillNodeData | ToolNodeData | TriggerNodeData | OutputNodeData;
}

export interface BrainNodeData {
  label: string;
  providerId: string;
  model: string;
  systemPrompt?: string;
  temperature?: number;
}

export interface SkillNodeData {
  label: string;
  skillId: string;
  skillConfig?: Record<string, unknown>;
  category?: string;
}

export interface ToolNodeData {
  label: string;
  toolId: string;
  toolConfig?: Record<string, unknown>;
  category?: string;
}

export interface TriggerNodeData {
  label: string;
  triggerType: "manual" | "schedule";
  scheduleId?: string;
}

export interface OutputNodeData {
  label: string;
  outputFormat: "text" | "json" | "markdown";
}

export interface WorkspaceEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  animated?: boolean;
}

export interface WorkspaceSettings {
  maxRetries: number;
  timeoutMs: number;
}
