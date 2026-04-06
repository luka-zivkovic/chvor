import type { WSContext } from "hono/ws";
import type { GatewayServerEvent, GatewayClientEvent } from "@chvor/shared";

export type ClientMessageHandler = (clientId: string, event: GatewayClientEvent) => void;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_CLIENT_EVENT_TYPES = new Set([
  "session.init",
  "chat.send",
  "chat.stop",
  "approval.respond",
  "command.respond",
  "canvas.subscribe",
]);

/** Runtime validation — ensures the event has a known type and correct data shape. */
function isValidClientEvent(event: unknown): event is GatewayClientEvent {
  if (!event || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  if (typeof e.type !== "string" || !VALID_CLIENT_EVENT_TYPES.has(e.type)) return false;
  if (!e.data || typeof e.data !== "object") return false;
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case "session.init":
      return typeof d.sessionId === "string";
    case "chat.send":
      return typeof d.text === "string" && typeof d.workspaceId === "string"
        && (!d.messageId || (typeof d.messageId === "string" && UUID_RE.test(d.messageId)));
    case "chat.stop":
      return true;
    case "approval.respond":
    case "command.respond":
      return typeof d.requestId === "string" && typeof d.approved === "boolean";
    case "canvas.subscribe":
      return typeof d.workspaceId === "string";
    default:
      return false;
  }
}

export class WSManager {
  private clients = new Map<string, WSContext>();
  private messageHandler: ClientMessageHandler | null = null;
  private counter = 0;
  /** Maps WS clientId (ws-N) → persistent sessionId (UUID) */
  private sessionMap = new Map<string, string>();

  onClientMessage(handler: ClientMessageHandler): void {
    this.messageHandler = handler;
  }

  handleConnection(ws: WSContext): string {
    const clientId = `ws-${++this.counter}`;
    this.clients.set(clientId, ws);
    console.log(`[ws] client connected: ${clientId} (total: ${this.clients.size})`);
    return clientId;
  }

  /** Associate a persistent session ID with a WS client */
  setSessionId(clientId: string, sessionId: string): boolean {
    if (!UUID_RE.test(sessionId)) {
      console.warn(`[ws] rejected invalid sessionId from ${clientId}: ${sessionId}`);
      return false;
    }
    this.sessionMap.set(clientId, sessionId);
    console.log(`[ws] session mapped: ${clientId} → ${sessionId}`);
    return true;
  }

  /** Get persistent session ID for a WS client */
  getSessionId(clientId: string): string | null {
    return this.sessionMap.get(clientId) ?? null;
  }

  /** Get all WS client IDs sharing a persistent session */
  getClientsBySessionId(sessionId: string): string[] {
    const clients: string[] = [];
    for (const [clientId, sid] of this.sessionMap) {
      if (sid === sessionId && this.clients.has(clientId)) {
        clients.push(clientId);
      }
    }
    return clients;
  }

  handleMessage(clientId: string, data: string): void {
    if (data.length > 32_768) {
      console.warn(`[ws] message too large from ${clientId}: ${data.length} bytes`);
      return;
    }
    try {
      const event = JSON.parse(data);
      if (!isValidClientEvent(event)) {
        console.warn(`[ws] malformed event from ${clientId}:`, event?.type);
        return;
      }
      this.messageHandler?.(clientId, event);
    } catch (err) {
      console.error(`[ws] invalid message from ${clientId}:`, err);
    }
  }

  handleClose(clientId: string): void {
    this.clients.delete(clientId);
    this.sessionMap.delete(clientId);
    console.log(`[ws] client disconnected: ${clientId} (total: ${this.clients.size})`);
  }

  broadcast(event: GatewayServerEvent): void {
    const data = JSON.stringify(event);
    for (const [id, client] of this.clients) {
      try {
        client.send(data);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  sendTo(clientId: string, event: GatewayServerEvent): boolean {
    const client = this.clients.get(clientId);
    if (client) {
      client.send(JSON.stringify(event));
      return true;
    }
    return false;
  }

  /** Send event to all clients sharing a persistent session */
  broadcastToSession(sessionId: string, event: GatewayServerEvent): void {
    const clients = this.getClientsBySessionId(sessionId);
    const data = JSON.stringify(event);
    for (const clientId of clients) {
      const client = this.clients.get(clientId);
      if (client) {
        try {
          client.send(data);
        } catch {
          this.clients.delete(clientId);
        }
      }
    }
  }
}
