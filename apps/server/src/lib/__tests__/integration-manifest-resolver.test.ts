import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@chvor/shared";
import { safeParseIntegrationManifest } from "@chvor/shared";
import { getBundledCapabilities } from "../capability-loader.ts";
import { getNativeToolGroupMap, getNativeToolTarget } from "../native-tools/index.ts";
import { DIRECT_OAUTH_PROVIDERS } from "../oauth-providers.ts";
import {
  EMBEDDING_PROVIDERS,
  IMAGE_GEN_PROVIDERS,
  INTEGRATION_PROVIDERS,
  LLM_PROVIDERS,
  OAUTH_PROVIDERS,
} from "../provider-registry.ts";
import {
  adaptActiveTools,
  adaptOAuthProviders,
  adaptProviderDefinitions,
  LEGACY_INTEGRATION_VERSION,
  resolveIntegrationManifests,
  type DirectOAuthProviderConfig,
} from "../integration-manifest-resolver.ts";

const processSpies = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  fork: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));
const credentialStoreSpies = vi.hoisted(() => ({
  createCredential: vi.fn(),
  deleteCredential: vi.fn(),
  getCredentialData: vi.fn(),
  listCredentialMetadata: vi.fn(),
  listCredentials: vi.fn(),
  updateConnectionConfig: vi.fn(),
  updateCredential: vi.fn(),
  updateTestStatus: vi.fn(),
}));

vi.mock("node:child_process", () => processSpies);
vi.mock("../../db/credential-store.ts", () => credentialStoreSpies);

const googleDirect: DirectOAuthProviderConfig = {
  id: "google",
  name: "Google",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["openid", "email"],
  requiresSecret: true,
};

function toolFixture(overrides: Partial<Tool> = {}): Tool {
  return {
    id: "demo-tool",
    kind: "tool",
    metadata: {
      name: "Demo Tool",
      description: "A representative active MCP tool.",
      version: "1.2.3",
      author: "Example Author",
      requires: { credentials: ["demo"] },
      credentialSchema: {
        type: "demo",
        name: "Demo credentials",
        fields: [
          { key: "apiKey", label: "API key", required: true, secret: true },
          { key: "baseUrl", label: "Base URL", required: false, secret: false },
          { key: "workspacePath", label: "Workspace", required: false, secret: false },
        ],
      },
    },
    instructions: "Use the MCP server.",
    source: "bundled",
    path: "/app/bundled-tools/demo-tool.md",
    builtIn: true,
    mcpServer: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "example-mcp"],
      env: { DEMO_API_KEY: "{{credentials.demo}}" },
    },
    ...overrides,
  };
}

function synthesizedFixture(overrides: Partial<Tool> = {}): Tool {
  return toolFixture({
    id: "billing-api",
    source: "user",
    builtIn: false,
    mcpServer: { transport: "synthesized" },
    synthesized: {
      source: "openapi",
      verified: true,
      specUrl: "https://docs.billing.example.com/openapi.json",
      generatedAt: "2026-07-12T10:00:00.000Z",
      credentialType: "demo",
    },
    endpoints: [
      {
        name: "list_invoices",
        description: "List invoices.",
        method: "GET",
        path: "/v1/invoices",
      },
    ],
    ...overrides,
  });
}

function nativeToolBindings() {
  return Object.keys(getNativeToolGroupMap()).flatMap((operation) => {
    const target = getNativeToolTarget(operation);
    return target?.kind === "tool" ? [{ capabilityId: target.id, operation }] : [];
  });
}

function expectValidManifests(manifests: readonly unknown[]): void {
  for (const manifest of manifests) {
    expect(safeParseIntegrationManifest(manifest).success).toBe(true);
  }
}

function declarationIds(manifest: {
  mcpServers: Array<{ id: string }>;
  tools: Array<{ id: string }>;
  credentials: Array<{ id: string }>;
  oauth: Array<{ id: string }>;
  capabilities: Array<{ id: string }>;
  setup: Array<{ id: string }>;
  diagnostics: Array<{ id: string }>;
}): string[] {
  return [
    ...manifest.mcpServers,
    ...manifest.tools,
    ...manifest.credentials,
    ...manifest.oauth,
    ...manifest.capabilities,
    ...manifest.setup,
    ...manifest.diagnostics,
  ].map((entry) => entry.id);
}

