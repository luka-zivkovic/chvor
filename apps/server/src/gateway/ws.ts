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
  "credential.respond",
  "credential.choice.respond",
  "synthesized.respond",
  "oauth.synthesized.respond",
  "canvas.subscribe",
  "heartbeat",
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
      return (
        typeof d.text === "string" &&
        typeof d.workspaceId === "string" &&
        (!d.messageId || (typeof d.messageId === "string" && UUID_RE.test(d.messageId)))
      );
    case "chat.stop":
      return true;
    case "command.respond":
      return typeof d.requestId === "string" && typeof d.approved === "boolean";
    case "approval.respond":
      // Phase D4 — HITL approvals: { approvalId, decision }.
      return (
        typeof d.approvalId === "string" &&
        (d.decision === "allow-once" || d.decision === "allow-session" || d.decision === "deny")
      );
    case "credential.respond":
      return typeof d.requestId === "string" && typeof d.cancelled === "boolean";
    case "credential.choice.respond":
      return (
        typeof d.requestId === "string" &&
        (d.action === "use-once" || d.action === "pin-session" || d.action === "cancel") &&
        (d.action === "cancel" || typeof d.credentialId === "string")
      );
    case "synthesized.respond":
      return (
        typeof d.requestId === "string" &&
        (d.decision === "allow-once" || d.decision === "allow-session" || d.decision === "deny")
      );
    case "oauth.synthesized.respond":
      return typeof d.requestId === "string" && typeof d.cancelled === "boolean";
    case "canvas.subscribe":
      return typeof d.workspaceId === "string";
    case "heartbeat":
      return true;
    default:
      return false;
  }
}

// Server pings every HEARTBEAT_INTERVAL_MS. A client is considered stale if it
// hasn't sent ANY message (heartbeat or otherwise) within STALE_TIMEOUT_MS, and
// its socket is closed so it can reconnect cleanly. Mobile/sleep half-open
// sockets are the primary motivation: TCP keepalive can take 2 hours to notice.
const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_TIMEOUT_MS = 60_000;

export class WSManager {
  private clients = new Map<string, WSContext>();
  private lastSeen = new Map<string, number>();
  private messageHandler: ClientMessageHandler | null = null;
  private counter = 0;
  /** Maps WS clientId (ws-N) → persistent sessionId (UUID) */
  private sessionMap = new Map<string, string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  onClientMessage(handler: ClientMessageHandler): void {
    this.messageHandler = handler;
  }

  handleConnection(ws: WSContext): string {
    const clientId = `ws-${++this.counter}`;
    this.clients.set(clientId, ws);
    this.lastSeen.set(clientId, Date.now());
    this.startHeartbeat();
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
    // Any message updates lastSeen — the explicit "heartbeat" event is just
    // the lowest-cost ping the client can send.
    this.lastSeen.set(clientId, Date.now());
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
      // Heartbeats are pure liveness signals — don't dispatch to handlers.
      if (event.type === "heartbeat") return;
      this.messageHandler?.(clientId, event);
    } catch (err) {
      console.error(`[ws] invalid message from ${clientId}:`, err);
    }
  }

  handleClose(clientId: string): void {
    this.clients.delete(clientId);
    this.sessionMap.delete(clientId);
    this.lastSeen.delete(clientId);
    console.log(`[ws] client disconnected: ${clientId} (total: ${this.clients.size})`);
    if (this.clients.size === 0) this.stopHeartbeat();
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

  /** Send a server→client heartbeat to every connected client and evict any
   *  client whose lastSeen is older than the stale threshold. Idempotent.
   */
  private heartbeatTick(): void {
    const now = Date.now();
    const ping = JSON.stringify({ type: "heartbeat", data: {} });
    for (const [id, client] of this.clients) {
      const seen = this.lastSeen.get(id) ?? now;
      if (now - seen > STALE_TIMEOUT_MS) {
        console.warn(`[ws] evicting stale client ${id} (idle ${now - seen}ms)`);
        try {
          client.close(1001, "stale connection");
        } catch {
          /* ignore */
        }
        this.handleClose(id);
        continue;
      }
      try {
        client.send(ping);
      } catch {
        this.handleClose(id);
      }
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), HEARTBEAT_INTERVAL_MS);
    // Don't keep the process alive just for heartbeats.
    if (
      typeof this.heartbeatTimer === "object" &&
      this.heartbeatTimer &&
      "unref" in this.heartbeatTimer
    ) {
      (this.heartbeatTimer as NodeJS.Timeout).unref?.();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Stop the heartbeat loop — called during graceful shutdown. */
  shutdown(): void {
    this.stopHeartbeat();
  }

  /**
   * Close every active client with a clean WS close frame so browsers don't
   * treat the disconnect as an error. Used during graceful shutdown.
   */
  closeAll(code: number = 1001, reason: string = "server shutting down"): void {
    for (const [id, client] of this.clients) {
      try {
        client.close(code, reason);
      } catch {
        /* ignore */
      }
      this.clients.delete(id);
      this.sessionMap.delete(id);
      this.lastSeen.delete(id);
    }
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
