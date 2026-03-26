import { randomUUID } from "node:crypto";
import { hostname as osHostname, platform as osPlatform, type as osType } from "node:os";
import type { PcAgentInfo, PcScreenshot, PcAction, PcActionResult, PcAgentMessage, PcServerMessage, A11yTree } from "@chvor/shared";
import type { PcSafetyLevel } from "@chvor/shared";
import type { WSContext } from "hono/ws";
import { getConfig } from "../db/config-store.ts";
import type { PcBackend } from "./pc-backend.ts";

// ---------------------------------------------------------------------------
// Connected agents registry
// ---------------------------------------------------------------------------

interface ConnectedAgent {
  id: string;
  ws: WSContext;
  info: PcAgentInfo;
  /** Whether agent has sent the "hello" handshake */
  identified: boolean;
  /** Latest cached screenshot */
  lastScreenshot: PcScreenshot | null;
  /** Timestamp of last pong received */
  lastPong: number;
  /** Pending request callbacks keyed by request ID */
  pending: Map<string, {
    resolve: (value: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

const agents = new Map<string, ConnectedAgent>();

// Callbacks for external listeners (e.g. WS broadcast to UI)
type AgentEventHandler = (event: "connected" | "disconnected", agent: PcAgentInfo) => void;
type FrameHandler = (agentId: string, screenshot: PcScreenshot) => void;
let onAgentEvent: AgentEventHandler | null = null;
let onFrame: FrameHandler | null = null;

export function onPcAgentEvent(handler: AgentEventHandler): void {
  onAgentEvent = handler;
}

export function onPcFrame(handler: FrameHandler): void {
  onFrame = handler;
}

// ---------------------------------------------------------------------------
// Ping/keepalive
// ---------------------------------------------------------------------------

const PING_INTERVAL = 15_000;
const PONG_TIMEOUT = 30_000; // disconnect after 2 missed pongs
const HELLO_TIMEOUT = 10_000; // agent must identify within 10s
const pingTimers = new Map<string, ReturnType<typeof setInterval>>();
const helloTimers = new Map<string, ReturnType<typeof setTimeout>>();

function startPing(agentId: string): void {
  const timer = setInterval(() => {
    const agent = agents.get(agentId);
    if (!agent) return;
    // Check for dead connection (no pong in PONG_TIMEOUT)
    if (Date.now() - agent.lastPong > PONG_TIMEOUT) {
      console.warn(`[pc-control] agent ${agentId} not responding, disconnecting`);
      try { agent.ws.close(); } catch { /* already closed */ }
      handlePcAgentClose(agentId);
      return;
    }
    safeSend(agent.ws, { type: "ping" });
  }, PING_INTERVAL);
  pingTimers.set(agentId, timer);
}

function stopPing(agentId: string): void {
  const timer = pingTimers.get(agentId);
  if (timer) {
    clearInterval(timer);
    pingTimers.delete(agentId);
  }
}

function startHelloTimeout(agentId: string): void {
  const timer = setTimeout(() => {
    const agent = agents.get(agentId);
    if (agent && !agent.identified) {
      console.warn(`[pc-control] agent ${agentId} did not send hello, disconnecting`);
      try { agent.ws.close(); } catch { /* already closed */ }
      handlePcAgentClose(agentId);
    }
    helloTimers.delete(agentId);
  }, HELLO_TIMEOUT);
  helloTimers.set(agentId, timer);
}

function stopHelloTimeout(agentId: string): void {
  const timer = helloTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    helloTimers.delete(agentId);
  }
}

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------

function safeSend(ws: WSContext, msg: PcServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may have dropped
  }
}

export function handlePcAgentConnection(ws: WSContext): string {
  const agentId = randomUUID();
  const agent: ConnectedAgent = {
    id: agentId,
    ws,
    info: {
      id: agentId,
      hostname: "unknown",
      os: "unknown",
      screenWidth: 1920,
      screenHeight: 1080,
      connectedAt: new Date().toISOString(),
      status: "connected",
    },
    identified: false,
    lastScreenshot: null,
    lastPong: Date.now(),
    pending: new Map(),
  };
  agents.set(agentId, agent);
  startPing(agentId);
  startHelloTimeout(agentId);
  console.log(`[pc-control] agent connected: ${agentId}`);
  return agentId;
}

export function handlePcAgentMessage(agentId: string, data: string): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  let msg: PcAgentMessage;
  try {
    msg = JSON.parse(data) as PcAgentMessage;
  } catch {
    console.warn(`[pc-control] invalid JSON from agent ${agentId}`);
    return;
  }

