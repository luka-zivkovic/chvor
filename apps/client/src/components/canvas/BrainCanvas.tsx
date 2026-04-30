import { useState, useEffect, useMemo, useRef, useCallback, memo } from "react";
import { ReactFlow, Background, BackgroundVariant, MiniMap } from "@xyflow/react";
import type { ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useCanvasStore } from "../../stores/canvas-store";
import type { ChvorNode, ChvorEdge } from "../../stores/canvas-store";
import { useAppStore } from "../../stores/app-store";
import { useRuntimeStore } from "../../stores/runtime-store";
import { useUIStore } from "../../stores/ui-store";
import { useFeatureStore } from "../../stores/feature-store";
import { useConfigStore } from "../../stores/config-store";
import { EMOTION_COLORS } from "@chvor/shared";
import { api } from "../../lib/api";
import type { AnyProviderDef, MediaArtifact } from "@chvor/shared";
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
import { CanvasSearchDialog } from "./CanvasSearchDialog";
import { GhostHubNode } from "./GhostHubNode";
import { A2UICanvasNode } from "./A2UICanvasNode";
import { ThoughtStreamCanvas } from "./ThoughtStreamCanvas";
import { CognitiveLoopRail } from "./CognitiveLoopRail";
import { MindAgentNode } from "./MindAgentNode";
import { CanvasCommandDock } from "./CanvasCommandDock";
import { CanvasInputNode } from "./CanvasInputNode";

const nodeTypes = { brain: BrainNode, skill: SkillNode, tool: ToolNode, integration: IntegrationNode, "skills-hub": SkillsHubNode, "tools-hub": ToolsHubNode, "connections-hub": ConnectionsHubNode, "integrations-hub": IntegrationsHubNode, "schedule-hub": ScheduleHubNode, schedule: ScheduleNode, "webhooks-hub": WebhooksHubNode, webhook: WebhookNode, trigger: TriggerNode, output: OutputNode, "ghost-hub": GhostHubNode, "a2ui-canvas": A2UICanvasNode, "mind-agent": MindAgentNode, "canvas-input": CanvasInputNode };
const edgeTypes = { animated: AnimatedEdge };

const DEFAULT_WORKSPACE_ID = "default-constellation";
const CHANNEL_TYPES = new Set(["telegram", "discord", "slack", "whatsapp"]);
const LLM_TYPES = new Set(["openai", "anthropic", "deepseek", "minimax", "openrouter", "google-ai", "groq", "mistral", "custom-llm", "ollama", "ollama-cloud"]);

function hasCanvasDropPayload(types: readonly string[] | DOMStringList): boolean {
  const hasType = (value: string) => (
    typeof (types as DOMStringList).contains === "function"
      ? (types as DOMStringList).contains(value)
      : (types as readonly string[]).includes(value)
  );
  return hasType("Files") || hasType("text/uri-list") || hasType("text/plain");
}

function extractDroppedText(dataTransfer: DataTransfer): string {
  return (dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain") || "").trim();
}

function labelForUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return "Dropped URL";
  }
}

