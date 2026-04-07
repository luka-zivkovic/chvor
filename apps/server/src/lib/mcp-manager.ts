import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@chvor/shared";
import { logError } from "./error-logger.ts";
import { resolveEnvPlaceholders, resolveUrlPlaceholders } from "./credential-resolver.ts";
import { loadTools } from "./capability-loader.ts";

// Read version from package.json once at module load
const __dirname = dirname(fileURLToPath(import.meta.url));
let APP_VERSION = "0.0.1";
try {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8"));
  APP_VERSION = pkg.version ?? APP_VERSION;
} catch { /* fallback to default */ }

// Timeouts (ms) — prevents hung MCP servers from blocking the platform
const SPAWN_TIMEOUT_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Race a promise against a timeout. Throws on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  tools: McpToolInfo[];
  toolId: string;
  tool: Tool; // stored for auto-reconnect on failure
}

class McpManager {
  private connections: Map<string, McpConnection>;
  private spawning: Map<string, Promise<McpConnection>>;

  constructor() {
    this.connections = new Map();
    this.spawning = new Map();
  }

  /**
   * Get or spawn an MCP server for a tool. Lazy: first call spawns, subsequent reuse.
   * Concurrent calls for the same tool are deduplicated.
   */
  async getConnection(tool: Tool): Promise<McpConnection> {
    const existing = this.connections.get(tool.id);
    if (existing) return existing;

    // Dedup: return in-flight spawn promise if one exists
    const inflight = this.spawning.get(tool.id);
    if (inflight) return inflight;

    const promise = this.spawnConnection(tool);
    this.spawning.set(tool.id, promise);
    try {
      return await promise;
    } catch (err) {
      logError("mcp_crash", err, { toolId: tool.id, command: tool.mcpServer?.command });
      throw err;
    } finally {
      this.spawning.delete(tool.id);
    }
  }

  private async spawnConnection(tool: Tool): Promise<McpConnection> {
    if (!tool.mcpServer) {
      throw new Error(`Tool ${tool.id} has no MCP server config`);
    }

    const transportType = tool.mcpServer.transport ?? "stdio";
    let transport: StdioClientTransport | SSEClientTransport;

    if (transportType === "sse" || transportType === "http") {
      // Remote transport — resolve URL placeholders for API key embedding
      if (!tool.mcpServer.url) {
        throw new Error(`Tool ${tool.id} has transport "${transportType}" but no url`);
      }
      const resolvedUrl = resolveUrlPlaceholders(
        tool.mcpServer.url,
        tool.metadata.requires?.credentials
      );
      transport = new SSEClientTransport(new URL(resolvedUrl));
    } else {
      // Stdio transport — spawn local process
      if (!tool.mcpServer.command) {
        throw new Error(`Tool ${tool.id} has stdio transport but no command`);
      }

      const resolvedEnv = resolveEnvPlaceholders(
        tool.mcpServer.env,
        tool.metadata.requires?.credentials
      );

      // On Windows, npx needs to be npx.cmd
      const command =
        process.platform === "win32" && tool.mcpServer.command === "npx"
          ? "npx.cmd"
          : tool.mcpServer.command;

      // Resolve placeholders in args
      const resolvedArgs = (tool.mcpServer.args ?? [])
        .map((arg) =>
          arg
            .replace(/\{\{homedir\}\}/g, homedir())
            .replace(/\{\{cwd\}\}/g, process.cwd())
            .replace(/\{\{tmp\}\}/g, process.platform === "win32" ? (process.env.TEMP ?? process.env.TMP ?? homedir()) : "/tmp")
        )
        .filter((arg) => arg.length > 0);

      transport = new StdioClientTransport({
        command,
        args: resolvedArgs,
        env: { ...process.env, ...resolvedEnv } as Record<string, string>,
      });
    }

    const client = new Client({
      name: "chvor",
      version: APP_VERSION,
    });

    await withTimeout(client.connect(transport), SPAWN_TIMEOUT_MS, `MCP spawn for ${tool.id}`);

    // Discover tools from the MCP server
    const toolsResult = await withTimeout(client.listTools(), DISCOVERY_TIMEOUT_MS, `MCP listTools for ${tool.id}`);
    const tools: McpToolInfo[] = (toolsResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));

    const connection: McpConnection = {
      client,
      transport,
      tools,
      toolId: tool.id,
      tool,
    };

