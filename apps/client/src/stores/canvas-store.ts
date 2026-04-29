import { create } from "zustand";
import {
  applyNodeChanges,
  applyEdgeChanges,
} from "@xyflow/react";
import type {
  Node,
  Edge,
  NodeChange,
  EdgeChange,
} from "@xyflow/react";
import type { Skill, Tool, Schedule, WebhookSubscription, CredentialSummary } from "@chvor/shared";
import { computeOrbitalPositions, OFFSETS, INNER_RADIUS, HUB_SLOT_ANGLE } from "../lib/orbital-geometry";

export const BRAIN_NODE_ID = "brain-0";

type ExecStatus = "idle" | "pending" | "running" | "completed" | "failed" | "waiting";

// React Flow requires Node data to satisfy Record<string, unknown>, hence the index signatures below
export interface BrainNodeData {
  type: "brain";
  label: string;
  providerId: string;
  model: string;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface SkillNodeData {
  type: "skill";
  label: string;
  skillId: string;
  category?: string;
  icon?: string;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface ScheduleHubNodeData {
  type: "schedule-hub";
  label: string;
  scheduleCount: number;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface SkillsHubNodeData {
  type: "skills-hub";
  label: string;
  skillCount: number;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface ToolsHubNodeData {
  type: "tools-hub";
  label: string;
  toolCount: number;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface ToolNodeData {
  type: "tool";
  label: string;
  toolId: string;
  category?: string;
  icon?: string;
  source?: string;
  builtIn?: boolean;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface ScheduleNodeData {
  type: "schedule";
  label: string;
  scheduleId: string;
  cronExpression: string;
  enabled: boolean;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface TriggerNodeData {
  type: "trigger";
  label: string;
  triggerType: "manual" | "schedule";
  scheduleId?: string;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface OutputNodeData {
  type: "output";
  label: string;
  outputFormat: "text";
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface IntegrationNodeData {
  type: "integration";
  label: string;
  credentialId: string;
  credentialType: string;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface ConnectionsHubNodeData {
  type: "connections-hub";
  label: string;
  connectionCount: number;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface IntegrationsHubNodeData {
  type: "integrations-hub";
  label: string;
  integrationCount: number;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface WebhooksHubNodeData {
  type: "webhooks-hub";
  label: string;
  webhookCount: number;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface WebhookNodeData {
  type: "webhook";
  label: string;
  webhookId: string;
  source: string;
  enabled: boolean;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface GhostHubNodeData {
  type: "ghost-hub";
  label: string;
  ctaLabel: string;
  accentColor: string;
  targetPanel: string;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export interface MindAgentNodeData {
  type: "mind-agent";
  label: string;
  agentId: string;
  role: "researcher" | "planner" | "critic";
  executionStatus: ExecStatus;
  summary?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export interface CanvasInputNodeData {
  type: "canvas-input";
  label: string;
  inputKind: "file" | "url" | "text";
  preview?: string;
  executionStatus: ExecStatus;
  [key: string]: unknown;
}

export type ChvorNodeData =
  | BrainNodeData
  | SkillNodeData
  | SkillsHubNodeData
  | ToolNodeData
  | ToolsHubNodeData
  | ScheduleHubNodeData
  | ScheduleNodeData
  | TriggerNodeData
  | OutputNodeData
  | IntegrationNodeData
  | ConnectionsHubNodeData
  | IntegrationsHubNodeData
  | WebhooksHubNodeData
  | WebhookNodeData
  | GhostHubNodeData
  | MindAgentNodeData
  | CanvasInputNodeData;
export type ChvorNode = Node<ChvorNodeData>;
export type ChvorEdge = Edge & { data?: { active?: boolean; ghost?: boolean } };

interface CanvasState {
  nodes: ChvorNode[];
  edges: ChvorEdge[];

  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;

  initializeFromSkills: (skills: Skill[], tools?: Tool[], schedules?: Schedule[], savedPositions?: Map<string, { x: number; y: number }>, channelCreds?: CredentialSummary[], apiCreds?: CredentialSummary[], webhooks?: WebhookSubscription[]) => void;
  initializeEmptyState: (savedPositions?: Map<string, { x: number; y: number }>) => void;
  deleteEdge: (edgeId: string) => void;

  setNodeExecutionStatus: (nodeId: string, status: ExecStatus) => void;
  setEdgeActive: (edgeId: string, active: boolean) => void;
  resetExecution: () => void;
  updateBrainProvider: (providerId: string, model: string) => void;
  updateBrainLabel: (label: string) => void;
  clearMindAgents: () => void;
  upsertMindAgent: (agent: { agentId: string; role: MindAgentNodeData["role"]; title: string; status?: ExecStatus }) => void;
  completeMindAgent: (agentId: string, title: string, summary: string, durationMs?: number) => void;
  failMindAgent: (agentId: string, error: string) => void;
  addCanvasInputNode: (input: { label: string; inputKind: CanvasInputNodeData["inputKind"]; preview?: string }) => void;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [],
  edges: [],

  onNodesChange: (changes: NodeChange[]) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) as ChvorNode[] });
  },

  onEdgesChange: (changes: EdgeChange[]) => {
    set({ edges: applyEdgeChanges(changes, get().edges) as ChvorEdge[] });
  },

  // Constellation mode: orbital layout with brain at center
  // Inner ring: hub nodes (Integrations, Connections, Schedules)
  // Outer ring: skills grouped by category + fan-out from hubs
  initializeFromSkills: (skills: Skill[], tools: Tool[] = [], schedules: Schedule[] = [], savedPositions?: Map<string, { x: number; y: number }>, channelCreds: CredentialSummary[] = [], apiCreds: CredentialSummary[] = [], webhooks: WebhookSubscription[] = []) => {
    const layout = computeOrbitalPositions(skills, tools, schedules, channelCreds, apiCreds, savedPositions, webhooks);

    const brainNode: ChvorNode = {
      id: BRAIN_NODE_ID,
      type: "brain",
      position: layout.brainPos,
      data: {
        type: "brain",
        label: "Brain",
        providerId: "",
        model: "Not configured",
        executionStatus: "idle",
      },
    };

    const hubNodes: ChvorNode[] = [];
    const hubEdges: ChvorEdge[] = [];

    // --- Skills hub (always visible) + fan-out skill nodes ---
    hubNodes.push({
      id: "skills-hub",
      type: "skills-hub" as const,
      position: layout.hubPositions.get("skills-hub") ?? { x: 0, y: 0 },
      data: {
        type: "skills-hub" as const,
        label: "Skills",
        skillCount: skills.length,
        executionStatus: "idle" as const,
      },
    });
    hubEdges.push({
      id: "edge-brain-skills-hub",
      source: BRAIN_NODE_ID,
      target: "skills-hub",
      type: "animated",
      animated: false,
      data: { active: false },
    });

    skills.forEach((skill) => {
      const nodeId = `skill-${skill.id}`;
      hubNodes.push({
        id: nodeId,
        type: "skill" as const,
        position: layout.skillPositions.get(nodeId) ?? { x: 0, y: 0 },
        data: {
          type: "skill" as const,
          label: skill.metadata.name,
          skillId: skill.id,
          category: skill.metadata.category,
          icon: skill.metadata.icon,
          executionStatus: "idle" as const,
        },
      });
      hubEdges.push({
        id: `edge-skills-hub-${skill.id}`,
        source: "skills-hub",
        target: nodeId,
        type: "animated",
        animated: false,
        data: { active: false },
      });
    });

    // --- Tools hub (always visible) + fan-out tool nodes ---
    hubNodes.push({
      id: "tools-hub",
      type: "tools-hub" as const,
      position: layout.hubPositions.get("tools-hub") ?? { x: 0, y: 0 },
      data: {
        type: "tools-hub" as const,
        label: "Tools",
        toolCount: tools.length,
        executionStatus: "idle" as const,
      },
    });
    hubEdges.push({
      id: "edge-brain-tools-hub",
      source: BRAIN_NODE_ID,
      target: "tools-hub",
      type: "animated",
      animated: false,
      data: { active: false },
    });

    tools.forEach((tool) => {
      const nodeId = `tool-${tool.id}`;
      hubNodes.push({
        id: nodeId,
        type: "tool" as const,
        position: layout.toolPositions.get(nodeId) ?? { x: 0, y: 0 },
        data: {
          type: "tool" as const,
          label: tool.metadata.name,
          toolId: tool.id,
          category: tool.metadata.category,
          icon: tool.metadata.icon,
          source: tool.source,
          builtIn: tool.builtIn,
          executionStatus: "idle" as const,
        },
      });
      hubEdges.push({
        id: `edge-tools-hub-${tool.id}`,
        source: "tools-hub",
        target: nodeId,
        type: "animated",
        animated: false,
        data: { active: false },
      });
    });

    // --- Integrations hub (always visible) + channel nodes ---
    hubNodes.push({
      id: "integrations-hub",
      type: "integrations-hub" as const,
      position: layout.hubPositions.get("integrations-hub") ?? { x: 0, y: 0 },
      data: {
        type: "integrations-hub" as const,
        label: "Integrations",
        integrationCount: channelCreds.length,
        executionStatus: "idle" as const,
      },
    });
    hubEdges.push({
      id: "edge-brain-integrations-hub",
      source: BRAIN_NODE_ID,
      target: "integrations-hub",
      type: "animated",
      animated: false,
      data: { active: false },
    });

    channelCreds.forEach((cred) => {
      const nodeId = `channel-${cred.id}`;
      hubNodes.push({
        id: nodeId,
        type: "integration" as const,
        position: layout.channelPositions.get(nodeId) ?? { x: 0, y: 0 },
        data: {
          type: "integration" as const,
          label: cred.name,
          credentialId: cred.id,
          credentialType: cred.type,
          executionStatus: "idle" as const,
        },
      });
      hubEdges.push({
        id: `edge-integrations-hub-${cred.id}`,
        source: "integrations-hub",
        target: nodeId,
        type: "animated",
        animated: false,
        data: { active: false },
      });
    });

    // --- Connections hub (always visible) + API credential nodes ---
    hubNodes.push({
      id: "connections-hub",
      type: "connections-hub" as const,
      position: layout.hubPositions.get("connections-hub") ?? { x: 0, y: 0 },
      data: {
        type: "connections-hub" as const,
        label: "Connections",
        connectionCount: apiCreds.length,
        executionStatus: "idle" as const,
      },
    });
    hubEdges.push({
      id: "edge-brain-connections-hub",
      source: BRAIN_NODE_ID,
      target: "connections-hub",
      type: "animated",
      animated: false,
      data: { active: false },
    });

    apiCreds.forEach((cred) => {
      const nodeId = `api-${cred.id}`;
      hubNodes.push({
        id: nodeId,
        type: "integration" as const,
        position: layout.apiPositions.get(nodeId) ?? { x: 0, y: 0 },
        data: {
          type: "integration" as const,
          label: cred.name,
          credentialId: cred.id,
          credentialType: cred.type,
          executionStatus: "idle" as const,
        },
      });
      hubEdges.push({
        id: `edge-connections-hub-${cred.id}`,
        source: "connections-hub",
        target: nodeId,
        type: "animated",
        animated: false,
        data: { active: false },
      });
    });

    // --- Schedule hub (always visible) + schedule nodes ---
    hubNodes.push({
      id: "schedule-hub",
      type: "schedule-hub" as const,
      position: layout.hubPositions.get("schedule-hub") ?? { x: 0, y: 0 },
      data: {
        type: "schedule-hub" as const,
        label: "Schedules",
        scheduleCount: schedules.length,
        executionStatus: "idle" as const,
      },
    });
    hubEdges.push({
      id: "edge-brain-schedule-hub",
      source: BRAIN_NODE_ID,
      target: "schedule-hub",
      type: "animated",
      animated: false,
      data: { active: false },
    });

    schedules.forEach((sched) => {
      const nodeId = `schedule-${sched.id}`;
      hubNodes.push({
        id: nodeId,
        type: "schedule" as const,
        position: layout.schedulePositions.get(nodeId) ?? { x: 0, y: 0 },
        data: {
          type: "schedule" as const,
          label: sched.name,
          scheduleId: sched.id,
          cronExpression: sched.cronExpression,
          enabled: sched.enabled,
          executionStatus: "idle" as const,
        },
      });
      hubEdges.push({
        id: `edge-schedule-hub-${sched.id}`,
        source: "schedule-hub",
        target: nodeId,
        type: "animated",
        animated: false,
        data: { active: false },
      });
    });

    // --- Webhooks hub (always visible) + webhook nodes ---
    hubNodes.push({
      id: "webhooks-hub",
      type: "webhooks-hub" as const,
      position: layout.hubPositions.get("webhooks-hub") ?? { x: 0, y: 0 },
      data: {
        type: "webhooks-hub" as const,
        label: "Webhooks",
        webhookCount: webhooks.length,
        executionStatus: "idle" as const,
      },
    });
    hubEdges.push({
      id: "edge-brain-webhooks-hub",
      source: BRAIN_NODE_ID,
      target: "webhooks-hub",
      type: "animated",
      animated: false,
      data: { active: false },
    });

    webhooks.forEach((wh) => {
      const nodeId = `webhook-${wh.id}`;
      hubNodes.push({
        id: nodeId,
        type: "webhook" as const,
        position: layout.webhookPositions.get(nodeId) ?? { x: 0, y: 0 },
        data: {
          type: "webhook" as const,
          label: wh.name,
          webhookId: wh.id,
          source: wh.source,
          enabled: wh.enabled,
          executionStatus: "idle" as const,
        },
      });
      hubEdges.push({
        id: `edge-webhooks-hub-${wh.id}`,
        source: "webhooks-hub",
        target: nodeId,
        type: "animated",
        animated: false,
        data: { active: false },
      });
    });

    const { nodes: previousNodes, edges: previousEdges } = get();
    const transientNodes = previousNodes.filter((n) => n.type === "mind-agent" || n.type === "canvas-input");
    const transientEdges = previousEdges.filter((e) => e.id.startsWith("edge-mind-") || e.id.startsWith("edge-input-"));

    set({
      nodes: [brainNode, ...hubNodes, ...transientNodes],
      edges: [...hubEdges, ...transientEdges],
    });
  },

  // Empty state: brain + ghost hub nodes as onboarding CTAs
  initializeEmptyState: (savedPositions?: Map<string, { x: number; y: number }>) => {
    const pos = (id: string, dx: number, dy: number) =>
      savedPositions?.get(id) ?? { x: dx, y: dy };

    const GHOST_OFFSET = OFFSETS.hub; // Ghost hubs use same size as real hubs

    const brainNode: ChvorNode = {
      id: BRAIN_NODE_ID,
      type: "brain",
      position: pos(BRAIN_NODE_ID, -OFFSETS.brain.hw, -OFFSETS.brain.hh),
      data: { type: "brain", label: "Brain", providerId: "", model: "Not configured", executionStatus: "idle" },
    };

    const ghosts: { id: string; slot: number; label: string; ctaLabel: string; color: string; panel: string }[] = [
      { id: "ghost-skills", slot: 0, label: "Skills", ctaLabel: "+ Add Skill", color: "var(--skill-ai)", panel: "skills" },
      { id: "ghost-tools", slot: 1, label: "Tools", ctaLabel: "+ Add Tool", color: "var(--tool-accent)", panel: "tools" },
      { id: "ghost-integrations", slot: 3, label: "Integrations", ctaLabel: "+ Connect", color: "var(--skill-automation)", panel: "settings" },
    ];

    const ghostNodes: ChvorNode[] = ghosts.map((g) => {
      const angle = HUB_SLOT_ANGLE(g.slot);
      return {
        id: g.id,
        type: "ghost-hub" as const,
        position: pos(g.id, Math.cos(angle) * INNER_RADIUS - GHOST_OFFSET.hw, Math.sin(angle) * INNER_RADIUS - GHOST_OFFSET.hh),
        data: {
          type: "ghost-hub" as const,
          label: g.label,
          ctaLabel: g.ctaLabel,
          accentColor: g.color,
          targetPanel: g.panel,
          executionStatus: "idle" as const,
        },
      };
    });

    const ghostEdges: ChvorEdge[] = ghosts.map((g) => ({
      id: `edge-brain-${g.id}`,
      source: BRAIN_NODE_ID,
      target: g.id,
      type: "animated",
      animated: false,
      data: { active: false, ghost: true },
    }));

    const { nodes: previousNodes, edges: previousEdges } = get();
    const transientNodes = previousNodes.filter((n) => n.type === "mind-agent" || n.type === "canvas-input");
    const transientEdges = previousEdges.filter((e) => e.id.startsWith("edge-mind-") || e.id.startsWith("edge-input-"));

    set({ nodes: [brainNode, ...ghostNodes, ...transientNodes], edges: [...ghostEdges, ...transientEdges] });
  },

  deleteEdge: (edgeId: string) => {
    set({ edges: get().edges.filter((e) => e.id !== edgeId) });
  },

  setNodeExecutionStatus: (nodeId, status) => {
    const nodes = get().nodes;
    const idx = nodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) return;
    if ((nodes[idx].data as ChvorNodeData).executionStatus === status) return;
    const updated = [...nodes];
    updated[idx] = { ...nodes[idx], data: { ...nodes[idx].data, executionStatus: status } } as ChvorNode;
    set({ nodes: updated });
  },

  setEdgeActive: (edgeId, active) => {
    const edges = get().edges;
    const idx = edges.findIndex((e) => e.id === edgeId);
    if (idx === -1) return;
    if (edges[idx].data?.active === active) return;
    const updated = [...edges];
    updated[idx] = { ...edges[idx], data: { ...edges[idx].data, active } };
    set({ edges: updated });
  },

  resetExecution: () => {
    const { nodes, edges } = get();
    const anyNodeDirty = nodes.some((n) => (n.data as ChvorNodeData).executionStatus !== "idle");
    const anyEdgeDirty = edges.some((e) => e.data?.active);
    if (!anyNodeDirty && !anyEdgeDirty) return;
    set({
      nodes: anyNodeDirty
        ? nodes.map((n) =>
            (n.data as ChvorNodeData).executionStatus !== "idle"
              ? ({ ...n, data: { ...n.data, executionStatus: "idle" } } as ChvorNode)
              : n
          )
        : nodes,
      edges: anyEdgeDirty
        ? edges.map((e) =>
            e.data?.active ? { ...e, data: { ...e.data, active: false } } : e
          )
        : edges,
    });
  },

  updateBrainProvider: (providerId, model) => {
    const nodes = get().nodes;
    const idx = nodes.findIndex((n) => n.id === BRAIN_NODE_ID);
    if (idx === -1) return;
    const d = nodes[idx].data as ChvorNodeData;
    if ("providerId" in d && d.providerId === providerId && "model" in d && d.model === model) return;
    const updated = [...nodes];
    updated[idx] = { ...nodes[idx], data: { ...nodes[idx].data, providerId, model } } as ChvorNode;
    set({ nodes: updated });
  },

  updateBrainLabel: (label: string) => {
    const nodes = get().nodes;
    const idx = nodes.findIndex((n) => n.id === BRAIN_NODE_ID);
    if (idx === -1) return;
    if ((nodes[idx].data as ChvorNodeData).label === label) return;
    const updated = [...nodes];
    updated[idx] = { ...nodes[idx], data: { ...nodes[idx].data, label } };
    set({ nodes: updated });
  },

  clearMindAgents: () => {
    const { nodes, edges } = get();
    set({
      nodes: nodes.filter((n) => n.type !== "mind-agent"),
      edges: edges.filter((e) => !e.id.startsWith("edge-mind-")),
    });
  },

  upsertMindAgent: ({ agentId, role, title, status = "running" }) => {
    const { nodes, edges } = get();
    const existingIdx = nodes.findIndex((n) => n.id === `mind-${agentId}`);
    const roleOrder: Record<MindAgentNodeData["role"], number> = { researcher: 0, planner: 1, critic: 2 };
    const angle = -Math.PI / 2 + roleOrder[role] * ((2 * Math.PI) / 3);
    const brain = nodes.find((n) => n.id === BRAIN_NODE_ID);
    const origin = brain?.position ?? { x: -90, y: -90 };
    const brainCenter = { x: origin.x + OFFSETS.brain.hw, y: origin.y + OFFSETS.brain.hh };
    const pos = {
      x: brainCenter.x + Math.cos(angle) * 245 - 58,
      y: brainCenter.y + Math.sin(angle) * 205 - 48,
    };

    const nextData: MindAgentNodeData = {
      type: "mind-agent",
      label: title,
      agentId,
      role,
      executionStatus: status,
    };

    let nextNodes = nodes;
    if (existingIdx === -1) {
      nextNodes = [
        ...nodes,
        {
          id: `mind-${agentId}`,
          type: "mind-agent" as const,
          position: pos,
          data: nextData,
        },
      ];
    } else {
      nextNodes = [...nodes];
      nextNodes[existingIdx] = {
        ...nodes[existingIdx],
        data: { ...nodes[existingIdx].data, ...nextData },
      } as ChvorNode;
    }

    const edgeId = `edge-mind-brain-${agentId}`;
    let nextEdges = edges.some((e) => e.id === edgeId)
      ? edges
      : [
          ...edges,
          {
            id: edgeId,
            source: BRAIN_NODE_ID,
            target: `mind-${agentId}`,
            type: "animated",
            animated: true,
            data: { active: true },
          },
        ];

    const peerNodes = nodes.filter((n) => n.type === "mind-agent" && n.id !== `mind-${agentId}`);
    for (const peer of peerNodes) {
      const peerEdgeId = `edge-mind-peer-${peer.id}-${agentId}`;
      if (nextEdges.some((e) => e.id === peerEdgeId)) continue;
      nextEdges = [
        ...nextEdges,
        {
          id: peerEdgeId,
          source: peer.id,
          target: `mind-${agentId}`,
          type: "animated",
          animated: true,
          data: { active: true },
        },
      ];
    }

    set({ nodes: nextNodes, edges: nextEdges });
  },

  completeMindAgent: (agentId, title, summary, durationMs) => {
    const nodes = get().nodes;
    const idx = nodes.findIndex((n) => n.id === `mind-${agentId}`);
    if (idx === -1) return;
    const updated = [...nodes];
    updated[idx] = {
      ...nodes[idx],
      data: {
        ...nodes[idx].data,
        label: title,
        summary,
        durationMs,
        executionStatus: "completed",
      },
    } as ChvorNode;
    set({ nodes: updated });
  },

  failMindAgent: (agentId, error) => {
    const nodes = get().nodes;
    const idx = nodes.findIndex((n) => n.id === `mind-${agentId}`);
    if (idx === -1) return;
    const updated = [...nodes];
    updated[idx] = {
      ...nodes[idx],
      data: { ...nodes[idx].data, summary: error, executionStatus: "failed" },
    } as ChvorNode;
    set({ nodes: updated });
  },

  addCanvasInputNode: ({ label, inputKind, preview }) => {
    const { nodes, edges } = get();
    const previousInputs = nodes.filter((n) => n.type === "canvas-input");
    const retainedInputs = previousInputs.slice(-5);
    const retainedInputIds = new Set(retainedInputs.map((n) => n.id));
    const baseNodes = nodes.filter((n) => n.type !== "canvas-input" || retainedInputIds.has(n.id));
    const baseEdges = edges.filter((e) => !e.id.startsWith("edge-input-") || retainedInputIds.has(e.source) || retainedInputIds.has(e.target));
    const existingInputs = retainedInputs.length;
    const id = `input-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const brain = baseNodes.find((n) => n.id === BRAIN_NODE_ID);
    const origin = brain?.position ?? { x: -90, y: -90 };
    const brainCenter = { x: origin.x + OFFSETS.brain.hw, y: origin.y + OFFSETS.brain.hh };
    const angle = Math.PI / 3 + existingInputs * 0.38;
    const radius = 320 + Math.min(existingInputs, 4) * 18;
    const position = {
      x: brainCenter.x + Math.cos(angle) * radius - 72,
      y: brainCenter.y + Math.sin(angle) * radius - 44,
    };

    const node: ChvorNode = {
      id,
      type: "canvas-input",
      position,
      data: {
        type: "canvas-input",
        label,
        inputKind,
        preview,
        executionStatus: "completed",
      },
    };

    set({
      nodes: [...baseNodes, node],
      edges: [
        ...baseEdges,
        {
          id: `edge-input-brain-${id}`,
          source: id,
          target: BRAIN_NODE_ID,
          type: "animated",
          animated: true,
          data: { active: true },
        },
      ],
    });
  },
}));