describe("complete catalog identity and provider adapters", () => {
  it("emits a deterministic, globally unique namespaced default catalog", () => {
    const first = resolveIntegrationManifests();
    const second = resolveIntegrationManifests();
    const expectedCount =
      LLM_PROVIDERS.length +
      EMBEDDING_PROVIDERS.length +
      INTEGRATION_PROVIDERS.length +
      IMAGE_GEN_PROVIDERS.length +
      OAUTH_PROVIDERS.length;
    const ids = first.manifests.map((manifest) => manifest.id);

    expect(second).toEqual(first);
    expect(first.manifests).toHaveLength(expectedCount);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.split(/[._-]/).length >= 2)).toBe(true);
    for (const manifest of first.manifests) {
      const namespace =
        manifest.source.kind === "built-in"
          ? manifest.source.package.split("/").at(-1)
          : manifest.source.kind;
      expect(manifest.id.split(/[._-]/)).toContain(namespace);
      const idsWithinManifest = declarationIds(manifest);
      expect(new Set(idsWithinManifest).size).toBe(idsWithinManifest.length);
    }
    expect(first.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expectValidManifests(first.manifests);
  });

  it("composes the real bundled Tool catalog without errors for native metadata", () => {
    const tools = getBundledCapabilities().filter(
      (capability): capability is Tool => capability.kind === "tool"
    );
    const nativeMetadata = tools.filter((tool) => !tool.mcpServer);
    const bindings = nativeToolBindings();
    const result = resolveIntegrationManifests({ tools, nativeToolBindings: bindings });

    expect(nativeMetadata.length).toBeGreaterThan(0);
    expect(tools.some((tool) => tool.mcpServer)).toBe(true);
    expect(
      result.diagnostics.filter((item) => item.sourceKind === "tool" && item.severity === "error")
    ).toEqual([]);
    for (const tool of nativeMetadata) {
      const operations = bindings
        .filter((binding) => binding.capabilityId === tool.id)
        .map((binding) => binding.operation);
      expect(operations.length).toBeGreaterThan(0);
      const manifest = result.manifests.find((item) => item.id === `tool.${tool.id}`);
      expect(manifest).toBeDefined();
      expect(manifest?.tools).toHaveLength(operations.length);
      expect(manifest?.tools.every((item) => item.kind === "native")).toBe(true);
      expect(manifest?.requestedAccess.network).toEqual([
        { kind: "unknown", enforcement: "declared-only" },
      ]);
    }
    const mixedRuntimeTools = tools.filter(
      (tool) =>
        tool.mcpServer && bindings.some((binding) => binding.capabilityId === tool.id)
    );
    expect(mixedRuntimeTools.length).toBeGreaterThan(0);
    for (const tool of mixedRuntimeTools) {
      const manifest = result.manifests.find((item) => item.id === `tool.${tool.id}`);
      expect(manifest?.mcpServers).not.toEqual([]);
      expect(manifest?.tools.some((item) => item.kind === "native")).toBe(true);
      expect(manifest?.requestedAccess.network).toContainEqual({
        kind: "unknown",
        enforcement: "declared-only",
      });
    }
    expectValidManifests(result.manifests);
  });

  it("reports non-executable Tool metadata instead of silently dropping it", () => {
    const result = adaptActiveTools({
      tools: [toolFixture({ id: "instructions-only", mcpServer: undefined })],
      nativeToolBindings: [],
    });

    expect(result.manifests).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        sourceKind: "tool",
        sourceId: "instructions-only",
        path: "/tools",
      }),
    ]);
  });

  it("namespaces colliding legacy IDs by source kind", () => {
    const rawId = "same-id";
    const result = resolveIntegrationManifests({
      llmProviders: [{ ...LLM_PROVIDERS[0], id: rawId }],
      embeddingProviders: [{ ...EMBEDDING_PROVIDERS[0], id: rawId }],
      integrationProviders: [{ ...INTEGRATION_PROVIDERS[0], id: rawId }],
      imageProviders: [{ ...IMAGE_GEN_PROVIDERS[0], id: rawId }],
      oauthProviders: [{ ...OAUTH_PROVIDERS[0], id: rawId }],
      tools: [toolFixture({ id: rawId })],
    });
    const ids = result.manifests.map((manifest) => manifest.id);

    expect(result.manifests).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(ids.every((id) => id.includes(rawId))).toBe(true);
    expectValidManifests(result.manifests);
  });

  it("keeps IntegrationProviderDef entries setup-only", () => {
    const result = adaptProviderDefinitions({
      llmProviders: [],
      embeddingProviders: [],
      integrationProviders: [INTEGRATION_PROVIDERS[0]],
      imageProviders: [],
    });
    const manifest = result.manifests[0];

    expect(manifest.credentials.length).toBeGreaterThan(0);
    expect(manifest.setup.some((step) => step.kind === "credential")).toBe(true);
    expect(manifest.tools).toEqual([]);
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.diagnostics.filter((check) => check.kind === "tool")).toEqual([]);
    expect(JSON.stringify(manifest)).not.toContain("runtime.integration");
    expectValidManifests(result.manifests);
  });

  it("maps credential metadata and legacy-version warnings without mutating providers", () => {
    const provider = {
      ...LLM_PROVIDERS[0],
      id: "fixture-llm",
      requiredFields: [
        { key: "apiKey", label: "API key", type: "password" as const },
        {
          key: "baseUrl",
          label: "Base URL",
          type: "text" as const,
          defaultValue: "https://llm.example.com/v1",
        },
      ],
    };
    const before = structuredClone(provider);
    const result = adaptProviderDefinitions({
      llmProviders: [provider],
      embeddingProviders: [],
      integrationProviders: [],
      imageProviders: [],
    });
    const manifest = result.manifests[0];

    expect(provider).toEqual(before);
    expect(manifest.version).toBe(LEGACY_INTEGRATION_VERSION);
    expect(manifest.credentials[0].fields).toMatchObject([
      { sensitivity: "secret", required: true },
      { sensitivity: "url", required: true, default: "https://llm.example.com/v1" },
    ]);
    expect(
      manifest.diagnostics
        .filter((check) => check.kind === "credential")
        .map((check) => check.credentialField.fieldId)
    ).toEqual(["api-key", "base-url"]);
    expect(manifest.requestedAccess.network).toEqual([
      expect.objectContaining({ host: "llm.example.com", protocol: "https", ports: [443] }),
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warning", path: "/version" })
    );
    expectValidManifests(result.manifests);
  });

  it("declares known, credential-derived, and unknown provider destinations", () => {
    const providers = [
      {
        ...LLM_PROVIDERS[0],
        id: "known-destination",
        requiredFields: [
          {
            key: "baseUrl",
            label: "Base URL",
            type: "text" as const,
            defaultValue: "https://known.example.com/v1",
          },
        ],
      },
      {
        ...LLM_PROVIDERS[0],
        id: "derived-destination",
        requiredFields: [{ key: "baseUrl", label: "Base URL", type: "text" as const }],
      },
      {
        ...LLM_PROVIDERS[0],
        id: "unknown-destination",
        requiredFields: [{ key: "apiKey", label: "API key", type: "password" as const }],
      },
    ];
    const result = adaptProviderDefinitions({
      llmProviders: providers,
      embeddingProviders: [],
      integrationProviders: [],
      imageProviders: [],
    });
    const access = new Map(
      result.manifests.map((manifest) => [manifest.id, manifest.requestedAccess.network])
    );

    expect(access.get("provider.llm.known-destination")).toEqual([
      expect.objectContaining({ host: "known.example.com", protocol: "https", ports: [443] }),
    ]);
    expect(access.get("provider.llm.derived-destination")).toEqual([
      {
        kind: "credential-derived",
        credentialField: {
          credentialId: `credential.${LLM_PROVIDERS[0].credentialType}`,
          fieldId: "base-url",
        },
        protocols: ["https", "tcp"],
        enforcement: "declared-only",
      },
    ]);
    expect(access.get("provider.llm.unknown-destination")).toEqual([
      { kind: "unknown", enforcement: "declared-only" },
    ]);
    expectValidManifests(result.manifests);
  });
});

