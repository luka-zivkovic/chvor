import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@chvor/shared";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-mcp-credential-cache-"));
process.env.CHVOR_DATA_DIR = dataDir;

type MockFn = ReturnType<typeof vi.fn>;
interface MockClientRecord {
  connect: MockFn;
  listTools: MockFn;
  callTool: MockFn;
  close: MockFn;
}
interface MockTransportRecord {
  close: MockFn;
}

const sdk = vi.hoisted(() => ({
  clients: [] as MockClientRecord[],
  transports: [] as MockTransportRecord[],
  callBehaviors: [] as Array<() => Promise<unknown>>,
  onListTools: undefined as ((clientIndex: number) => void) | undefined,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    readonly clientIndex = sdk.clients.length;
    connect = vi.fn(async () => undefined);
    listTools = vi.fn(async () => {
      sdk.onListTools?.(this.clientIndex);
      return {
        tools: [{ name: "echo", description: "fixture", inputSchema: { type: "object" } }],
      };
    });
    callTool = vi.fn(async () => {
      const behavior = sdk.callBehaviors.shift();
      return behavior ? behavior() : { ok: true };
    });
    close = vi.fn(async () => undefined);

    constructor() {
      sdk.clients.push(this);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    close = vi.fn(async () => undefined);

    constructor(_options: unknown) {
      sdk.transports.push(this);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    close = vi.fn(async () => undefined);

    constructor(_url: URL) {
      sdk.transports.push(this);
    }
  },
}));

let mcpManager: typeof import("../mcp-manager.ts").mcpManager;
let credentialStore: typeof import("../../db/credential-store.ts");
let setupStore: typeof import("../../db/integration-setup-store.ts");
let closeDb: typeof import("../../db/database.ts").closeDb;
let CredentialReauthenticationRequiredError: typeof import("../integration-auth-gate.ts").CredentialReauthenticationRequiredError;

const credentialType = "mcp-cache-security";

function mcpTool(id: string): Tool {
  return {
    kind: "tool",
    id,
    instructions: "",
    source: "user",
    path: `${id}.md`,
    builtIn: false,
    metadata: {
      name: "MCP cache fixture",
      description: "Exercises cached credential state",
      version: "1.0.0",
      requires: { credentials: [credentialType] },
    },
    mcpServer: {
      transport: "stdio",
      command: "fixture-mcp",
      env: { MCP_TOKEN: `{{credentials.${credentialType}}}` },
    },
  };
}

function blockCredential(credentialId: string): void {
  setupStore.upsertIntegrationCredentialBinding({
    credentialId,
    integrationId: "mcp-cache-security",
    manifestCredentialId: "credential.mcp-cache-security",
    manifestVersion: "1.0.0",
    authMethod: "api-key",
    authStatus: "reauthentication-required",
    failureCode: "credential_revoked",
  });
}

beforeAll(async () => {
  ({ mcpManager } = await import("../mcp-manager.ts"));
  credentialStore = await import("../../db/credential-store.ts");
  setupStore = await import("../../db/integration-setup-store.ts");
  ({ closeDb } = await import("../../db/database.ts"));
  ({ CredentialReauthenticationRequiredError } = await import("../integration-auth-gate.ts"));
});

beforeEach(async () => {
  await mcpManager.shutdown();
  for (const credential of credentialStore.listCredentials()) {
    credentialStore.deleteCredential(credential.id);
  }
  sdk.clients.length = 0;
  sdk.transports.length = 0;
  sdk.callBehaviors.length = 0;
  sdk.onListTools = undefined;
});

afterAll(async () => {
  await mcpManager.shutdown();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("mcp-manager cached credential security", () => {
  it("closes instead of caching when a credential is blocked during connection discovery", async () => {
    const credential = credentialStore.createCredential("Changed during spawn", credentialType, {
      apiKey: "spawn-fixture-token",
    });
    const tool = mcpTool("spawn-race-mcp");
    sdk.onListTools = (clientIndex) => {
      if (clientIndex === 0) blockCredential(credential.id);
    };

    await expect(mcpManager.discoverTools(tool)).rejects.toBeInstanceOf(
      CredentialReauthenticationRequiredError
    );
    expect(sdk.clients[0].close).toHaveBeenCalledOnce();
    expect(sdk.transports[0].close).toHaveBeenCalledOnce();
    expect(await mcpManager.closeConnection(tool.id)).toBe(false);
  });

  it("closes a cached connection and blocks dispatch when its binding becomes unusable", async () => {
    const credential = credentialStore.createCredential("Blocked MCP fixture", credentialType, {
      apiKey: "blocked-fixture-token",
    });
    const tool = mcpTool("blocked-mcp");
    await mcpManager.discoverTools(tool);
    blockCredential(credential.id);

    await expect(mcpManager.callTool(tool.id, "echo", {})).rejects.toBeInstanceOf(
      CredentialReauthenticationRequiredError
    );

    expect(sdk.clients).toHaveLength(1);
    expect(sdk.clients[0].callTool).not.toHaveBeenCalled();
    expect(sdk.clients[0].close).toHaveBeenCalledOnce();
    expect(sdk.transports[0].close).toHaveBeenCalledOnce();
  });

  it("recycles and respawns before dispatch when credential ciphertext changes", async () => {
    const credential = credentialStore.createCredential("Rotated MCP fixture", credentialType, {
      apiKey: "initial-fixture-token",
    });
    const tool = mcpTool("rotated-mcp");
    await mcpManager.discoverTools(tool);

    credentialStore.updateCredential(credential.id, undefined, {
      apiKey: "rotated-fixture-token",
    });
    await expect(mcpManager.callTool(tool.id, "echo", {})).resolves.toEqual({ ok: true });

    expect(sdk.clients).toHaveLength(2);
    expect(sdk.transports).toHaveLength(2);
    expect(sdk.clients[0].callTool).not.toHaveBeenCalled();
    expect(sdk.clients[0].close).toHaveBeenCalledOnce();
    expect(sdk.clients[1].callTool).toHaveBeenCalledOnce();
  });

  it("rechecks auth after reconnect and before retry dispatch", async () => {
    const credential = credentialStore.createCredential("Retry MCP fixture", credentialType, {
      apiKey: "retry-fixture-token",
    });
    const tool = mcpTool("retry-mcp");
    await mcpManager.discoverTools(tool);
    sdk.callBehaviors.push(async () => {
      throw new Error("fixture transport failure");
    });
    sdk.onListTools = (clientIndex) => {
      if (clientIndex === 1) blockCredential(credential.id);
    };

    await expect(mcpManager.callTool(tool.id, "echo", {})).rejects.toBeInstanceOf(
      CredentialReauthenticationRequiredError
    );

    expect(sdk.clients).toHaveLength(2);
    expect(sdk.clients[0].callTool).toHaveBeenCalledOnce();
    expect(sdk.clients[1].callTool).not.toHaveBeenCalled();
    expect(sdk.clients[1].close).toHaveBeenCalledOnce();
  });
});
