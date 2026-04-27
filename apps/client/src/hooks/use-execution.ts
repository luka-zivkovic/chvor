import { useEffect, useRef } from "react";
import { useAppStore } from "../stores/app-store";
import { useCanvasStore } from "../stores/canvas-store";
import { useFeatureStore } from "../stores/feature-store";
import { useSessionStore } from "../stores/session-store";
import type { ExecutionEvent } from "@chvor/shared";

const BRAIN_NODE_ID = "brain-0";
// Minimum time a node stays "running" before transitioning to completed/failed
const MIN_RUNNING_MS = 500;
// How long an edge stays active after deactivation is requested
const EDGE_LINGER_MS = 800;

export function useExecution() {
  const executionEvents = useAppStore((s) => s.executionEvents);
  const { setNodeExecutionStatus, setEdgeActive, resetExecution } =
    useCanvasStore();
  const prevEventsRef = useRef<typeof executionEvents>([]);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Track when nodes entered "running" state for minimum display enforcement
  const runningTimestamps = useRef(new Map<string, number>());
  // Track pending delayed transitions so we can cancel them on new execution
  const pendingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /** Schedule a callback, tracked by key so it can be cancelled */
  function scheduleDelayed(key: string, fn: () => void, delayMs: number) {
    clearTimeout(pendingTimers.current.get(key));
    pendingTimers.current.set(key, setTimeout(() => {
      pendingTimers.current.delete(key);
      fn();
    }, delayMs));
  }

  /** Cancel all pending delayed transitions */
  function clearAllPending() {
    for (const t of pendingTimers.current.values()) clearTimeout(t);
    pendingTimers.current.clear();
    runningTimestamps.current.clear();
  }

  /** Set node to "running" and record timestamp */
  function markRunning(nodeId: string) {
    setNodeExecutionStatus(nodeId, "running");
    runningTimestamps.current.set(nodeId, Date.now());
  }

  /** Transition node from "running" to a final status, respecting minimum display time */
  function markNodeFinal(nodeId: string, status: "completed" | "failed") {
    const startedAt = runningTimestamps.current.get(nodeId) ?? 0;
    const elapsed = Date.now() - startedAt;
    const remaining = MIN_RUNNING_MS - elapsed;
    if (remaining > 0) {
      scheduleDelayed(`node-${nodeId}`, () => {
        setNodeExecutionStatus(nodeId, status);
        runningTimestamps.current.delete(nodeId);
      }, remaining);
    } else {
      setNodeExecutionStatus(nodeId, status);
      runningTimestamps.current.delete(nodeId);
    }
  }

  /** Deactivate an edge with a linger delay so the glow fades visually */
  function deactivateEdge(edgeId: string) {
    scheduleDelayed(`edge-${edgeId}`, () => setEdgeActive(edgeId, false), EDGE_LINGER_MS);
  }

  useEffect(() => {
    const prev = prevEventsRef.current;
    prevEventsRef.current = executionEvents;
    // If array was replaced (new execution), process from start
    const newEvents = executionEvents === prev ? [] :
      executionEvents.length > prev.length ? executionEvents.slice(prev.length) :
      executionEvents; // array was reset, process all

    function handleEvent(event: ExecutionEvent) {
      switch (event.type) {
        case "execution.started":
          clearTimeout(resetTimer.current);
          clearAllPending();
          resetExecution();
          markRunning(BRAIN_NODE_ID);
          break;

        case "brain.thinking":
          markRunning(BRAIN_NODE_ID);
          break;

        case "brain.decision": {
          const eventData = event.data as Record<string, unknown>;
          const kind = eventData.capabilityKind;
          if (kind === "tool") {
            const toolId = eventData.toolId as string | undefined;
            if (toolId) {
              setEdgeActive("edge-brain-tools-hub", true);
              setEdgeActive(`edge-tools-hub-${toolId}`, true);
            }
          } else {
            const skillId = eventData.skillId as string | undefined;
            if (skillId) {
              setEdgeActive("edge-brain-skills-hub", true);
              setEdgeActive(`edge-skills-hub-${skillId}`, true);
            }
          }
          break;
        }

        case "brain.emotion":
          // Handled by emotion-store via separate WebSocket subscription
          break;

        case "skill.invoked": {
          const rawNodeId = event.data.nodeId;
          const isChannel = rawNodeId.startsWith("channel-");
          const isApi = rawNodeId.startsWith("api-");
          const nodeId = isChannel || isApi ? rawNodeId
            : rawNodeId.startsWith("skill-") ? rawNodeId
            : `skill-${rawNodeId}`;
          markRunning(nodeId);
          if (isApi) {
            const credId = rawNodeId.replace("api-", "");
            markRunning("connections-hub");
            setEdgeActive("edge-brain-connections-hub", true);
            setEdgeActive(`edge-connections-hub-${credId}`, true);
          } else if (isChannel) {
            const credId = rawNodeId.replace("channel-", "");
            markRunning("integrations-hub");
            setEdgeActive("edge-brain-integrations-hub", true);
            setEdgeActive(`edge-integrations-hub-${credId}`, true);
          } else {
            markRunning("skills-hub");
            setEdgeActive("edge-brain-skills-hub", true);
            const skillId = nodeId.replace("skill-", "");
            setEdgeActive(`edge-skills-hub-${skillId}`, true);
          }
          break;
        }

        case "skill.completed": {
          const rawNodeId = event.data.nodeId;
          const isChannel = rawNodeId.startsWith("channel-");
          const isApi = rawNodeId.startsWith("api-");
          const nodeId = isChannel || isApi ? rawNodeId
            : rawNodeId.startsWith("skill-") ? rawNodeId
            : `skill-${rawNodeId}`;
          markNodeFinal(nodeId, "completed");
          if (isApi) {
            const credId = rawNodeId.replace("api-", "");
            markNodeFinal("connections-hub", "completed");
            deactivateEdge("edge-brain-connections-hub");
            deactivateEdge(`edge-connections-hub-${credId}`);
          } else if (isChannel) {
            const credId = rawNodeId.replace("channel-", "");
            markNodeFinal("integrations-hub", "completed");
            deactivateEdge("edge-brain-integrations-hub");
            deactivateEdge(`edge-integrations-hub-${credId}`);
          } else {
            markNodeFinal("skills-hub", "completed");
            deactivateEdge("edge-brain-skills-hub");
            const skillId = nodeId.replace("skill-", "");
            deactivateEdge(`edge-skills-hub-${skillId}`);
          }
          break;
        }

        case "skill.failed": {
          const rawNodeId = event.data.nodeId;
          const isChannel = rawNodeId.startsWith("channel-");
          const isApi = rawNodeId.startsWith("api-");
          const nodeId = isChannel || isApi ? rawNodeId
            : rawNodeId.startsWith("skill-") ? rawNodeId
            : `skill-${rawNodeId}`;
          markNodeFinal(nodeId, "failed");
          if (isApi) {
            const credId = rawNodeId.replace("api-", "");
            markNodeFinal("connections-hub", "failed");
            deactivateEdge("edge-brain-connections-hub");
            deactivateEdge(`edge-connections-hub-${credId}`);
          } else if (isChannel) {
            const credId = rawNodeId.replace("channel-", "");
            markNodeFinal("integrations-hub", "failed");
            deactivateEdge("edge-brain-integrations-hub");
            deactivateEdge(`edge-integrations-hub-${credId}`);
          } else {
            markNodeFinal("skills-hub", "failed");
            deactivateEdge("edge-brain-skills-hub");
            const skillId = nodeId.replace("skill-", "");
            deactivateEdge(`edge-skills-hub-${skillId}`);
          }
          break;
        }

        case "tool.invoked": {
          const rawNodeId = event.data.nodeId;
          const nodeId = rawNodeId.startsWith("tool-") ? rawNodeId : `tool-${rawNodeId}`;
          markRunning(nodeId);
          markRunning("tools-hub");
          setEdgeActive("edge-brain-tools-hub", true);
          const toolId = nodeId.replace("tool-", "");
          setEdgeActive(`edge-tools-hub-${toolId}`, true);
          break;
        }

        case "tool.completed": {
          const rawNodeId = event.data.nodeId;
          const nodeId = rawNodeId.startsWith("tool-") ? rawNodeId : `tool-${rawNodeId}`;
          markNodeFinal(nodeId, "completed");
          markNodeFinal("tools-hub", "completed");
          deactivateEdge("edge-brain-tools-hub");
          const toolId = nodeId.replace("tool-", "");
          deactivateEdge(`edge-tools-hub-${toolId}`);
          break;
        }

        case "tool.failed": {
          const rawNodeId = event.data.nodeId;
          const nodeId = rawNodeId.startsWith("tool-") ? rawNodeId : `tool-${rawNodeId}`;
          markNodeFinal(nodeId, "failed");
          markNodeFinal("tools-hub", "failed");
          deactivateEdge("edge-brain-tools-hub");
          const toolId = nodeId.replace("tool-", "");
          deactivateEdge(`edge-tools-hub-${toolId}`);
          break;
        }

        case "pc.screenshot":
        case "pc.action":
        case "pc.pipeline.start":
          markRunning("skill-pc-control");
          markRunning("skills-hub");
          setEdgeActive("edge-brain-skills-hub", true);
          setEdgeActive("edge-skills-hub-pc-control", true);
          break;

        case "pc.actionCompleted":
        case "pc.pipeline.complete":
          markNodeFinal("skill-pc-control", event.data.success ? "completed" : "failed");
          deactivateEdge("edge-brain-skills-hub");
          deactivateEdge("edge-skills-hub-pc-control");
          break;

        case "pc.pipeline.layer":
          useSessionStore.getState().handlePipelineEvent(event.type, event.data);
          break;

        case "execution.completed":
          markNodeFinal(BRAIN_NODE_ID, "completed");
          useFeatureStore.getState().fetchSkills();
          useFeatureStore.getState().fetchTools();
          useFeatureStore.getState().fetchCredentials();
          clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => {
            clearAllPending();
            resetExecution();
          }, 2000);
          break;

        case "execution.failed":
          markNodeFinal(BRAIN_NODE_ID, "failed");
          clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => {
            clearAllPending();
            resetExecution();
          }, 3000);
          break;

        case "tool.bag.resolved":
          // No canvas mutation — rationale is stored in app-store via
          // `lastToolBag` for the debug panel.
          break;
      }
    }

    for (const event of newEvents) {
      handleEvent(event);
    }

    return () => {
      clearTimeout(resetTimer.current);
    };
  }, [executionEvents, setNodeExecutionStatus, setEdgeActive, resetExecution]);

  useEffect(() => {
    return () => {
      clearTimeout(resetTimer.current);
      clearAllPending();
    };
  }, []);
}
