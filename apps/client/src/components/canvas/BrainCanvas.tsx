import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { ReactFlow, Background, BackgroundVariant, MiniMap } from "@xyflow/react";
import type { ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useCanvasStore } from "../../stores/canvas-store";
import type { ChvorNode, ChvorEdge } from "../../stores/canvas-store";
import { useAppStore } from "../../stores/app-store";
import { useUIStore } from "../../stores/ui-store";
import { useSkillStore } from "../../stores/skill-store";
import { usePersonaStore } from "../../stores/persona-store";
import { EMOTION_COLORS } from "@chvor/shared";
import { useScheduleStore } from "../../stores/schedule-store";
import { useWebhookStore } from "../../stores/webhook-store";
import { useCredentialStore } from "../../stores/credential-store";
import { useModelsStore } from "../../stores/models-store";
import { useToolStore } from "../../stores/tool-store";
import { api } from "../../lib/api";
import type { AnyProviderDef } from "@chvor/shared";
import { BrainNode } from "./BrainNode";
import { SkillNode } from "./SkillNode";
import { ScheduleHubNode } from "./ScheduleHubNode";
import { ScheduleNode } from "./ScheduleNode";
import { IntegrationNode } from "./IntegrationNode";
import { ConnectionsHubNode } from "./ConnectionsHubNode";
import { IntegrationsHubNode } from "./IntegrationsHubNode";
import { SkillsHubNode } from "./SkillsHubNode";
import { ToolsHubNode } from "./ToolsHubNode";
import { ToolNode } from "./ToolNode";
import { WebhooksHubNode } from "./WebhooksHubNode";
import { WebhookNode } from "./WebhookNode";
import { TriggerNode } from "./TriggerNode";
import { OutputNode } from "./OutputNode";
import { AnimatedEdge } from "./AnimatedEdge";
import { CanvasControls } from "./CanvasControls";
import { CanvasContextMenu } from "./CanvasContextMenu";
import type { ContextMenuState } from "./CanvasContextMenu";
import { GhostHubNode } from "./GhostHubNode";
import { A2UICanvasNode } from "./A2UICanvasNode";

const nodeTypes = { brain: BrainNode, skill: SkillNode, tool: ToolNode, integration: IntegrationNode, "skills-hub": SkillsHubNode, "tools-hub": ToolsHubNode, "connections-hub": ConnectionsHubNode, "integrations-hub": IntegrationsHubNode, "schedule-hub": ScheduleHubNode, schedule: ScheduleNode, "webhooks-hub": WebhooksHubNode, webhook: WebhookNode, trigger: TriggerNode, output: OutputNode, "ghost-hub": GhostHubNode, "a2ui-canvas": A2UICanvasNode };
const edgeTypes = { animated: AnimatedEdge };

// MiniMap needs resolved color strings (CSS vars don't work in SVG fill)
function minimapNodeColor(node: { type?: string }): string {
  switch (node.type) {
    case "brain":            return "oklch(0.62 0.13 250)";
    case "skills-hub":
    case "skill":            return "oklch(0.65 0.18 340)";
    case "tools-hub":
    case "tool":             return "oklch(0.68 0.15 70)";
    case "integrations-hub":
    case "integration":      return "oklch(0.60 0.18 260)";
    case "connections-hub":  return "oklch(0.60 0.18 260)";
    case "schedule-hub":
    case "schedule":         return "oklch(0.70 0.14 160)";
    case "webhooks-hub":
    case "webhook":          return "oklch(0.62 0.13 250)";
    case "trigger":          return "oklch(0.70 0.14 160)";
    case "output":           return "oklch(0.62 0.13 250)";
    case "ghost-hub":        return "oklch(0.69 0.008 280 / 0.4)";
    default:                 return "oklch(0.69 0.008 280)";
  }
}

