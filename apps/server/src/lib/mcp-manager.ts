import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { homedir } from "node:os";
import type { Tool } from "@chvor/shared";
import { logError } from "./error-logger.ts";
import { resolveEnvPlaceholders } from "./credential-resolver.ts";
import { loadTools } from "./capability-loader.ts";

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
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
    const resolvedArgs = tool.mcpServer.args
      .map((arg) =>
        arg
          .replace(/\{\{homedir\}\}/g, homedir())
          .replace(/\{\{cwd\}\}/g, process.cwd())
          .replace(/\{\{tmp\}\}/g, process.platform === "win32" ? (process.env.TEMP ?? process.env.TMP ?? homedir()) : "/tmp")
      )
      .filter((arg) => arg.length > 0);

    const transport = new StdioClientTransport({
      command,
      args: resolvedArgs,
      env: { ...process.env, ...resolvedEnv } as Record<string, string>,
    });

    const client = new Client({
      name: "chvor",
      version: "0.1.0",
    });

    await client.connect(transport);

    // Discover tools from the MCP server
    const toolsResult = await client.listTools();
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
   */
  async callTool(
    toolId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const conn = this.connections.get(toolId);
    if (!conn) throw new Error(`No MCP connection for tool: ${toolId}`);

    try {
      return await conn.client.callTool({
        name: toolName,
        arguments: args,
      });
    } catch (firstErr) {
      console.warn(`[mcp] callTool failed for ${toolId}/${toolName}, attempting reconnect…`);
      const toolRef = conn.tool;
      await this.closeConnection(toolId);
      try {
        await this.getConnection(toolRef);
        const newConn = this.connections.get(toolId);
        if (!newConn) throw firstErr;
        return await newConn.client.callTool({
          name: toolName,
          arguments: args,
        });
      } catch (retryErr) {
        // Second failure is final — throw the retry error
        throw retryErr;
      }
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
   * Falls back to searching all connections if no prefix.
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
    // No prefix — search all connections
    for (const conn of this.connections.values()) {
      if (conn.tools.some((t) => t.name === qualifiedToolName)) {
        return { toolId: conn.toolId, toolName: qualifiedToolName };
      }
    }
    return null;
  }

  /**
   * Get status of all active MCP connections (for diagnosis tool).
   */
  getConnectionStatus(): Array<{ toolId: string; connected: boolean; toolCount: number }> {
    const result: Array<{ toolId: string; connected: boolean; toolCount: number }> = [];
    for (const [id, conn] of this.connections) {
      result.push({ toolId: id, connected: true, toolCount: conn.tools.length });
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