describe("OAuth metadata joins", () => {
  it("joins the default DIRECT_OAUTH_PROVIDERS metadata without reading secrets", () => {
    const result = adaptOAuthProviders();

    for (const direct of DIRECT_OAUTH_PROVIDERS) {
      const manifest = result.manifests.find((item) => item.id.split(/[._-]/).at(-1) === direct.id);
      expect(manifest, direct.id).toBeDefined();
      const declaration = manifest!.oauth.find((item) => item.mode === "direct");
      expect(declaration).toMatchObject({
        mode: "direct",
        authorizationUrl: direct.authUrl,
        tokenUrl: direct.tokenUrl,
        scopes: direct.scopes,
        ...(direct.extraAuthParams
          ? {
              authorizationParams: Object.entries(direct.extraAuthParams).map(([name, value]) => ({
                name,
                value,
              })),
            }
          : {}),
        ...(direct.extraTokenParams
          ? {
              tokenParams: Object.entries(direct.extraTokenParams).map(([name, value]) => ({
                name,
                value,
              })),
            }
          : {}),
      });
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/clientSecretValue|accessToken|refreshToken|codeVerifier/);
    expect(result.diagnostics.filter((item) => item.path === "/oauth")).toEqual([]);
    expectValidManifests(result.manifests);
  });

  it("lets caller-supplied direct metadata override defaults, including extra params", () => {
    const override = {
      ...googleDirect,
      authUrl: "https://login.override.example.com/authorize",
      tokenUrl: "https://login.override.example.com/token",
      scopes: ["override.read"],
      extraAuthParams: { audience: "custom-api", prompt: "login" },
      extraTokenParams: { resource: "custom-api" },
    } as DirectOAuthProviderConfig;
    const result = adaptOAuthProviders({
      oauthProviders: [OAUTH_PROVIDERS.find((provider) => provider.id === "google")!],
      directOAuthProviders: [override],
    });
    const declaration = result.manifests[0].oauth[0];

    expect(declaration).toMatchObject({
      mode: "direct",
      authorizationUrl: override.authUrl,
      tokenUrl: override.tokenUrl,
      scopes: override.scopes,
      authorizationParams: [
        { name: "audience", value: "custom-api" },
        { name: "prompt", value: "login" },
      ],
      tokenParams: [{ name: "resource", value: "custom-api" }],
    });
    expectValidManifests(result.manifests);
  });
});

