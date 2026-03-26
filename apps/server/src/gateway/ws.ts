import type { WSContext } from "hono/ws";
import type { GatewayServerEvent, GatewayClientEvent } from "@chvor/shared";

export type ClientMessageHandler = (clientId: string, event: GatewayClientEvent) => void;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      const event = JSON.parse(data) as GatewayClientEvent;
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
