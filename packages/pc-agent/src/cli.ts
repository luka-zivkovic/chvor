#!/usr/bin/env node

import WebSocket from "ws";
import { hostname, platform, type } from "node:os";
import { captureScreen, getScreenSize, executeAction, executeShellCommand, queryA11yTree } from "./lib/index.ts";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const serverUrlArg = args.find((a) => a.startsWith("--server="))?.split("=")[1]
  ?? args[args.indexOf("--server") + 1]
  ?? "ws://localhost:3001/ws/pc-agent";

const tokenArg = args.find((a) => a.startsWith("--token="))?.split("=")[1]
  ?? args[args.indexOf("--token") + 1]
  ?? process.env.CHVOR_PC_AGENT_TOKEN
  ?? process.env.CHVOR_TOKEN
  ?? undefined;

const serverUrl = tokenArg
  ? `${serverUrlArg}${serverUrlArg.includes("?") ? "&" : "?"}token=${tokenArg}`
  : serverUrlArg;

console.log(`[pc-agent] connecting to ${serverUrlArg}...`);

// ---------------------------------------------------------------------------
// Types (mirroring @chvor/shared PcServerMessage / PcAgentMessage)
// ---------------------------------------------------------------------------

interface ServerActionMsg { type: "action"; id: string; action: { action: string; coordinate?: [number, number]; text?: string; keys?: string; direction?: string; amount?: number; duration?: number } }
interface ServerScreenshotMsg { type: "screenshot"; id: string }
interface ServerShellMsg { type: "shell"; id: string; command: string; cwd?: string }
interface ServerA11yTreeMsg { type: "a11y_tree"; id: string; maxDepth?: number }
interface ServerPingMsg { type: "ping" }

type ServerMessage = ServerActionMsg | ServerScreenshotMsg | ServerShellMsg | ServerA11yTreeMsg | ServerPingMsg;

// ---------------------------------------------------------------------------
// WebSocket connection with auto-reconnect
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const RECONNECT_BASE_DELAY = 3000;
const RECONNECT_MAX_DELAY = 60_000;
let reconnectAttempts = 0;

function send(msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function connect(): void {
  ws = new WebSocket(serverUrl);

  ws.on("open", async () => {
    reconnectAttempts = 0;
    console.log("[pc-agent] connected to Chvor server");
    const { width, height } = await getScreenSize();
    send({
      type: "hello",
      hostname: hostname(),
      os: `${type()} ${platform()}`,
      screenWidth: width,
      screenHeight: height,
    });
  });

  ws.on("message", async (raw) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(raw)) as ServerMessage;
    } catch (err) {
      console.warn("[pc-agent] failed to parse server message:", (err as Error).message);
      return;
    }

    switch (msg.type) {
      case "ping":
        send({ type: "pong" });
        break;

      case "screenshot": {
        try {
          const screenshot = await captureScreen({ format: "jpeg", quality: 80 });
          send({
            type: "screenshot",
            id: msg.id,
            data: screenshot.data,
            width: screenshot.width,
            height: screenshot.height,
            mimeType: screenshot.mimeType,
          });
        } catch (err) {
          console.error("[pc-agent] screenshot failed:", err);
          send({
            type: "action.result",
            id: msg.id,
            success: false,
            error: (err as Error).message,
          });
        }
        break;
      }

      case "action": {
        try {
          await executeAction(msg.action);
          send({ type: "action.result", id: msg.id, success: true });
        } catch (err) {
          console.error("[pc-agent] action failed:", err);
          send({
            type: "action.result",
            id: msg.id,
            success: false,
            error: (err as Error).message,
          });
        }
        break;
      }

      case "shell": {
        try {
          const result = await executeShellCommand(msg.command, msg.cwd);
          send({ type: "shell.result", id: msg.id, ...result });
        } catch (err) {
          send({
            type: "shell.result",
            id: msg.id,
            stdout: "",
            stderr: (err as Error).message,
            exitCode: 1,
          });
        }
        break;
      }

      case "a11y_tree": {
        try {
          const tree = await queryA11yTree({ maxDepth: msg.maxDepth });
          send({ type: "a11y_tree", id: msg.id, tree });
        } catch (err) {
          console.error("[pc-agent] a11y_tree failed:", err);
          send({ type: "a11y_tree", id: msg.id, tree: null });
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    console.log("[pc-agent] disconnected, reconnecting...");
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error("[pc-agent] WebSocket error:", err.message);
    ws?.close();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_DELAY * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY);
  reconnectAttempts++;
  console.log(`[pc-agent] reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("[pc-agent] shutting down...");
  ws?.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[pc-agent] shutting down...");
  ws?.close();
  process.exit(0);
});

connect();