describe("synthesized OpenAPI declarations", () => {
  it("uses specUrl only as evidence and represents a credential-derived runtime destination", () => {
    const result = adaptActiveTools({ tools: [synthesizedFixture()] });
    const manifest = result.manifests[0];
    const runtimeJson = JSON.stringify({
      tools: manifest.tools,
      access: manifest.requestedAccess,
    });

    expect(manifest.tools.length).toBeGreaterThan(0);
    expect(runtimeJson).not.toContain("docs.billing.example.com");
    expect(manifest.requestedAccess.network).toContainEqual({
      kind: "credential-derived",
      credentialField: expect.objectContaining({ fieldId: "base-url" }),
      protocols: ["https"],
      enforcement: "runtime-enforced",
    });
    expect(manifest.quality.evidence).toContainEqual(
      expect.objectContaining({
        criterion: "typed-schemas",
        verification: "automated",
        reference: "https://docs.billing.example.com/openapi.json",
      })
    );
    expectValidManifests(result.manifests);
  });

  it("supports AI drafts without specUrl and reports an honestly unknown destination", () => {
    const tool = synthesizedFixture({
      id: "draft-api",
      metadata: {
        ...toolFixture().metadata,
        requires: { credentials: ["token-only"] },
        credentialSchema: {
          type: "token-only",
          name: "Token credentials",
          fields: [{ key: "apiKey", label: "API key", required: true, secret: true }],
        },
      },
      synthesized: {
        source: "ai-draft",
        verified: false,
        generatedAt: "2026-07-12T10:00:00.000Z",
        credentialType: "token-only",
      },
    });
    const result = adaptActiveTools({ tools: [tool] });
    const manifest = result.manifests[0];

    expect(manifest).toBeDefined();
    expect(manifest.tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(manifest.tools)).not.toContain("docs.");
    expect(manifest.requestedAccess.network).toEqual([
      expect.objectContaining({ kind: "unknown", enforcement: "runtime-enforced" }),
    ]);
    expect(manifest.quality.evidence).toEqual([]);
    expectValidManifests(result.manifests);
  });

  it.each([
    ["userinfo", "https://user:password@docs.example.com/openapi.json"],
    ["query", "https://docs.example.com/openapi.json?token=secret"],
    ["fragment", "https://docs.example.com/openapi.json#private"],
    ["non-HTTPS", "http://docs.example.com/openapi.json"],
    ["malformed", "not a URL"],
  ])(
    "rejects or sanitizes unsafe %s spec evidence without making it runtime",
    (_label, specUrl) => {
      const result = adaptActiveTools({
        tools: [
          synthesizedFixture({
            id: `unsafe-spec-${_label.toLowerCase()}`,
            synthesized: {
              source: "openapi",
              verified: true,
              specUrl,
              generatedAt: "2026-07-12T10:00:00.000Z",
              credentialType: "demo",
            },
          }),
        ],
      });
      const manifest = result.manifests[0];

      expect(manifest).toBeDefined();
      const references = manifest.quality.evidence.map((evidence) => evidence.reference);
      for (const reference of references) {
        const parsed = new URL(reference);
        expect(parsed.protocol).toBe("https:");
        expect(parsed.username).toBe("");
        expect(parsed.password).toBe("");
        expect(parsed.search).toBe("");
        expect(parsed.hash).toBe("");
      }
      expect(
        JSON.stringify({ tools: manifest.tools, access: manifest.requestedAccess })
      ).not.toContain("docs.example.com");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ sourceKind: "tool", code: "security_violation" })
      );
      expectValidManifests(result.manifests);
    }
  );
});

