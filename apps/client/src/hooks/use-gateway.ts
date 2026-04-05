import { useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../stores/app-store";
import { useSkillStore } from "../stores/skill-store";
import { useToolStore } from "../stores/tool-store";
import { useCredentialStore } from "../stores/credential-store";
import { useScheduleStore } from "../stores/schedule-store";
import { usePersonaStore } from "../stores/persona-store";
import { useEmotionStore } from "../stores/emotion-store";
import type { GatewayClientEvent, GatewayServerEvent, MediaArtifact } from "@chvor/shared";
import { SESSION_ID_KEY } from "../lib/constants";
import { trackEvent } from "../lib/analytics";

const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY = 30_000;

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
  const attemptRef = useRef(0);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Cookies are sent automatically for same-origin WebSocket connections
    const url = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    let closed = false;

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
      useEmotionStore.getState().loadSessionHistory(sessionId);

      // Load conversations list
      useAppStore.getState().loadConversations();

      // Refetch all stores — covers "server started late" and "server restarted"
      useSkillStore.getState().fetchSkills();
      useToolStore.getState().fetchTools();
      useCredentialStore.getState().fetchAll();
      useScheduleStore.getState().fetchAll();
      usePersonaStore.getState().fetchPersona();
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
      if (closed) return;
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

    (ws as any)._intentionalClose = () => {
      closed = true;
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      const ws = wsRef.current;
      if (ws) {
        if ((ws as any)._intentionalClose) {
          (ws as any)._intentionalClose();
        } else {
          ws.close();
        }
      }
    };
  }, [connect]);

  const send = useCallback((event: GatewayClientEvent) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
  }, []);

  const sendChat = useCallback(
    (text: string, inputModality?: "voice", media?: MediaArtifact[]) => {
      const workspaceId = "default-constellation";
      send({ type: "chat.send", data: { text, workspaceId, inputModality, ...(media?.length ? { media } : {}) } });
      trackEvent("message_sent");
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