function toastCanvasError(message: string): void {
  void import("sonner").then(({ toast }) => toast.error(message)).catch(() => { /* optional */ });
}

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
    addCanvasInputNode,
  } = useCanvasStore();
  // Per-property selectors — reading the whole store object would re-render this 530 LOC
  // canvas on every mutation in any unrelated slice (voice config, knowledge, schedules, ...).
  const persona = useConfigStore((s) => s.persona);
  const skills = useFeatureStore((s) => s.skills);
  const fetchSkills = useFeatureStore((s) => s.fetchSkills);
  const tools = useFeatureStore((s) => s.tools);
  const fetchTools = useFeatureStore((s) => s.fetchTools);
  const schedules = useFeatureStore((s) => s.schedules);
  const fetchSchedules = useFeatureStore((s) => s.fetchSchedules);
  const webhooks = useFeatureStore((s) => s.webhooks);
  const fetchWebhooks = useFeatureStore((s) => s.fetchWebhooks);
  const credentials = useFeatureStore((s) => s.credentials);
  const providers = useFeatureStore((s) => s.providers);
  const fetchCredentials = useFeatureStore((s) => s.fetchCredentials);
  const connected = useAppStore((s) => s.connected);
  const sendChat = useAppStore((s) => s._sendChat);
  const fetchCognitiveLoops = useRuntimeStore((s) => s.fetchCognitiveLoops);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, nodeId: null, nodeType: null });
  const [searchDialog, setSearchDialog] = useState<{ open: boolean; initialKind: "skill" | "tool" | null }>({ open: false, initialKind: null });
  const [dragActive, setDragActive] = useState(false);
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

  useEffect(() => {
    if (connected) void fetchCognitiveLoops();
  }, [connected, fetchCognitiveLoops]);

  // Load saved layout from server — re-fetch when WS connects (covers late server start + reconnect)
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setLayoutLoaded(false); // hold canvas init until fresh layout arrives
    api.workspaces.get(DEFAULT_WORKSPACE_ID).then((ws) => {
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
  const channelIntegrations = useMemo(
    () => credentials.filter((c) => CHANNEL_TYPES.has(c.type)),
    [credentials]
  );
  const apiIntegrations = useMemo(
    () => credentials.filter((c) => !LLM_TYPES.has(c.type) && !CHANNEL_TYPES.has(c.type)),
    [credentials]
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
      // Always use full layout — hubs are always visible even when empty
      initializeFromSkills(enabledSkills, enabledTools, schedules, savedPositionsRef.current, channelIntegrations, apiIntegrations, webhooks);
      // Restore saved viewport on first init, refit on subsequent
      if (isFirstInit && savedViewportRef.current) {
        setTimeout(() => {
          if (savedViewportRef.current) {
            rfInstanceRef.current?.setViewport(savedViewportRef.current, { duration: 300 });
          }
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
    const workspaceId = DEFAULT_WORKSPACE_ID;
    // Map to WorkspaceNode shape (strip runtime-only fields)
    const persistentNodes = currentNodes.filter((n) => n.type !== "mind-agent" && n.type !== "canvas-input");
    const persistentEdges = currentEdges.filter((e) => !e.id.startsWith("edge-mind-") && !e.id.startsWith("edge-input-"));
    const saveNodes = persistentNodes.map((n) => ({
      id: n.id,
      type: n.type ?? "skill",
      position: n.position,
      data: n.data,
    }));
    const saveEdges = persistentEdges.map((e) => ({
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
    for (const n of persistentNodes) posMap.set(n.id, n.position);
    savedPositionsRef.current = posMap;
    savedViewportRef.current = viewport;
    return true;
  }, []);

  // Sync brain node with configured model (from models-store), falling back to credential auto-detect
  const modelRoles = useConfigStore((s) => s.roles);
  const llmProviderDefs = useFeatureStore((s) => s.llmProviders);

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
  }, [credentials, providers, nodes.length, modelRoles.primary, llmProviderDefs]);

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

  const openSearchDialog = useCallback((kind: "skill" | "tool" | null) => {
    setSearchDialog({ open: true, initialKind: kind });
  }, []);
  const closeSearchDialog = useCallback(() => setSearchDialog({ open: false, initialKind: null }), []);

  // Ctrl+K to open search dialog
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "k") {
        e.preventDefault();
        setSearchDialog((prev) => prev.open ? { open: false, initialKind: null } : { open: true, initialKind: null });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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
        ui.openPanel("connections");
      } else if (node.type === "integrations-hub") {
        ui.openPanel("integrations");
      } else if (node.type === "skills-hub") {
        ui.openPanel("skills");
      } else if (node.type === "tools-hub") {
        ui.openPanel("tools");
      } else if (node.type === "tool") {
        const toolData = node.data as { toolId?: string };
        if (toolData.toolId === "a2ui") {
          ui.openPreviewModal();
        } else {
          ui.openNodeDetail("tool-detail", node.id);
        }
      } else if (node.type === "schedule-hub") {
        useFeatureStore.getState().selectSchedule(null);
        ui.openPanel("schedules");
      } else if (node.type === "schedule") {
        const schedData = node.data as { scheduleId?: string };
        if (schedData.scheduleId) {
          useFeatureStore.getState().selectSchedule(schedData.scheduleId);
        }
        ui.openPanel("schedules");
      } else if (node.type === "webhooks-hub") {
        useFeatureStore.getState().selectWebhook(null);
        ui.openPanel("webhooks");
      } else if (node.type === "webhook") {
        const whData = node.data as { webhookId?: string };
        if (whData.webhookId) {
          useFeatureStore.getState().selectWebhook(whData.webhookId);
        }
        ui.openPanel("webhooks");
      } else if (node.type === "ghost-hub") {
        const ghostData = node.data as { targetPanel?: string };
        if (ghostData.targetPanel) ui.openPanel(ghostData.targetPanel as any);
      } else if (node.type === "a2ui-canvas") {
        ui.openPreviewModal();
      }
    },
    []
  );

  // Auto-save layout when a node is dragged to a new position
  const handleNodeDragStop = useCallback(() => {
    handleSaveLayout().catch((err) => {
      console.error("[BrainCanvas] Failed to save layout:", err);
    });
  }, [handleSaveLayout]);

  const uploadDroppedFiles = useCallback(async (files: FileList): Promise<MediaArtifact[]> => {
    const artifacts: MediaArtifact[] = [];
    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/media/upload", { method: "POST", body: formData, credentials: "same-origin" });
      if (!res.ok) continue;
      artifacts.push((await res.json()) as MediaArtifact);
    }
    return artifacts;
  }, []);

  const handleCanvasDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    const files = event.dataTransfer.files;
    const droppedText = extractDroppedText(event.dataTransfer);
    if (!files.length && !droppedText) {
      setDragActive(false);
      return;
    }
    event.preventDefault();
    setDragActive(false);
    if (files.length > 0) {
      const artifacts = await uploadDroppedFiles(files);
      if (artifacts.length > 0) {
        artifacts.forEach((artifact) => {
          addCanvasInputNode({
            label: artifact.filename ?? `${artifact.mediaType} drop`,
            inputKind: "file",
            preview: `${artifact.mediaType} · ${artifact.mimeType}${artifact.sizeBytes ? ` · ${Math.round(artifact.sizeBytes / 1024)}KB` : ""}`,
          });
        });
        sendChat("Analyze the files I dropped onto the canvas.", undefined, artifacts);
      } else {
        toastCanvasError("Couldn't upload dropped file.");
      }
      return;
    }
    const urls = droppedText
      .split(/\s+/)
      .filter((value) => /^https?:\/\//i.test(value));
    if (urls.length > 0) {
      urls.slice(0, 4).forEach((url) => addCanvasInputNode({ label: labelForUrl(url), inputKind: "url", preview: url }));
      sendChat(`Analyze ${urls.length === 1 ? "this URL" : "these URLs"} I dropped onto the canvas:\n${urls.join("\n")}`);
    } else {
      addCanvasInputNode({ label: "Dropped text", inputKind: "text", preview: droppedText.slice(0, 240) });
      sendChat(`Use this dropped canvas input:\n${droppedText.slice(0, 4000)}`);
    }
  }, [addCanvasInputNode, sendChat, uploadDroppedFiles]);

  return (
    <div
      className="relative h-full w-full transition-[opacity,filter] duration-500"
      tabIndex={-1}
      onDragOver={(event) => {
        if (hasCanvasDropPayload(event.dataTransfer.types)) {
          event.preventDefault();
          setDragActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragActive(false);
      }}
      onDrop={handleCanvasDrop}
      style={{
        background: "var(--canvas-bg)",
        opacity: connected ? 1 : 0.55,
        filter: connected ? "none" : "saturate(0.6)",
      }}
    >
      <CanvasAtmosphere />
      <ThoughtStreamCanvas rfInstance={rfInstanceRef} />
      <CognitiveLoopRail />
      <CanvasCommandDock />
      {dragActive && (
        <div className="pointer-events-none absolute inset-4 z-30 flex items-center justify-center rounded-3xl border border-primary/40 bg-primary/8 text-sm text-primary backdrop-blur-sm">
          Drop files, URLs, screenshots, or clips onto the cognitive canvas
        </div>
      )}
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
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
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
        <CanvasContextMenu menu={contextMenu} onClose={closeContextMenu} onOpenSearch={openSearchDialog} />
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
      <CanvasSearchDialog
        open={searchDialog.open}
        onClose={closeSearchDialog}
        initialKind={searchDialog.initialKind}
      />
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
          background: "radial-gradient(ellipse 85% 80% at 50% 35%, transparent 40%, oklch(0.08 0 0 / 0.5) 100%)",
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

const EmotionTintOverlay = memo(function EmotionTintOverlay() {
  // Prefer VAD-based emotion store; fall back to legacy
  const vadColor = useRuntimeStore((s) => s.displayColor);
  const vadIntensity = useRuntimeStore((s) => s.blendIntensity);
  const vadLabel = useRuntimeStore((s) => s.displayLabel);
  const dominance = useRuntimeStore((s) => s.currentSnapshot?.vad?.dominance ?? 0);

  const currentEmotion = useAppStore((s) => s.currentEmotion);
  const legacyColor = currentEmotion ? EMOTION_COLORS[currentEmotion.emotion] : null;

  const color = vadColor ?? legacyColor;
  const intensity = vadIntensity || currentEmotion?.intensity || 0;
  const emotionName = vadLabel || currentEmotion?.emotion || "calm";
  const config = EMOTION_PARTICLES[emotionName] ?? EMOTION_PARTICLES.calm;
  const positions = useMemo(() => seededPositions(config.count, emotionName.length), [config.count, emotionName]);

  // Ambient wash alpha
  const washAlpha = 0.05 + intensity * 0.08;

  // Vignette tightness modulated by dominance: assertive = tight focused, yielding = wide diffuse
  const vignetteSize = 75 + ((1 - dominance) / 2) * 15; // 75-90%

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
            ? `radial-gradient(ellipse 130% ${vignetteSize}% at 50% 25%, ${color} 0%, transparent 65%)`
            : "none",
          filter: "blur(60px)",
          opacity: washAlpha,
        }}
      />
      {/* Organic floating particles — skip when intensity is negligible */}
      {color && intensity >= 0.15 && positions.map((pos, i) => (
        <div
          key={`${emotionName}-${i}`}
          className="absolute transition-all duration-[2500ms]"
          style={{
            left: `${pos.x}%`,
            top: `${pos.y}%`,
            fontSize: config.sizeRange[0] + (config.sizeRange[1] - config.sizeRange[0]) * pos.size,
            color: color,
            opacity: 0.2 + intensity * 0.25,
            animation: `${config.anim} ${7 + pos.delay}s ease-in-out ${pos.delay}s infinite`,
            transform: `rotate(${pos.rot}deg)`,
          }}
        >
          {config.shape}
        </div>
      ))}
    </div>
  );
});