export function BrainCanvas() {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    initializeFromSkills,
    initializeEmptyState,
    updateBrainLabel,
  } = useCanvasStore();
  const persona = usePersonaStore((s) => s.persona);
  const { skills, fetchSkills } = useSkillStore();
  const { tools, fetchTools } = useToolStore();
  const { schedules, fetchAll: fetchSchedules } = useScheduleStore();
  const { webhooks, fetchAll: fetchWebhooks } = useWebhookStore();
  const { credentials, providers, fetchAll: fetchCredentials } = useCredentialStore();
  const connected = useAppStore((s) => s.connected);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, nodeId: null, nodeType: null });
  const initializedRef = useRef<string | undefined>(undefined);
  const rfInstanceRef = useRef<ReactFlowInstance<ChvorNode, ChvorEdge> | null>(null);
  const savedPositionsRef = useRef<Map<string, { x: number; y: number }> | undefined>(undefined);
  const savedViewportRef = useRef<{ x: number; y: number; zoom: number } | undefined>(undefined);
  const [layoutLoaded, setLayoutLoaded] = useState(false);

  // Local helper (runtime import from @chvor/shared broken on Windows)
  const isLLMProvider = (p: AnyProviderDef): boolean => "models" in p;

  useEffect(() => {
    fetchSkills();
    fetchTools();
    fetchCredentials();
    fetchSchedules();
    fetchWebhooks();
  }, [fetchSkills, fetchTools, fetchCredentials, fetchSchedules, fetchWebhooks]);

  // Load saved layout from server — re-fetch when WS connects (covers late server start + reconnect)
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setLayoutLoaded(false); // hold canvas init until fresh layout arrives
    api.workspaces.get("default-constellation").then((ws) => {
      if (cancelled) return;
      if (ws && ws.nodes.length > 0) {
        const posMap = new Map<string, { x: number; y: number }>();
        for (const n of ws.nodes) posMap.set(n.id, n.position);
        savedPositionsRef.current = posMap;
        savedViewportRef.current = ws.viewport;
      }
      initializedRef.current = undefined; // force canvas re-init
      setLayoutLoaded(true);
    }).catch(() => {
      if (!cancelled) setLayoutLoaded(true);
    });
    return () => { cancelled = true; };
  }, [connected]);

  // Split non-LLM credentials into channels vs API integrations
  const CHANNEL_TYPES = useMemo(() => new Set(["telegram", "discord", "slack", "whatsapp"]), []);
  const LLM_TYPES = useMemo(() => new Set(["openai", "anthropic", "deepseek", "minimax", "openrouter", "google-ai", "groq", "mistral", "custom-llm", "ollama", "ollama-cloud"]), []);

  const channelIntegrations = useMemo(
    () => credentials.filter((c) => CHANNEL_TYPES.has(c.type)),
    [credentials, CHANNEL_TYPES]
  );
  const apiIntegrations = useMemo(
    () => credentials.filter((c) => !LLM_TYPES.has(c.type) && !CHANNEL_TYPES.has(c.type)),
    [credentials, LLM_TYPES, CHANNEL_TYPES]
  );

  useEffect(() => {
    if (!layoutLoaded) return;
    const enabledSkills = skills.filter((s) => s.enabled !== false);
    const credTypeSet = new Set(credentials.map((c) => c.type as string));
    const enabledTools = tools.filter((t) => {
      if (t.enabled === false) return false;
      const requiredCreds = t.metadata.requires?.credentials;
      if (requiredCreds && requiredCreds.length > 0) {
        return requiredCreds.every((cred) => credTypeSet.has(cred));
      }
      return true;
    });
    const scheduleKey = schedules.map((s) => `${s.id}:${s.enabled}`).join(",");
    const webhookKey = webhooks.map((w) => `${w.id}:${w.enabled}`).join(",");
    const channelKey = channelIntegrations.map((c) => c.id).join(",");
    const apiKey = apiIntegrations.map((c) => c.id).join(",");
    const skillKey = skills.map((s) => `${s.id}:${s.enabled}`).join(",");
    const toolKey = tools.map((t) => `${t.id}:${t.enabled}`).join(",");
    const key = `sk:${skillKey}-tools:${toolKey}-${scheduleKey}-wh:${webhookKey}-ch:${channelKey}-api:${apiKey}`;
    if (initializedRef.current !== key) {
      const isFirstInit = initializedRef.current === undefined;
      initializedRef.current = key;
      if (skills.length === 0 && tools.length === 0) {
        initializeEmptyState(savedPositionsRef.current);
      } else {
        initializeFromSkills(enabledSkills, enabledTools, schedules, savedPositionsRef.current, channelIntegrations, apiIntegrations, webhooks);
      }
      // Restore saved viewport on first init, refit on subsequent
      if (isFirstInit && savedViewportRef.current) {
        setTimeout(() => {
          rfInstanceRef.current?.setViewport(savedViewportRef.current!, { duration: 300 });
        }, 50);
      } else if (!isFirstInit) {
        setTimeout(() => {
          rfInstanceRef.current?.fitView({ padding: 0.3, duration: 300 });
        }, 50);
      }
    }
  }, [skills, tools, schedules, webhooks, channelIntegrations, apiIntegrations, initializeFromSkills, initializeEmptyState, layoutLoaded]);

  const handleSaveLayout = useCallback(async () => {
    const rf = rfInstanceRef.current;
    if (!rf) return;
    const { nodes: currentNodes, edges: currentEdges } = useCanvasStore.getState();
    const viewport = rf.getViewport();
    const workspaceId = "default-constellation";
    // Map to WorkspaceNode shape (strip runtime-only fields)
    const saveNodes = currentNodes.map((n) => ({
      id: n.id,
      type: n.type ?? "skill",
      position: n.position,
      data: n.data,
    }));
    const saveEdges = currentEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
    }));
    await api.workspaces.save(workspaceId, {
      nodes: saveNodes,
      edges: saveEdges,
      viewport,
      settings: { maxRetries: 3, timeoutMs: 30000 },
    });
    // Update saved ref so subsequent inits use saved positions
    const posMap = new Map<string, { x: number; y: number }>();
    for (const n of currentNodes) posMap.set(n.id, n.position);
    savedPositionsRef.current = posMap;
    savedViewportRef.current = viewport;
    return true;
  }, []);

  // Sync brain node with configured model (from models-store), falling back to credential auto-detect
  const modelRoles = useModelsStore((s) => s.roles);
  const llmProviderDefs = useCredentialStore((s) => s.llmProviders);

  useEffect(() => {
    if (nodes.length === 0) return;
    const { updateBrainProvider } = useCanvasStore.getState();

    // If user has explicitly configured a primary model, show that
    if (modelRoles.primary) {
      const provDef = llmProviderDefs.find((p) => p.id === modelRoles.primary!.providerId);
      const modelDef = provDef?.models.find((m) => m.id === modelRoles.primary!.model);
      const displayModel = modelDef?.name ?? modelRoles.primary.model;
      updateBrainProvider(modelRoles.primary.providerId, displayModel);
      return;
    }

    // Fallback: auto-detect from first provider with valid credentials
    const llmProviders = providers.filter(isLLMProvider);
    const activeProvider = llmProviders.find((p) =>
      credentials.some(
        (c) => c.type === p.credentialType && c.testStatus === "success"
      )
    );

    if (activeProvider) {
      const defaultModel =
        "models" in activeProvider && activeProvider.models[0]
          ? activeProvider.models[0].name
          : activeProvider.name;
      updateBrainProvider(activeProvider.id, defaultModel);
    } else if (
      credentials.some((c) => LLM_TYPES.has(c.type))
    ) {
      updateBrainProvider("", "");
    } else {
      updateBrainProvider("", "No provider");
    }
  }, [credentials, providers, nodes.length, modelRoles.primary, llmProviderDefs, LLM_TYPES]);

  // Sync brain label with persona aiName
  useEffect(() => {
    const aiName = persona?.aiName;
    if (aiName && nodes.length > 0) {
      updateBrainLabel(aiName);
    }
  }, [persona?.aiName, nodes.length, updateBrainLabel]);

  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: ChvorNode) => {
      event.preventDefault();
      setContextMenu({ visible: true, x: event.clientX, y: event.clientY, nodeId: node.id, nodeType: node.type ?? null });
    },
    []
  );

  const handlePaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      setContextMenu({ visible: true, x: event.clientX, y: event.clientY, nodeId: null, nodeType: null });
    },
    []
  );

  const closeContextMenu = useCallback(() => setContextMenu((prev) => ({ ...prev, visible: false })), []);

  // Single click: open appropriate left panel for each node type
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: ChvorNode) => {
      const ui = useUIStore.getState();
      if (node.type === "brain") {
        ui.openPanel("brain");
      } else if (node.type === "skill") {
        ui.openNodeDetail("skill-detail", node.id);
      } else if (node.type === "integration") {
        ui.openNodeDetail("integration-detail", node.id);
      } else if (node.type === "connections-hub") {
        ui.openPanel("settings");
      } else if (node.type === "integrations-hub") {
        ui.openPanel("settings");
      } else if (node.type === "skills-hub") {
        ui.openPanel("skills");
      } else if (node.type === "tools-hub") {
        ui.openPanel("tools");
      } else if (node.type === "tool") {
        const toolData = node.data as { toolId?: string };
        if (toolData.toolId === "a2ui") {
          ui.openCanvas();
        } else {
          ui.openNodeDetail("tool-detail", node.id);
        }
      } else if (node.type === "schedule-hub") {
        useScheduleStore.getState().selectSchedule(null);
        ui.openPanel("schedules");
      } else if (node.type === "schedule") {
        const schedData = node.data as { scheduleId?: string };
        if (schedData.scheduleId) {
          useScheduleStore.getState().selectSchedule(schedData.scheduleId);
        }
        ui.openPanel("schedules");
      } else if (node.type === "webhooks-hub") {
        useWebhookStore.getState().selectWebhook(null);
        ui.openPanel("webhooks");
      } else if (node.type === "webhook") {
        const whData = node.data as { webhookId?: string };
        if (whData.webhookId) {
          useWebhookStore.getState().selectWebhook(whData.webhookId);
        }
        ui.openPanel("webhooks");
      } else if (node.type === "ghost-hub") {
        const ghostData = node.data as { targetPanel?: string };
        if (ghostData.targetPanel) ui.openPanel(ghostData.targetPanel as any);
      } else if (node.type === "a2ui-canvas") {
        ui.openCanvas();
      }
    },
    []
  );

  // Auto-save layout when a node is dragged to a new position
  const handleNodeDragStop = useCallback(() => {
    handleSaveLayout();
  }, [handleSaveLayout]);

  const memoizedNodeTypes = useMemo(() => nodeTypes, []);
  const memoizedEdgeTypes = useMemo(() => edgeTypes, []);

  return (
    <div className="relative h-full w-full" tabIndex={-1} style={{ background: "var(--canvas-bg)" }}>
      <CanvasAtmosphere />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeDragStop={handleNodeDragStop}
        onInit={(instance) => { rfInstanceRef.current = instance; }}
        nodeTypes={memoizedNodeTypes}
        edgeTypes={memoizedEdgeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        style={{ position: "relative", zIndex: 1, backgroundColor: "transparent" }}
      >
        {/* SVG defs for markers */}
        <svg style={{ position: "absolute", width: 0, height: 0 }}>
          <defs>
            <marker
              id="arrow-active"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--canvas-accent)" opacity="0.7" />
            </marker>
          </defs>
        </svg>
        <Background
          variant={BackgroundVariant.Dots}
          gap={32}
          size={1}
          color="var(--canvas-dot)"
          bgColor="transparent"
        />
        <CanvasControls />
        <CanvasContextMenu menu={contextMenu} onClose={closeContextMenu} />
        <MiniMap
          nodeColor={minimapNodeColor}
          nodeStrokeWidth={0}
          zoomable
          pannable
          position="bottom-right"
          style={{
            background: "oklch(0.19 0.004 285 / 0.85)",
            borderRadius: 12,
            border: "1px solid oklch(0.30 0.007 275 / 0.5)",
          }}
          maskColor="oklch(0.17 0 0 / 0.7)"
        />
      </ReactFlow>
      <EmotionTintOverlay />
    </div>
  );
}