    this.connections.set(tool.id, connection);
    console.log(
      `[mcp] spawned server for tool: ${tool.id} (${tools.length} tools)`
    );
    return connection;
  }

  /**
   * Call a tool on an MCP server.
   * On failure, attempts to close the stale connection, respawn, and retry once.
   * Has a per-call timeout to prevent hung tool calls from blocking the orchestrator.
   */
  async callTool(
    toolId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const conn = this.connections.get(toolId);
    if (!conn) throw new Error(`No MCP connection for tool: ${toolId}`);

    try {
      return await withTimeout(
        conn.client.callTool({ name: toolName, arguments: args }),
        CALL_TIMEOUT_MS,
        `MCP callTool ${toolId}/${toolName}`,
      );
    } catch (firstErr) {
      console.warn(`[mcp] callTool failed for ${toolId}/${toolName}, attempting reconnect…`);
      const toolRef = conn.tool;
      await this.closeConnection(toolId);
      await this.getConnection(toolRef);
      const newConn = this.connections.get(toolId);
      if (!newConn) throw firstErr;
      return await withTimeout(
        newConn.client.callTool({ name: toolName, arguments: args }),
        CALL_TIMEOUT_MS,
        `MCP callTool retry ${toolId}/${toolName}`,
      );
    }
  }

  /**
   * Discover tools from a tool's MCP server (spawns if not cached).
   */
  async discoverTools(tool: Tool): Promise<McpToolInfo[]> {
    const conn = await this.getConnection(tool);
    return conn.tools;
  }

  /**
   * Parse a qualified tool name (toolId__toolName) back to its parts.
   * Falls back to searching all connections if no prefix — logs a warning
   * if multiple connections expose the same tool name (ambiguous match).
   */
  findToolForQualifiedName(
    qualifiedToolName: string
  ): { toolId: string; toolName: string } | null {
    const sepIndex = qualifiedToolName.indexOf("__");
    if (sepIndex !== -1) {
      return {
        toolId: qualifiedToolName.slice(0, sepIndex),
        toolName: qualifiedToolName.slice(sepIndex + 2),
      };
    }
    // No prefix — search all connections (warn on ambiguity)
    const matches: Array<{ toolId: string; toolName: string }> = [];
    for (const conn of this.connections.values()) {
      if (conn.tools.some((t) => t.name === qualifiedToolName)) {
        matches.push({ toolId: conn.toolId, toolName: qualifiedToolName });
      }
    }
    if (matches.length > 1) {
      console.warn(`[mcp] ambiguous tool name "${qualifiedToolName}" found in ${matches.length} connections: ${matches.map((m) => m.toolId).join(", ")}. Using first match. Prefer qualified names (toolId__toolName).`);
    }
    return matches[0] ?? null;
  }

  /**
   * Get status of all active MCP connections (for diagnosis tool).
   * Probes each connection with a lightweight listTools call to detect stale transports.
   */
  async getConnectionStatus(): Promise<Array<{ toolId: string; connected: boolean; toolCount: number }>> {
    const result: Array<{ toolId: string; connected: boolean; toolCount: number }> = [];
    // Snapshot entries to avoid issues if connections mutate during async probes
    const entries = [...this.connections.entries()];
    for (const [id, conn] of entries) {
      let connected = false;
      try {
        await withTimeout(conn.client.listTools(), HEALTH_CHECK_TIMEOUT_MS, `health check ${id}`);
        connected = true;
      } catch {
        console.warn(`[mcp] health check failed for ${id} — marking as disconnected`);
      }
      result.push({ toolId: id, connected, toolCount: conn.tools.length });
    }
    return result;
  }

  /**
   * Close a specific MCP connection (for repair tool). Re-spawns lazily on next use.
   */
  async closeConnection(toolId: string): Promise<boolean> {
    const conn = this.connections.get(toolId);
    if (!conn) return false;
    try {
      await conn.client.close();
      console.log(`[mcp] closed connection for repair: ${toolId}`);
    } catch (err) {
      console.error(`[mcp] error closing ${toolId}:`, err);
    }
    this.connections.delete(toolId);
    return true;
  }

  /**
   * Close MCP connections for all tools that depend on a given credential type.
   * They will re-spawn lazily with fresh credentials on next use.
   */
  async closeConnectionsForCredential(credType: string): Promise<void> {
    const allTools = loadTools();
    for (const t of allTools) {
      if (t.metadata.requires?.credentials?.includes(credType) && this.connections.has(t.id)) {
        await this.closeConnection(t.id);
        console.log(`[mcp] closed connection for credential change: ${t.id} (${credType})`);
      }
    }
  }

  /**
   * Shutdown all MCP server connections.
   */
  async shutdown(): Promise<void> {
    for (const [id, conn] of this.connections) {
      try {
        await conn.client.close();
        console.log(`[mcp] closed connection: ${id}`);
      } catch (err) {
        console.error(`[mcp] error closing ${id}:`, err);
      }
    }
    this.connections.clear();
  }
}

export const mcpManager = new McpManager();