  switch (msg.type) {
    case "hello": {
      // Validate agent metadata
      const hostname = String(msg.hostname ?? "").slice(0, 255);
      const os = String(msg.os ?? "").slice(0, 100);
      const screenWidth = Math.max(1, Math.min(10000, Number(msg.screenWidth) || 1920));
      const screenHeight = Math.max(1, Math.min(10000, Number(msg.screenHeight) || 1080));

      if (!hostname || !/^[\w.\-() ]{1,255}$/.test(hostname)) {
        console.warn(`[pc-control] agent ${agentId} sent invalid hostname, disconnecting`);
        try { agent.ws.close(4003, "Invalid hostname"); } catch { /* */ }
        handlePcAgentClose(agentId);
        return;
      }

      agent.identified = true;
      stopHelloTimeout(agentId);
      agent.info.hostname = hostname;
      agent.info.os = os;
      agent.info.screenWidth = screenWidth;
      agent.info.screenHeight = screenHeight;
      console.log(`[pc-control] agent identified: ${hostname} (${os}, ${screenWidth}x${screenHeight})`);
      onAgentEvent?.("connected", agent.info);
      break;
    }

    case "screenshot": {
      // Reject oversized screenshots (max ~2MB base64)
      if (msg.data.length > 2_800_000) {
        console.warn(`[pc-control] screenshot from ${agentId} too large (${msg.data.length} chars), dropping`);
        resolvePending(agent, msg.id, { success: false, error: "Screenshot too large" });
        break;
      }
      // Reject invalid dimensions
      if (msg.width > 10000 || msg.height > 10000 || msg.width <= 0 || msg.height <= 0) {
        console.warn(`[pc-control] screenshot from ${agentId} has invalid dimensions: ${msg.width}x${msg.height}`);
        resolvePending(agent, msg.id, { success: false, error: "Invalid screenshot dimensions" });
        break;
      }
      const screenshot: PcScreenshot = {
        data: msg.data,
        width: msg.width,
        height: msg.height,
        timestamp: new Date().toISOString(),
      };
      agent.lastScreenshot = screenshot;
      onFrame?.(agentId, screenshot);
      resolvePending(agent, msg.id, screenshot);
      break;
    }

    case "action.result": {
      resolvePending(agent, msg.id, { success: msg.success, error: msg.error });
      break;
    }

    case "shell.result": {
      resolvePending(agent, msg.id, {
        stdout: msg.stdout,
        stderr: msg.stderr,
        exitCode: msg.exitCode,
      });
      break;
    }

    case "a11y_tree": {
      resolvePending(agent, msg.id, msg.tree);
      break;
    }

    case "pong":
      agent.lastPong = Date.now();
      break;
  }
}

export function handlePcAgentClose(agentId: string): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  stopPing(agentId);
  stopHelloTimeout(agentId);

  // Reject all pending requests
  for (const [, pending] of agent.pending) {
    clearTimeout(pending.timer);
    pending.resolve({ success: false, error: "Agent disconnected" });
  }
  agent.pending.clear();

  agent.info.status = "disconnected";
  onAgentEvent?.("disconnected", agent.info);
  agents.delete(agentId);
  console.log(`[pc-control] agent disconnected: ${agentId}`);
}

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT = 30_000;

function resolvePending(agent: ConnectedAgent, id: string, value: unknown): void {
  const pending = agent.pending.get(id);
  if (pending) {
    clearTimeout(pending.timer);
    agent.pending.delete(id);
    pending.resolve(value);
  }
}

const MAX_PENDING_PER_AGENT = 100;

function sendRequest(agent: ConnectedAgent, msg: PcServerMessage & { id: string }): Promise<unknown> {
  if (agent.pending.size >= MAX_PENDING_PER_AGENT) {
    return Promise.resolve({ success: false, error: "Too many pending requests" });
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      agent.pending.delete(msg.id);
      resolve({ success: false, error: "Request timed out" });
    }, REQUEST_TIMEOUT);

    agent.pending.set(msg.id, { resolve, timer });
    safeSend(agent.ws, msg);
  });
}

// ---------------------------------------------------------------------------
// Public API (called by native tools / routes)
// ---------------------------------------------------------------------------

export function listConnectedAgents(): PcAgentInfo[] {
  return Array.from(agents.values()).map((a) => a.info);
}

export function getAgent(agentId: string): PcAgentInfo | null {
  return agents.get(agentId)?.info ?? null;
}

export async function takeScreenshot(agentId: string): Promise<PcScreenshot> {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`No agent with ID: ${agentId}`);

  const requestId = randomUUID();
  const result = await sendRequest(agent, { type: "screenshot", id: requestId });
  return result as PcScreenshot;
}

export async function executeAction(agentId: string, action: PcAction): Promise<PcActionResult> {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`No agent with ID: ${agentId}`);

  const requestId = randomUUID();
  const result = await sendRequest(agent, {
    type: "action",
    id: requestId,
    action,
  });
  return result as PcActionResult;
}

export async function executeShell(agentId: string, command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`No agent with ID: ${agentId}`);

  const requestId = randomUUID();
  const result = await sendRequest(agent, {
    type: "shell",
    id: requestId,
    command,
    cwd,
  });
  return result as { stdout: string; stderr: string; exitCode: number };
}

export function getLastScreenshot(agentId: string): PcScreenshot | null {
  return agents.get(agentId)?.lastScreenshot ?? null;
}

export function disconnectAgent(agentId: string): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  try {
    agent.ws.close();
  } catch {
    // Already closed
  }
  handlePcAgentClose(agentId);
  return true;
}