function CanvasAtmosphere() {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
      {/* Soft edge vignette */}
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 80% 75% at 50% 48%, transparent 40%, oklch(0.08 0 0 / 0.5) 100%)",
        }}
      />
    </div>
  );
}

/* Emotion shape configs — each emotion has a unique particle personality */
const EMOTION_PARTICLES: Record<string, { shape: string; count: number; sizeRange: [number, number]; anim: string }> = {
  curious: { shape: "?", count: 3, sizeRange: [14, 22], anim: "emotion-wander" },
  excited: { shape: "✦", count: 4, sizeRange: [10, 18], anim: "emotion-sparkle" },
  calm: { shape: "○", count: 3, sizeRange: [16, 28], anim: "emotion-drift" },
  empathetic: { shape: "♥", count: 3, sizeRange: [12, 18], anim: "emotion-float" },
  playful: { shape: "✿", count: 4, sizeRange: [12, 20], anim: "emotion-bounce" },
  focused: { shape: "◇", count: 3, sizeRange: [14, 20], anim: "emotion-converge" },
};

/* Deterministic pseudo-random positions for particles */
function seededPositions(count: number, seed: number) {
  const positions: { x: number; y: number; delay: number; size: number; rot: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = (seed * (i + 1) * 9301 + 49297) % 233280;
    const r = t / 233280;
    positions.push({
      x: 10 + (r * 80),
      y: 8 + (((t * 7) % 233280) / 233280) * 80,
      delay: (i * 1.2) + r * 2,
      size: 0.7 + r * 0.6,
      rot: Math.floor(r * 360),
    });
  }
  return positions;
}

