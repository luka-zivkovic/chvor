import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@chvor/shared";
import { logError } from "./error-logger.ts";
import { getCredentialCiphertextVersion } from "../db/credential-store.ts";
import {
  resolveEnvPlaceholders,
  resolveUrlPlaceholders,
  type PickerContext,
} from "./credential-resolver.ts";
import { pickCredential } from "./credential-picker.ts";
import { assertCredentialAuthUsable } from "./integration-auth-gate.ts";
import { loadTools } from "./capability-loader.ts";
import { registerTrajectorySecrets } from "./orchestrator/trajectory-adapter.ts";

// Read version from package.json once at module load
const __dirname = dirname(fileURLToPath(import.meta.url));
let APP_VERSION = "0.0.1";
try {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8"));
  APP_VERSION = pkg.version ?? APP_VERSION;
} catch {
  /* fallback to default */
}

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
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpCredentialSnapshot {
  credentialId: string;
  ciphertextVersion: string;
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  tools: McpToolInfo[];
  toolId: string;
  tool: Tool; // stored for auto-reconnect on failure
  secretValues: string[];
  credentialSnapshots: McpCredentialSnapshot[];
}

/**
 * Snapshot credential selection before placeholder resolution, then confirm
 * that the resolver used exactly those rows. This avoids attaching a newer
 * ciphertext version to secrets decrypted from an older row during spawn.
 */
function prepareCredentialCapture(
  toolId: string,
  requiredCredentials: string[] | undefined,
  secretValues: Set<string>
): { pickerContext: PickerContext; finalize: () => McpCredentialSnapshot[] } {
  const expectedByType = new Map<string, McpCredentialSnapshot>();
  for (const credentialType of new Set(requiredCredentials ?? [])) {
    const pick = pickCredential(credentialType);
    if (!pick) continue;
    // Preserve the resolver's fail-closed ambiguity behavior without
    // decrypting a fallback candidate that will never be selected.
    if (pick.reason === "first-match-fallback" && pick.candidateCount > 1) continue;
    assertCredentialAuthUsable(pick.credentialId);
    const ciphertextVersion = getCredentialCiphertextVersion(pick.credentialId);
    if (!ciphertextVersion) {
      throw new Error(`[mcp] credential ${pick.credentialId} is unavailable for ${toolId}`);
    }
    expectedByType.set(credentialType, {
      credentialId: pick.credentialId,
      ciphertextVersion,
    });
  }

  const pickedTypes = new Set<string>();
  const capturedById = new Map<string, McpCredentialSnapshot>();
  let selectionChanged = false;
  const pickerContext: PickerContext = {
    onSecrets: (values) => values.forEach((value) => secretValues.add(value)),
    onPick: ({ credentialType, credentialId }) => {
      const expected = expectedByType.get(credentialType);
      if (!expected || expected.credentialId !== credentialId) {
        selectionChanged = true;
        return;
      }
      pickedTypes.add(credentialType);
      capturedById.set(credentialId, expected);
    },
  };

  return {
    pickerContext,
    finalize: () => {
      if (
        selectionChanged ||
        Array.from(expectedByType.keys()).some((credentialType) => !pickedTypes.has(credentialType))
      ) {
        throw new Error(`[mcp] credential selection changed while spawning ${toolId}`);
      }
      for (const snapshot of capturedById.values()) {
        assertCredentialAuthUsable(snapshot.credentialId);
        const currentVersion = getCredentialCiphertextVersion(snapshot.credentialId);
        if (currentVersion !== snapshot.ciphertextVersion) {
          throw new Error(`[mcp] credential changed while spawning ${toolId}`);
        }
      }
      return Array.from(capturedById.values());
    },
  };
}

class McpManager {
  private connections: Map<string, McpConnection>;
  private spawning: Map<string, Promise<McpConnection>>;

  constructor() {
    this.connections = new Map();
    this.spawning = new Map();
  }

  registerConnectionSecrets(toolIds: Iterable<string>): void {
    registerTrajectorySecrets(this.getConnectionSecrets(toolIds));
  }

  getConnectionSecrets(toolIds: Iterable<string>): string[] {
    return Array.from(toolIds).flatMap(
      (toolId) => this.connections.get(toolId)?.secretValues ?? []
    );
  }

  /** Secrets retained only for the lifetime of currently active MCP connections. */
  snapshotActiveConnectionSecrets(): string[] {
    return Array.from(this.connections.values()).flatMap((connection) => connection.secretValues);
  }