export function hasConnectedAgents(): boolean {
  return agents.size > 0;
}

/** Query accessibility tree from a remote agent */
export async function queryRemoteA11yTree(agentId: string, opts?: { maxDepth?: number }): Promise<A11yTree | null> {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`No agent with ID: ${agentId}`);

  const requestId = randomUUID();
  const result = await sendRequest(agent, {
    type: "a11y_tree",
    id: requestId,
    maxDepth: opts?.maxDepth,
  });
  return result as A11yTree | null;
}

/** Get the configured safety level for PC control */
export function getPcSafetyLevel(): PcSafetyLevel {
  return (getConfig("pc_safety_level") as PcSafetyLevel) ?? "supervised";
}

/** Shutdown all agents — called on server shutdown */
export function shutdownPcAgents(): void {
  for (const [id] of agents) {
    disconnectAgent(id);
  }
}

// ---------------------------------------------------------------------------
// RemoteBackend — wraps a connected WebSocket agent
// ---------------------------------------------------------------------------

export class RemoteBackend implements PcBackend {
  readonly mode = "remote" as const;
  readonly id: string;
  readonly hostname: string;
  readonly os: string;
  readonly screenSize: { width: number; height: number };

  constructor(agentId: string) {
    const agent = agents.get(agentId);
    if (!agent) throw new Error(`No remote agent with ID: ${agentId}`);
    this.id = agentId;
    this.hostname = agent.info.hostname;
    this.os = agent.info.os;
    this.screenSize = { width: agent.info.screenWidth, height: agent.info.screenHeight };
  }

  async captureScreen(): Promise<PcScreenshot> {
    return takeScreenshot(this.id);
  }

  async executeAction(action: PcAction): Promise<PcActionResult> {
    return executeAction(this.id, action);
  }

  async executeShell(command: string, cwd?: string) {
    return executeShell(this.id, command, cwd);
  }

  async queryA11yTree(opts?: { maxDepth?: number }): Promise<A11yTree | null> {
    return queryRemoteA11yTree(this.id, opts);
  }
}

// ---------------------------------------------------------------------------
// LocalBackend — direct access to pc-agent library on the server machine
// ---------------------------------------------------------------------------

let _localBackend: LocalBackend | null = null;
let _localChecked = false;

class LocalBackend implements PcBackend {
  readonly mode = "local" as const;
  readonly id = "local";
  readonly hostname: string;
  readonly os: string;
  readonly screenSize: { width: number; height: number };

  private lib: typeof import("@chvor/pc-agent");

  constructor(lib: typeof import("@chvor/pc-agent"), screenSize: { width: number; height: number }) {
    this.lib = lib;
    this.hostname = osHostname();
    this.os = `${osType()} ${osPlatform()}`;
    this.screenSize = screenSize;
  }

  async captureScreen(): Promise<PcScreenshot> {
    const result = await this.lib.captureScreen({ format: "jpeg", quality: 80 });
    return {
      data: result.data,
      width: result.width,
      height: result.height,
      timestamp: new Date().toISOString(),
      mimeType: result.mimeType,
    };
  }

  async executeAction(action: PcAction): Promise<PcActionResult> {
    try {
      await this.lib.executeAction(action);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async executeShell(command: string, cwd?: string) {
    return this.lib.executeShellCommand(command, cwd);
  }

  async queryA11yTree(opts?: { maxDepth?: number }): Promise<A11yTree | null> {
    return this.lib.queryA11yTree(opts);
  }
}

/** Check if the local backend is available (pc-agent lib importable + display accessible) */
export async function initLocalBackend(): Promise<boolean> {
  if (_localChecked) return _localBackend !== null;
  _localChecked = true;

  try {
    const lib = await import("@chvor/pc-agent");
    const screenSize = await lib.getScreenSize();
    _localBackend = new LocalBackend(lib, screenSize);
    console.log(`[pc-control] local backend available: ${_localBackend.hostname} (${_localBackend.os}, ${screenSize.width}x${screenSize.height})`);
    return true;
  } catch (err) {
    console.log(`[pc-control] local backend not available: ${(err as Error).message}`);
    _localBackend = null;
    return false;
  }
}

export function localBackendAvailable(): boolean {
  return _localBackend !== null;
}

export function getLocalBackend(): LocalBackend | null {
  return _localBackend;
}

/**
 * Get the appropriate backend for a target.
 * - targetId "local" → local backend
 * - targetId undefined → local if available, else first remote agent
 * - targetId is UUID → specific remote agent
 */
export function getBackend(targetId?: string): PcBackend {
  if (targetId === "local") {
    if (!_localBackend) throw new Error("Local PC control is not available");
    return _localBackend;
  }

  if (targetId) {
    // Specific remote agent
    return new RemoteBackend(targetId);
  }

  // Auto: prefer local, fall back to first remote
  if (_localBackend) return _localBackend;

  const firstAgent = agents.values().next().value;
  if (firstAgent) return new RemoteBackend(firstAgent.id);

  throw new Error("No PC backend available. Enable local mode or connect a remote agent.");
}