function EmotionTintOverlay() {
  const currentEmotion = useAppStore((s) => s.currentEmotion);
  const color = currentEmotion ? EMOTION_COLORS[currentEmotion.emotion] : null;
  const intensity = currentEmotion?.intensity ?? 0;
  const emotionName = currentEmotion?.emotion ?? "calm";
  const config = EMOTION_PARTICLES[emotionName] ?? EMOTION_PARTICLES.calm;
  const positions = seededPositions(config.count, emotionName.length);

  // Ambient color wash — stronger than before
  const washAlpha = 0.06 + intensity * 0.1;

  return (
    <div
      className="pointer-events-none absolute inset-0 transition-all duration-[2000ms] ease-in-out"
      style={{ opacity: color ? 1 : 0 }}
    >
      {/* Soft ambient color wash */}
      <div
        className="absolute inset-0 transition-all duration-[2000ms]"
        style={{
          background: color
            ? `radial-gradient(ellipse 100% 80% at 50% 40%, ${color} 0%, transparent 55%)`
            : "none",
          filter: "blur(60px)",
          opacity: washAlpha,
        }}
      />
      {/* Whimsical floating particles — skip when intensity is negligible */}
      {color && intensity >= 0.1 && positions.map((pos, i) => (
        <div
          key={`${emotionName}-${i}`}
          className="absolute transition-all duration-[2000ms]"
          style={{
            left: `${pos.x}%`,
            top: `${pos.y}%`,
            fontSize: config.sizeRange[0] + (config.sizeRange[1] - config.sizeRange[0]) * pos.size,
            color: color,
            opacity: 0.3 + intensity * 0.3,
            animation: `${config.anim} ${6 + pos.delay}s ease-in-out ${pos.delay}s infinite`,
            transform: `rotate(${pos.rot}deg)`,
          }}
        >
          {config.shape}
        </div>
      ))}
    </div>
  );
}