describe("MCP discovery and operation declarations", () => {
  it("represents an MCP server without metadata.provides as discovery-only", () => {
    const tool = toolFixture({
      id: "discoverable-mcp",
      metadata: { ...toolFixture().metadata, provides: undefined },
      mcpServer: { transport: "http", url: "https://mcp.example.com/rpc" },
    });
    const result = adaptActiveTools({ tools: [tool] });
    const manifest = result.manifests[0];

    expect(manifest.mcpServers).toContainEqual(
      expect.objectContaining({ discovery: { mode: "runtime" } })
    );
    expect(manifest.tools).toEqual([]);
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.diagnostics.filter((check) => check.kind === "tool")).toEqual([]);
    expectValidManifests(result.manifests);
  });

  it("preserves exact case and opaque MCP operation names from metadata.provides", () => {
    const opaqueOperations = ["CRM.GetLead_V2/Raw", "Salesforce__CREATE-Lead.v3"];
    const tool = toolFixture({
      id: "opaque-mcp",
      metadata: {
        ...toolFixture().metadata,
        provides: {
          "crm:read": "CRM.GetLead_V2/Raw",
          "crm:write": "Salesforce__CREATE-Lead.v3",
        },
      },
      mcpServer: { transport: "sse", url: "https://opaque.example.com/events" },
    });
    const result = adaptActiveTools({ tools: [tool] });
    const manifest = result.manifests[0];
    expect(manifest).toBeDefined();
    const operations = manifest.tools
      .filter(
        (entry): entry is Extract<(typeof manifest)["tools"][number], { kind: "mcp" }> =>
          entry.kind === "mcp"
      )
      .map((entry) => entry.tool);
    expect(manifest.mcpServers).toContainEqual(
      expect.objectContaining({
        discovery: { mode: "static", tools: opaqueOperations },
      })
    );
    expect(operations).toEqual(opaqueOperations);
    expectValidManifests(result.manifests);
  });
});

describe("requested access truthfulness", () => {
  it("declares stdio as a same-user PATH process with broad unknown ambient access", () => {
    const result = adaptActiveTools({ tools: [toolFixture()] });
    const manifest = result.manifests[0];
    const access = manifest.requestedAccess;

    expect(manifest.mcpServers).toContainEqual(
      expect.objectContaining({
        transport: "stdio",
        command: "/usr/bin/env",
        args: ["npx", "-y", "example-mcp"],
      })
    );
    expect(JSON.stringify(access.process)).toMatch(/unknown|unrestricted/i);
    expect(access.process).toContainEqual(expect.objectContaining({ access: "spawn" }));
    expect(access.network.length).toBeGreaterThan(0);
    expect(access.filesystem.length).toBeGreaterThan(0);
    expect(access.environment.length).toBeGreaterThan(0);
    for (const ambient of [access.network, access.filesystem, access.environment]) {
      expect(JSON.stringify(ambient)).toMatch(/unknown|broad|unrestricted|inherited|\*/i);
    }
    const accessWarnings = result.diagnostics.filter((item) => item.code === "security_violation");
    expect(accessWarnings.length).toBeGreaterThan(0);
    expect(accessWarnings.map((item) => item.message).join(" ")).toMatch(/same.user/i);
    expectValidManifests(result.manifests);
  });

  it("declares truthful remote MCP hosts without local process or ambient access", () => {
    const result = adaptActiveTools({
      tools: [
        toolFixture({
          id: "remote-mcp",
          source: "user",
          builtIn: false,
          mcpServer: { transport: "http", url: "https://Remote.Example.com:8443/mcp" },
        }),
      ],
    });
    const access = result.manifests[0].requestedAccess;

    expect(result.manifests[0].mcpServers).toContainEqual(
      expect.objectContaining({ transport: "http", url: "https://remote.example.com:8443/mcp" })
    );
    expect(access.network).toEqual([
      expect.objectContaining({ host: "remote.example.com", protocol: "https", ports: [8443] }),
    ]);
    expect(access.process).toEqual([]);
    expect(access.filesystem).toEqual([]);
    expect(access.environment).toEqual([]);
    expectValidManifests(result.manifests);
  });
});