  /**
   * Get or spawn an MCP server for a tool. Lazy: first call spawns, subsequent reuse.
   * Concurrent calls for the same tool are deduplicated.
   */
  async getConnection(tool: Tool): Promise<McpConnection> {
    const existing = this.connections.get(tool.id);
    if (existing) {
      registerTrajectorySecrets(existing.secretValues);
      return existing;
    }

    // Dedup: return in-flight spawn promise if one exists
    const inflight = this.spawning.get(tool.id);
    if (inflight) {
      const connection = await inflight;
      registerTrajectorySecrets(connection.secretValues);
      return connection;
    }

    const promise = this.spawnConnection(tool);
    this.spawning.set(tool.id, promise);
    try {
      const connection = await promise;
      registerTrajectorySecrets(connection.secretValues);
      return connection;
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
    const secretValues = new Set<string>();
    let credentialSnapshots: McpCredentialSnapshot[] = [];
    let transport: StdioClientTransport | SSEClientTransport;

    if (transportType === "sse" || transportType === "http") {
      // Remote transport — resolve URL placeholders for API key embedding
      if (!tool.mcpServer.url) {
        throw new Error(`Tool ${tool.id} has transport "${transportType}" but no url`);
      }
      const capture = prepareCredentialCapture(
        tool.id,
        tool.mcpServer.url.includes("{{credentials.")
          ? tool.metadata.requires?.credentials
          : undefined,
        secretValues
      );
      const resolvedUrl = resolveUrlPlaceholders(
        tool.mcpServer.url,
        tool.metadata.requires?.credentials,
        capture.pickerContext
      );
      credentialSnapshots = capture.finalize();
      // Log redacted URL for diagnostics
      const redacted = resolvedUrl.replace(/\/[^/]{8,}$/, "/***");
      console.log(`[mcp] connecting SSE for ${tool.id}: ${redacted}`);
      transport = new SSEClientTransport(new URL(resolvedUrl));
    } else {
      // Stdio transport — spawn local process
      if (!tool.mcpServer.command) {
        throw new Error(`Tool ${tool.id} has stdio transport but no command`);
      }

      const capture = prepareCredentialCapture(
        tool.id,
        tool.mcpServer.env ? tool.metadata.requires?.credentials : undefined,
        secretValues
      );
      const resolvedEnv = resolveEnvPlaceholders(
        tool.mcpServer.env,
        tool.metadata.requires?.credentials,
        capture.pickerContext
      );
      credentialSnapshots = capture.finalize();

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
            .replace(
              /\{\{tmp\}\}/g,
              process.platform === "win32"
                ? (process.env.TEMP ?? process.env.TMP ?? homedir())
                : "/tmp"
            )
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

    try {
      await withTimeout(client.connect(transport), SPAWN_TIMEOUT_MS, `MCP spawn for ${tool.id}`);
    } catch (err) {
      // If spawn times out, the child process is already running — close the transport to kill it
      try {
        await transport.close();
      } catch {
        /* ignore cleanup errors */
      }
      throw err;
    }

    let tools: McpToolInfo[];
    try {
      const toolsResult = await withTimeout(
        client.listTools(),
        DISCOVERY_TIMEOUT_MS,
        `MCP listTools for ${tool.id}`
      );
      for (const snapshot of credentialSnapshots) {
        assertCredentialAuthUsable(snapshot.credentialId);
        if (getCredentialCiphertextVersion(snapshot.credentialId) !== snapshot.ciphertextVersion) {
          throw new Error(`[mcp] credential changed while establishing ${tool.id}`);
        }
      }
      tools = (toolsResult.tools ?? [])
        .filter((item) => item.name)
        .map((item) => ({
          name: item.name,
          description: item.description ?? "",
          inputSchema: (item.inputSchema ?? {}) as Record<string, unknown>,
        }));
    } catch (error) {
      try {
        await client.close();
      } catch {
        /* ignore cleanup errors */
      }
      try {
        await transport.close();
      } catch {
        /* ignore cleanup errors */
      }
      throw error;
    }

    const connection: McpConnection = {
      client,
      transport,
      tools,
      toolId: tool.id,
      tool,
      secretValues: Array.from(secretValues),
      credentialSnapshots,
    };

    this.connections.set(tool.id, connection);
    console.log(`[mcp] spawned server for tool: ${tool.id} (${tools.length} tools)`);
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
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const cached = this.connections.get(toolId);
    if (!cached) throw new Error(`No MCP connection for tool: ${toolId}`);
    const conn = await this.ensureCredentialsCurrent(cached);
    registerTrajectorySecrets(conn.secretValues);

    try {
      return await withTimeout(
        conn.client.callTool({ name: toolName, arguments: args }, undefined, { signal }),
        CALL_TIMEOUT_MS,
        `MCP callTool ${toolId}/${toolName}`
      );
    } catch (firstErr) {
      if (signal?.aborted || (firstErr instanceof Error && firstErr.name === "AbortError")) {
        throw firstErr;
      }
      console.warn(`[mcp] callTool failed for ${toolId}/${toolName}, attempting reconnect…`);
      const toolRef = conn.tool;
      await this.closeConnectionRecord(conn);
      const reconnected = await this.getConnection(toolRef);
      const newConn = await this.ensureCredentialsCurrent(reconnected);
      registerTrajectorySecrets(newConn.secretValues);
      return await withTimeout(
        newConn.client.callTool({ name: toolName, arguments: args }, undefined, { signal }),
        CALL_TIMEOUT_MS,
        `MCP callTool retry ${toolId}/${toolName}`
      );
    }
  }

  /** Validate cached auth and recycle once when a credential row has rotated. */
  private async ensureCredentialsCurrent(initial: McpConnection): Promise<McpConnection> {
    let conn = initial;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let ciphertextChanged = false;
      try {
        for (const snapshot of conn.credentialSnapshots) {
          assertCredentialAuthUsable(snapshot.credentialId);
          const currentVersion = getCredentialCiphertextVersion(snapshot.credentialId);
          if (!currentVersion) {
            throw new Error(
              `[mcp] credential ${snapshot.credentialId} is unavailable; refusing dispatch`
            );
          }
          if (currentVersion !== snapshot.ciphertextVersion) {
            ciphertextChanged = true;
          }
        }
      } catch (err) {
        await this.closeConnectionRecord(conn);
        throw err;
      }

      if (!ciphertextChanged) return conn;

      const toolRef = conn.tool;
      console.warn(`[mcp] credentials changed for ${conn.toolId}; recycling cached connection`);
      await this.closeConnectionRecord(conn);
      if (attempt === 1) {
        throw new Error(
          `[mcp] credentials changed repeatedly for ${conn.toolId}; refusing dispatch`
        );
      }
      conn = await this.getConnection(toolRef);
    }
    throw new Error(`[mcp] could not obtain a credential-current connection for ${initial.toolId}`);
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
  findToolForQualifiedName(qualifiedToolName: string): { toolId: string; toolName: string } | null {
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
      console.warn(
        `[mcp] ambiguous tool name "${qualifiedToolName}" found in ${matches.length} connections: ${matches.map((m) => m.toolId).join(", ")}. Using first match. Prefer qualified names (toolId__toolName).`
      );
    }
    return matches[0] ?? null;
  }

  /**
   * Get status of all active MCP connections (for diagnosis tool).
   * Probes each connection with a lightweight listTools call to detect stale transports.
   */
  async getConnectionStatus(): Promise<
    Array<{ toolId: string; connected: boolean; toolCount: number }>
  > {
    const result: Array<{ toolId: string; connected: boolean; toolCount: number }> = [];
    // Snapshot entries to avoid issues if connections mutate during async probes
    const entries = [...this.connections.entries()];
    for (const [id, conn] of entries) {
      let connected = false;
      let checkedConnection = conn;
      try {
        checkedConnection = await this.ensureCredentialsCurrent(conn);
        await withTimeout(
          checkedConnection.client.listTools(),
          HEALTH_CHECK_TIMEOUT_MS,
          `health check ${id}`
        );
        connected = true;
      } catch {
        console.warn(`[mcp] health check failed for ${id} — marking as disconnected`);
      }
      result.push({ toolId: id, connected, toolCount: checkedConnection.tools.length });
    }
    return result;
  }

  /**
   * Close a specific MCP connection (for repair tool). Re-spawns lazily on next use.
   */
  async closeConnection(toolId: string): Promise<boolean> {
    const conn = this.connections.get(toolId);
    if (!conn) return false;
    await this.closeConnectionRecord(conn);
    console.log(`[mcp] closed connection for repair: ${toolId}`);
    return true;
  }

  /** Remove this exact cached instance before async cleanup so replacements survive races. */
  private async closeConnectionRecord(conn: McpConnection): Promise<void> {
    if (this.connections.get(conn.toolId) === conn) {
      this.connections.delete(conn.toolId);
    }
    try {
      await conn.client.close();
    } catch (err) {
      console.error(`[mcp] error closing client ${conn.toolId}:`, err);
    }
    try {
      await conn.transport.close();
    } catch {
      /* ignore transport cleanup errors */
    }
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
