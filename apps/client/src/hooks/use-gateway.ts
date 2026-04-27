import { useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../stores/app-store";
import { useFeatureStore } from "../stores/feature-store";
import { useConfigStore } from "../stores/config-store";
import { useRuntimeStore } from "../stores/runtime-store";
import type { GatewayClientEvent, GatewayServerEvent, MediaArtifact } from "@chvor/shared";
import { SESSION_ID_KEY } from "../lib/constants";

const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY = 30_000;
// Match server-side HEARTBEAT_INTERVAL_MS — the server sends pings every 15s
// and evicts after 60s of silence, so 15s here keeps us well under the cliff.
const HEARTBEAT_INTERVAL_MS = 15_000;

function getOrCreateSessionId(): string {
  let id = localStorage.getItem(SESSION_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_ID_KEY, id);
  }
  return id;
}

export function useGateway() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const attemptRef = useRef(0);

  const intentionalCloseRef = useRef(false);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimer.current !== undefined) {
      clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = undefined;
    }
  }, []);

  const connect = useCallback(() => {
    // Guard against duplicate connections (e.g. React StrictMode double-mount)
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Cookies are sent automatically for same-origin WebSocket connections
    const url = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    intentionalCloseRef.current = false;

    ws.onopen = () => {
      console.log("[ws] connected");
      attemptRef.current = 0;
      useAppStore.getState().setConnected(true);
      useAppStore.getState().setReconnecting(false);

      // Send persistent session ID immediately
      const sessionId = getOrCreateSessionId();
      ws.send(JSON.stringify({ type: "session.init", data: { sessionId } }));
      useAppStore.getState().setSessionId(sessionId);

      // Load conversation history from server
      useAppStore.getState().loadSessionHistory(sessionId);

      // Load emotion history for this session
      useRuntimeStore.getState().loadSessionHistory(sessionId);

      // Load conversations list
      useAppStore.getState().loadConversations();

      // Refetch all stores — covers "server started late" and "server restarted"
      useFeatureStore.getState().fetchSkills();
      useFeatureStore.getState().fetchTools();
      useFeatureStore.getState().fetchCredentials();
      useFeatureStore.getState().fetchSchedules();
      useConfigStore.getState().fetchPersona();

      // Begin liveness heartbeat — server evicts at 60s of silence.
      stopHeartbeat();
      heartbeatTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "heartbeat", data: {} }));
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as GatewayServerEvent;
        useAppStore.getState().handleServerEvent(event);
      } catch (err) {
        console.error("[ws] parse error:", err);
      }
    };

    ws.onclose = () => {
      console.log("[ws] disconnected");
      stopHeartbeat();
      if (intentionalCloseRef.current) return;
      useAppStore.getState().setConnected(false);
      if (attemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        useAppStore.getState().setReconnecting(false);
        console.error("[ws] max reconnect attempts reached");
        return;
      }
      useAppStore.getState().setReconnecting(true);
      const delay = Math.min(1000 * 2 ** attemptRef.current, MAX_RECONNECT_DELAY);
      attemptRef.current++;
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = (err) => {
      console.error("[ws] error:", err);
    };
  }, [stopHeartbeat]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      stopHeartbeat();
      intentionalCloseRef.current = true;
      wsRef.current?.close();
    };
  }, [connect, stopHeartbeat]);

  const send = useCallback((event: GatewayClientEvent) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
  }, []);

  const sendChat = useCallback(
    (text: string, inputModality?: "voice", media?: MediaArtifact[], messageId?: string) => {
      const workspaceId = "default-constellation";
      send({ type: "chat.send", data: { text, workspaceId, inputModality, ...(media?.length ? { media } : {}), ...(messageId ? { messageId } : {}) } });
    },
    [send]
  );

  const stopGeneration = useCallback(() => {
    send({ type: "chat.stop", data: {} });
  }, [send]);

  const reinitSession = useCallback(
    (newSessionId: string) => {
      send({ type: "session.init", data: { sessionId: newSessionId } });
    },
    [send]
  );

  useEffect(() => {
    useAppStore.getState().setReinitSession(reinitSession);
  }, [reinitSession]);

  useEffect(() => {
    useAppStore.getState().setSend(send);
    useAppStore.getState().setSendChat(sendChat);
    useAppStore.getState().setStopGeneration(stopGeneration);
  }, [send, sendChat, stopGeneration]);

  return { send, sendChat, stopGeneration };
}