describe("hostile input isolation", () => {
  it("isolates throwing getters and proxies per source kind while valid neighbors survive", () => {
    const poison = new Proxy(
      {},
      {
        get() {
          throw new Error("TOP SECRET FROM HOSTILE GETTER");
        },
      }
    );
    const result = resolveIntegrationManifests({
      llmProviders: [poison as (typeof LLM_PROVIDERS)[number], LLM_PROVIDERS[0]],
      embeddingProviders: [poison as (typeof EMBEDDING_PROVIDERS)[number], EMBEDDING_PROVIDERS[0]],
      integrationProviders: [
        poison as (typeof INTEGRATION_PROVIDERS)[number],
        INTEGRATION_PROVIDERS[0],
      ],
      imageProviders: [poison as (typeof IMAGE_GEN_PROVIDERS)[number], IMAGE_GEN_PROVIDERS[0]],
      oauthProviders: [poison as (typeof OAUTH_PROVIDERS)[number], OAUTH_PROVIDERS[0]],
      tools: [poison as Tool, toolFixture({ id: "valid-neighbor" })],
    });

    expect(result.manifests).toHaveLength(6);
    expectValidManifests(result.manifests);
    for (const kind of ["llm", "embedding", "integration", "image", "oauth", "tool"] as const) {
      const diagnostic = result.diagnostics.find(
        (item) => item.sourceKind === kind && item.severity === "error"
      );
      expect(diagnostic, kind).toBeDefined();
      expect(diagnostic!.message.toLowerCase()).toContain(kind);
      expect(diagnostic!.message).not.toContain("TOP SECRET");
      expect(diagnostic!.sourceId).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(diagnostic!.sourceId.length).toBeLessThanOrEqual(128);
    }
  });

  it("sanitizes and bounds diagnostic source IDs from malformed entries", () => {
    const hostileId = `  Credential\nBearer secret-value ${"x".repeat(600)}  `;
    const throwing = {
      id: hostileId,
      get metadata() {
        throw new Error("must not escape");
      },
    } as unknown as Tool;
    const result = adaptActiveTools({ tools: [throwing, toolFixture({ id: "healthy-tool" })] });
    const diagnostic = result.diagnostics.find((item) => item.severity === "error")!;

    expect(result.manifests).toHaveLength(1);
    expect(diagnostic.sourceId).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(diagnostic.sourceId.length).toBeLessThanOrEqual(128);
    expect(diagnostic.sourceId).not.toContain("\n");
    expect(diagnostic.sourceId).not.toBe(hostileId);
    expect(diagnostic.message).not.toContain("must not escape");
    expectValidManifests(result.manifests);
  });
});

describe("resolver purity", () => {
  it("is deterministic and performs no network, process, or credential-value reads", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("resolver attempted network I/O");
    });
    vi.stubGlobal("fetch", fetchSpy);
    for (const spy of Object.values(processSpies)) spy.mockClear();
    for (const spy of Object.values(credentialStoreSpies)) spy.mockClear();

    let credentialReads = 0;
    const synthesized = synthesizedFixture({
      id: "pure-draft",
      synthesized: Object.defineProperty(
        {
          source: "ai-draft",
          verified: false,
          generatedAt: "2026-07-12T10:00:00.000Z",
          credentialType: "demo",
        },
        "credentialId",
        {
          enumerable: true,
          get() {
            credentialReads += 1;
            throw new Error("credential value was read");
          },
        }
      ) as Tool["synthesized"],
    });
    const options = Object.freeze({ tools: Object.freeze([synthesized]) });

    try {
      const first = resolveIntegrationManifests(options);
      const second = resolveIntegrationManifests(options);

      expect(second).toEqual(first);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const spy of Object.values(processSpies)) expect(spy).not.toHaveBeenCalled();
      for (const spy of Object.values(credentialStoreSpies)) expect(spy).not.toHaveBeenCalled();
      expect(credentialReads).toBe(0);
      expectValidManifests(first.manifests);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
