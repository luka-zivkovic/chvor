import { describe, expect, it } from "vitest";
import {
  INTEGRATION_MANIFEST_COMPATIBILITY,
  INTEGRATION_MANIFEST_LIMITS,
  INTEGRATION_MANIFEST_SCHEMA_VERSION,
  INTEGRATION_MANIFEST_SUPPORTED_SCHEMA_VERSIONS,
  INTEGRATION_MANIFEST_SUPPORTED_VERSIONS,
  SUPPORTED_INTEGRATION_MANIFEST_SCHEMA_VERSIONS,
  diagnoseIntegrationManifest,
  integrationManifestErrorToDiagnostics,
  integrationMcpOperationNameSchema,
  integrationManifestV1Schema,
  parseIntegrationManifest,
  safeParseIntegrationManifest,
  safeParseIntegrationManifestWithDiagnostics,
} from "../src/index.js";

function manifestFixture() {
  return {
    schemaVersion: 1,
    id: "github.integration",
    version: "1.2.3-beta.1+build.7",
    name: "GitHub",
    description: "Repository and issue operations.",
    ownership: {
      kind: "first-party",
      name: "Chvor",
      contact: "integrations@example.com",
      url: "https://example.com/integrations",
    },
    source: { kind: "built-in", package: "@chvor/github" },
    mcpServers: [
      {
        id: "github.server",
        transport: "http",
        url: "https://mcp.example.com/mcp",
        credentialFields: [],
        discovery: { mode: "static", tools: ["search.issues"] },
      },
    ],
    tools: [
      {
        id: "repo.list",
        kind: "native",
        name: "List repositories",
        description: "Lists repositories available to an account.",
        credentialFields: [{ credentialId: "github.auth", fieldId: "api.token" }],
        oauthId: "github.direct",
      },
      {
        id: "issues.search",
        kind: "mcp",
        name: "Search issues",
        description: "Searches issues through the declared MCP server.",
        credentialFields: [],
        server: "github.server",
        tool: "search.issues",
      },
      {
        id: "user.get",
        kind: "http",
        name: "Get user",
        description: "Gets the authenticated user.",
        credentialFields: [{ credentialId: "github.auth", fieldId: "api.token" }],
        oauthId: "github.broker",
        method: "GET",
        baseUrl: "https://api.example.com",
        path: "/user/{id}",
      },
    ],
    credentials: [
      {
        id: "github.auth",
        name: "GitHub authentication",
        description: "Fields used to authenticate with GitHub.",
        fields: [
          {
            id: "client.id",
            label: "Client ID",
            description: "Public OAuth client identifier.",
            sensitivity: "text",
            required: true,
          },
          {
            id: "client.secret",
            label: "Client secret",
            description: "Private OAuth client secret.",
            sensitivity: "secret",
            required: true,
          },
          {
            id: "api.token",
            label: "API token",
            description: "Personal access token.",
            sensitivity: "secret",
            required: false,
          },
          {
            id: "instance.url",
            label: "Instance URL",
            description: "Optional enterprise instance URL.",
            sensitivity: "url",
            required: false,
            default: "https://api.example.com",
          },
          {
            id: "config.path",
            label: "Config path",
            description: "Optional local configuration path.",
            sensitivity: "path",
            required: false,
            default: "./github.json",
          },
        ],
      },
    ],
    oauth: [
      {
        id: "github.direct",
        mode: "direct",
        authorizationUrl: "https://provider.example.com/oauth/authorize",
        tokenUrl: "https://provider.example.com/oauth/token",
        clientId: { credentialId: "github.auth", fieldId: "client.id" },
        clientSecret: { credentialId: "github.auth", fieldId: "client.secret" },
        scopes: ["repo", "read:user"],
      },
      {
        id: "github.broker",
        mode: "broker",
        brokerUrl: "https://broker.example.com/oauth/github",
        provider: "github",
        scopes: ["read:user"],
      },
    ],
    capabilities: [
      {
        id: "repositories.read",
        name: "Read repositories",
        description: "Read repository and issue metadata.",
        toolIds: ["repo.list", "issues.search", "user.get"],
      },
    ],
    requestedAccess: {
      network: [
        {
          kind: "host",
          host: "*.example.com",
          protocol: "https",
          ports: [443],
          enforcement: "declared-only",
        },
      ],
      filesystem: [
        {
          path: "./github-cache",
          kind: "path",
          access: "read-write",
          enforcement: "declared-only",
        },
      ],
      process: [
        {
          executable: "/usr/bin/git",
          kind: "executable",
          access: "spawn",
          enforcement: "declared-only",
        },
      ],
      environment: [
        {
          variable: "GITHUB_CONFIG_HOME",
          kind: "variable",
          access: "read",
          enforcement: "declared-only",
        },
      ],
    },
    setup: [
      {
        id: "setup.readme",
        kind: "instruction",
        title: "Review permissions",
        instructions: "Review the requested scopes before continuing.",
      },
      {
        id: "setup.credentials",
        kind: "credential",
        title: "Configure credentials",
        credentialId: "github.auth",
      },
      {
        id: "setup.oauth",
        kind: "oauth",
        title: "Authorize GitHub",
        oauthId: "github.direct",
      },
      {
        id: "setup.check",
        kind: "diagnostic",
        title: "Verify access",
        checkId: "check.tool",
      },
    ],
    diagnostics: [
      {
        id: "check.tool",
        kind: "tool",
        name: "Repository check",
        description: "Checks that repository listing works.",
        toolId: "repo.list",
      },
      {
        id: "check.http",
        kind: "http",
        name: "Provider status",
        description: "Checks provider status without mutating data.",
        url: "https://api.example.com/status",
        method: "HEAD",
        expectedStatus: 200,
        credentialFields: [{ credentialId: "github.auth", fieldId: "client.id" }],
      },
      {
        id: "check.credential",
        kind: "credential",
        name: "Credential presence",
        description: "Checks that the required client identifier is present.",
        credentialField: { credentialId: "github.auth", fieldId: "client.id" },
      },
    ],
    quality: {
      tier: "bronze",
      evidence: ["typed-schemas", "credential-setup", "basic-tests"].map((criterion) => ({
        criterion,
        verification: "automated",
        reference: `test/${criterion}.test.ts`,
      })),
    },
  };
}

function expectDiagnostic(value: unknown, code: string, path?: string) {
  const diagnostics = diagnoseIntegrationManifest(value);
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code, ...(path === undefined ? {} : { path }) }),
    ])
  );
}

describe("integration manifest v1", () => {
  it("parses the complete declarative contract and exposes compatibility constants", () => {
    const parsed = parseIntegrationManifest(manifestFixture());

    expect(parsed.schemaVersion).toBe(INTEGRATION_MANIFEST_SCHEMA_VERSION);
    expect(parsed.tools.map((tool) => tool.kind)).toEqual(["native", "mcp", "http"]);
    expect(parsed.oauth.map((oauth) => oauth.mode)).toEqual(["direct", "broker"]);
    expect(parsed.credentials[0]?.fields.map((field) => field.sensitivity)).toEqual([
      "text",
      "secret",
      "secret",
      "url",
      "path",
    ]);
    expect(parsed.requestedAccess.environment[0]?.enforcement).toBe("declared-only");
    expect(SUPPORTED_INTEGRATION_MANIFEST_SCHEMA_VERSIONS).toEqual([1]);
    expect(INTEGRATION_MANIFEST_SUPPORTED_SCHEMA_VERSIONS).toBe(
      SUPPORTED_INTEGRATION_MANIFEST_SCHEMA_VERSIONS
    );
    expect(INTEGRATION_MANIFEST_SUPPORTED_VERSIONS).toBe(
      SUPPORTED_INTEGRATION_MANIFEST_SCHEMA_VERSIONS
    );
    expect(INTEGRATION_MANIFEST_COMPATIBILITY).toMatchObject({
      current: 1,
      minimum: 1,
      maximum: 1,
    });
  });

  it("accepts every structured source declaration", () => {
    const sources = [
      { kind: "built-in", package: "@chvor/github" },
      {
        kind: "registry",
        registryUrl: "https://registry.example.com",
        package: "@community/github",
      },
      { kind: "mcp", serverId: "github.server" },
      { kind: "synthesized", generator: "openapi", generatorVersion: "2.0.0" },
    ];

    for (const source of sources) {
      expect(safeParseIntegrationManifest({ ...manifestFixture(), source }).success).toBe(true);
    }
  });

  it("provides parse, safeParse, and diagnostic safeParse APIs", () => {
    expect(safeParseIntegrationManifest(manifestFixture()).success).toBe(true);
    expect(safeParseIntegrationManifest({}).success).toBe(false);
    expect(safeParseIntegrationManifestWithDiagnostics(manifestFixture())).toMatchObject({
      success: true,
      diagnostics: [],
    });
    expect(safeParseIntegrationManifestWithDiagnostics({ schemaVersion: 2 })).toEqual({
      success: false,
      diagnostics: [
        expect.objectContaining({
          code: "unsupported_schema_version",
          path: "/schemaVersion",
        }),
      ],
    });
  });

  it.each([
    ["01.2.3", "github.integration"],
    ["1.02.3", "github.integration"],
    ["1.2", "github.integration"],
    ["v1.2.3", "github.integration"],
    ["1.2.3-01", "github.integration"],
    ["1.2.3", "GitHub"],
    ["1.2.3", "github/integration"],
    ["1.2.3", "github..integration"],
  ])("rejects non-strict version %s or ID %s", (version, id) => {
    expect(safeParseIntegrationManifest({ ...manifestFixture(), version, id }).success).toBe(false);
  });

  it("enforces identifier, semver, and collection bounds", () => {
    expect(
      safeParseIntegrationManifest({
        ...manifestFixture(),
        id: `a${"b".repeat(INTEGRATION_MANIFEST_LIMITS.id)}`,
      }).success
    ).toBe(false);
    expect(
      safeParseIntegrationManifest({
        ...manifestFixture(),
        version: `1.2.3+${"a".repeat(INTEGRATION_MANIFEST_LIMITS.semver)}`,
      }).success
    ).toBe(false);
    expect(
      safeParseIntegrationManifest({
        ...manifestFixture(),
        tools: Array.from(
          { length: INTEGRATION_MANIFEST_LIMITS.items + 1 },
          () => manifestFixture().tools[0]
        ),
      }).success
    ).toBe(false);
  });

  it("rejects duplicate declaration IDs, field IDs, and references", () => {
    const duplicateTool = manifestFixture();
    duplicateTool.tools[1]!.id = duplicateTool.tools[0]!.id;
    expectDiagnostic(duplicateTool, "duplicate_id", "/tools/1/id");

    const duplicateField = manifestFixture();
    duplicateField.credentials[0]!.fields[1]!.id = "client.id";
    expectDiagnostic(duplicateField, "duplicate_id", "/credentials/0/fields/1/id");

    const duplicateTarget = manifestFixture();
    duplicateTarget.capabilities[0]!.toolIds.push("repo.list");
    expectDiagnostic(duplicateTarget, "duplicate_reference", "/capabilities/0/toolIds/3");

    const duplicateCredentialRef = manifestFixture();
    duplicateCredentialRef.tools[0]!.credentialFields.push({
      credentialId: "github.auth",
      fieldId: "api.token",
    });
    expectDiagnostic(duplicateCredentialRef, "duplicate_reference", "/tools/0/credentialFields/1");
  });

  it("cross-validates capability, OAuth, credential, setup, and diagnostic references", () => {
    const cases: Array<[ReturnType<typeof manifestFixture>, string]> = [];

    const capability = manifestFixture();
    capability.capabilities[0]!.toolIds[0] = "missing.tool";
    cases.push([capability, "/capabilities/0/toolIds/0"]);

    const credential = manifestFixture();
    credential.tools[0]!.credentialFields[0]!.fieldId = "missing.field";
    cases.push([credential, "/tools/0/credentialFields/0"]);

    const oauth = manifestFixture();
    oauth.tools[0]!.oauthId = "missing.oauth";
    cases.push([oauth, "/tools/0/oauthId"]);

    const setup = manifestFixture();
    setup.setup[3]!.checkId = "missing.check";
    cases.push([setup, "/setup/3/checkId"]);

    const diagnostic = manifestFixture();
    diagnostic.diagnostics[0]!.toolId = "missing.tool";
    cases.push([diagnostic, "/diagnostics/0/toolId"]);

    for (const [value, path] of cases) expectDiagnostic(value, "invalid_reference", path);
  });

  it("rejects secret defaults, embedded values, and non-secret client-secret refs", () => {
    const defaultSecret = manifestFixture();
    defaultSecret.credentials[0]!.fields[1]!.default = "do-not-store-this";
    expectDiagnostic(defaultSecret, "security_violation", "/credentials/0/fields/1/default");

    const embeddedValue = manifestFixture();
    Object.assign(embeddedValue.credentials[0]!.fields[1]!, { value: "do-not-store-this" });
    expectDiagnostic(embeddedValue, "unknown_field", "/credentials/0/fields/1/value");

    const wrongSensitivity = manifestFixture();
    wrongSensitivity.credentials[0]!.fields[1]!.sensitivity = "text";
    expectDiagnostic(wrongSensitivity, "security_violation", "/oauth/0/clientSecret");

    const duplicateOauthRef = manifestFixture();
    duplicateOauthRef.oauth[0]!.clientSecret = { ...duplicateOauthRef.oauth[0]!.clientId };
    expectDiagnostic(duplicateOauthRef, "duplicate_reference", "/oauth/0/clientSecret");
  });

  it("requires HTTPS OAuth endpoints without credentials, query values, or fragments", () => {
    const urls = [
      "http://provider.example.com/oauth/token",
      "https://user:password@provider.example.com/oauth/token",
      "https://provider.example.com/oauth/token?secret=value",
      "https://provider.example.com/oauth/token#secret",
    ];

    for (const tokenUrl of urls) {
      const manifest = manifestFixture();
      manifest.oauth[0]!.tokenUrl = tokenUrl;
      expect(safeParseIntegrationManifest(manifest).success).toBe(false);
    }
  });

  it("rejects query and fragment components in HTTP tool paths", () => {
    for (const path of ["/users?limit=10", "/users#details", "/users/{id}?view=full#details"]) {
      const manifest = manifestFixture();
      manifest.tools[2]!.path = path;
      expect(safeParseIntegrationManifest(manifest).success).toBe(false);
    }
  });

  it("rejects HTTP paths with backslashes or origin-changing URL resolution", () => {
    for (const path of [
      String.raw`/\attacker.example/users`,
      String.raw`/users\profile`,
      "/%5c%5cattacker.example/users",
      "//attacker.example/users",
    ]) {
      const manifest = manifestFixture();
      manifest.tools[2]!.path = path;
      expect(safeParseIntegrationManifest(manifest).success).toBe(false);
    }

    const valid = manifestFixture();
    valid.tools[2]!.path = "/users/profile%20photo";
    expect(safeParseIntegrationManifest(valid).success).toBe(true);
  });

  it("rejects unknown fields and enum members at every strict boundary", () => {
    const root = { ...manifestFixture(), surprise: true };
    expectDiagnostic(root, "unknown_field", "/surprise");

    const nested = manifestFixture();
    Object.assign(nested.tools[0]!, { handler: "execute" });
    expectDiagnostic(nested, "unknown_field", "/tools/0/handler");

    const badEnum = manifestFixture();
    badEnum.requestedAccess.network[0]!.enforcement = "best-effort";
    expectDiagnostic(badEnum, "invalid_enum", "/requestedAccess/network/0/enforcement");

    const badKind = manifestFixture();
    badKind.tools[0]!.kind = "shell";
    expect(safeParseIntegrationManifest(badKind).success).toBe(false);
  });

  it("treats C01 quality tiers and evidence as claims without C04 grading", () => {
    for (const tier of ["experimental", "bronze", "silver", "gold", "platinum"]) {
      const claimed = manifestFixture();
      claimed.quality.tier = tier;
      claimed.quality.evidence = [];
      expect(safeParseIntegrationManifest(claimed).success).toBe(true);
    }
    const selfAttested = manifestFixture();
    selfAttested.quality.evidence = [
      {
        criterion: "typed-schemas",
        verification: "self-attested",
        reference: "publisher-claim",
      },
    ];
    expect(safeParseIntegrationManifest(selfAttested).success).toBe(true);

    const reviewed = manifestFixture();
    reviewed.quality.evidence[0] = {
      criterion: "typed-schemas",
      verification: "reviewed",
      reference: "reviews/typed-schemas.json",
      reviewer: "Security Review Team",
      verifiedAt: "2026-07-12T10:00:00.000+00:00",
    };
    expect(safeParseIntegrationManifest(reviewed).success).toBe(true);

    const incompleteReview = manifestFixture();
    incompleteReview.quality.evidence[0]!.verification = "reviewed";
    expect(safeParseIntegrationManifest(incompleteReview).success).toBe(false);

    const misplacedReview = manifestFixture();
    misplacedReview.quality.evidence[0]!.reviewer = "Unexpected reviewer";
    expect(safeParseIntegrationManifest(misplacedReview).success).toBe(false);
  });

  it("accepts truthful setup-only manifests without invented tools or capabilities", () => {
    const manifest = manifestFixture();
    manifest.mcpServers = [];
    manifest.tools = [];
    manifest.capabilities = [];
    manifest.diagnostics = manifest.diagnostics.filter((check) => check.kind === "credential");
    manifest.setup = manifest.setup.filter((step) => step.kind !== "diagnostic");

    const parsed = parseIntegrationManifest(manifest);
    expect(parsed.tools).toEqual([]);
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.setup.map((step) => step.kind)).toEqual(["instruction", "credential", "oauth"]);
  });

  it("resolves MCP server IDs and honors static discovery declarations", () => {
    const missingServer = manifestFixture();
    missingServer.tools[1]!.server = "missing.server";
    expectDiagnostic(missingServer, "invalid_reference", "/tools/1/server");

    const missingDiscovery = manifestFixture();
    missingDiscovery.tools[1]!.tool = "unadvertised.tool";
    expectDiagnostic(missingDiscovery, "invalid_reference", "/tools/1/tool");

    const missingSource = manifestFixture();
    missingSource.source = { kind: "mcp", serverId: "missing.server" };
    expectDiagnostic(missingSource, "invalid_reference", "/source/serverId");
  });

  it("treats bounded MCP operation names as opaque and case-sensitive", () => {
    const operationName = "Issues/Search V2";
    const valid = manifestFixture();
    valid.mcpServers[0]!.discovery.tools = [operationName];
    valid.tools[1]!.tool = operationName;
    expect(safeParseIntegrationManifest(valid).success).toBe(true);
    expect(integrationMcpOperationNameSchema.safeParse(operationName).success).toBe(true);

    const wrongCase = manifestFixture();
    wrongCase.mcpServers[0]!.discovery.tools = [operationName];
    wrongCase.tools[1]!.tool = operationName.toLowerCase();
    expectDiagnostic(wrongCase, "invalid_reference", "/tools/1/tool");

    expect(
      integrationMcpOperationNameSchema.safeParse(
        "x".repeat(INTEGRATION_MANIFEST_LIMITS.mcpOperationName + 1)
      ).success
    ).toBe(false);
  });

  it("models unknown, unrestricted, and credential-derived access explicitly", () => {
    const manifest = manifestFixture();
    const result = safeParseIntegrationManifest({
      ...manifest,
      requestedAccess: {
        ...manifest.requestedAccess,
        network: [
          ...manifest.requestedAccess.network,
          { kind: "unknown", enforcement: "declared-only" },
          { kind: "unrestricted", enforcement: "declared-only" },
          {
            kind: "credential-derived",
            credentialField: { credentialId: "github.auth", fieldId: "instance.url" },
            protocols: ["https"],
            enforcement: "declared-only",
          },
        ],
        filesystem: [
          ...manifest.requestedAccess.filesystem,
          { kind: "unknown", access: "read-write", enforcement: "declared-only" },
          {
            kind: "credential-derived",
            credentialField: { credentialId: "github.auth", fieldId: "config.path" },
            access: "read",
            enforcement: "declared-only",
          },
        ],
        process: [
          ...manifest.requestedAccess.process,
          { kind: "unrestricted", access: "spawn", enforcement: "declared-only" },
        ],
        environment: [
          ...manifest.requestedAccess.environment,
          { kind: "unknown", access: "read", enforcement: "declared-only" },
          {
            kind: "credential-derived",
            credentialField: { credentialId: "github.auth", fieldId: "api.token" },
            access: "read",
            enforcement: "declared-only",
          },
        ],
      },
    });
    expect(result.success).toBe(true);

    const wrongSensitivity = manifestFixture();
    const access = {
      kind: "credential-derived",
      credentialField: { credentialId: "github.auth", fieldId: "api.token" },
      protocols: ["https"],
      enforcement: "declared-only",
    };
    expectDiagnostic(
      {
        ...wrongSensitivity,
        requestedAccess: {
          ...wrongSensitivity.requestedAccess,
          network: [...wrongSensitivity.requestedAccess.network, access],
        },
      },
      "security_violation",
      "/requestedAccess/network/1/credentialField"
    );
  });

  it("accepts only the documented non-secret OAuth parameter allowlist", () => {
    const valid = manifestFixture();
    Object.assign(valid.oauth[0]!, {
      authorizationParams: [
        { name: "access_type", value: "offline" },
        { name: "audience", value: "custom-api" },
        { name: "duration", value: "permanent" },
        { name: "prompt", value: "consent" },
      ],
      tokenParams: [
        { name: "grant_type", value: "authorization_code" },
        { name: "resource", value: "custom-api" },
      ],
    });
    expect(safeParseIntegrationManifest(valid).success).toBe(true);

    for (const name of [
      "client_secret",
      "clientSecret",
      "client_assertion",
      "client-assertion",
      "clientAssertion",
      "CLIENT_ASSERTION",
      "client_assertion_type",
      "assertion",
      "accessToken",
      "apiKey",
      "Authorization",
      "password",
      "unknown_provider_extension",
    ]) {
      const rawSecret = manifestFixture();
      Object.assign(rawSecret.oauth[0]!, {
        tokenParams: [{ name, value: "embedded-value" }],
      });
      expectDiagnostic(rawSecret, "security_violation", "/oauth/0/tokenParams/0/name");
    }
  });

  it("rejects forbidden OAuth parameter names without reflecting or leaking values", () => {
    const embeddedSecret = "oauth-value-must-stay-unread";
    let valueReflected = false;
    const parameter = new Proxy(
      { name: "clientSecret", value: embeddedSecret },
      {
        get(target, property, receiver) {
          if (property === "value") {
            valueReflected = true;
            throw new Error(embeddedSecret);
          }
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          if (property === "value") {
            valueReflected = true;
            throw new Error(embeddedSecret);
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      }
    );
    const manifest = manifestFixture();
    Object.assign(manifest.oauth[0]!, { tokenParams: [parameter] });

    expect(safeParseIntegrationManifest(manifest).success).toBe(false);
    const diagnostics = diagnoseIntegrationManifest(manifest);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "security_violation",
        path: "/oauth/0/tokenParams/0/name",
      }),
    ]);
    expect(valueReflected).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain(embeddedSecret);
  });

  it("cross-validates every declared HTTP, OAuth, diagnostic, and MCP destination", () => {
    const cases: Array<[ReturnType<typeof manifestFixture>, string]> = [];
    const http = manifestFixture();
    http.tools[2]!.baseUrl = "https://undeclared.invalid";
    cases.push([http, "/tools/2/baseUrl"]);
    const authorization = manifestFixture();
    authorization.oauth[0]!.authorizationUrl = "https://undeclared.invalid/auth";
    cases.push([authorization, "/oauth/0/authorizationUrl"]);
    const token = manifestFixture();
    token.oauth[0]!.tokenUrl = "https://undeclared.invalid/token";
    cases.push([token, "/oauth/0/tokenUrl"]);
    const broker = manifestFixture();
    broker.oauth[1]!.brokerUrl = "https://undeclared.invalid/broker";
    cases.push([broker, "/oauth/1/brokerUrl"]);
    const diagnostic = manifestFixture();
    diagnostic.diagnostics[1]!.url = "https://undeclared.invalid/status";
    cases.push([diagnostic, "/diagnostics/1/url"]);
    const mcp = manifestFixture();
    mcp.mcpServers[0]!.url = "https://undeclared.invalid/mcp";
    cases.push([mcp, "/mcpServers/0/url"]);

    for (const [value, path] of cases) expectDiagnostic(value, "security_violation", path);
  });

  it("forbids secret credential references in raw HTTP diagnostics", () => {
    const manifest = manifestFixture();
    manifest.diagnostics[1]!.credentialFields = [
      { credentialId: "github.auth", fieldId: "api.token" },
    ];
    expectDiagnostic(manifest, "security_violation", "/diagnostics/1/credentialFields/0");
  });

  it("prevents unsupported strong enforcement claims from untrusted declarations", () => {
    const trusted = manifestFixture();
    trusted.requestedAccess.network[0]!.enforcement = "runtime-enforced";
    expect(safeParseIntegrationManifest(trusted).success).toBe(true);

    const untrusted = manifestFixture();
    untrusted.ownership.kind = "community";
    untrusted.source = {
      kind: "registry",
      registryUrl: "https://registry.example.com",
      package: "community/github",
    };
    untrusted.requestedAccess.network[0]!.enforcement = "runtime-enforced";
    expectDiagnostic(untrusted, "security_violation", "/requestedAccess/network/0/enforcement");

    const unsupportedSandbox = manifestFixture();
    unsupportedSandbox.requestedAccess.network[0]!.enforcement = "sandbox-enforced";
    expectDiagnostic(
      unsupportedSandbox,
      "security_violation",
      "/requestedAccess/network/0/enforcement"
    );
  });

  it("validates defaults according to credential sensitivity", () => {
    const invalidUrl = manifestFixture();
    invalidUrl.credentials[0]!.fields[3]!.default = "http://insecure.example.com";
    expect(safeParseIntegrationManifest(invalidUrl).success).toBe(false);

    const invalidPath = manifestFixture();
    invalidPath.credentials[0]!.fields[4]!.default = "github.json";
    expect(safeParseIntegrationManifest(invalidPath).success).toBe(false);

    const valid = manifestFixture();
    valid.credentials[0]!.fields[0]!.default = "public-client-id";
    expect(safeParseIntegrationManifest(valid).success).toBe(true);
  });

  it("returns an explicit unsupported-version diagnostic without echoing the value", () => {
    expect(diagnoseIntegrationManifest({ schemaVersion: "future\nsecret" })).toEqual([
      {
        code: "unsupported_schema_version",
        path: "/schemaVersion",
        message: "Integration manifest schema version is unsupported.",
        hint: "Use schemaVersion 1; supported range is 1-1.",
      },
    ]);
  });

  it("rejects accessor and prototype-bearing inputs without invoking getters", () => {
    let getterInvoked = false;
    const accessor = manifestFixture();
    Object.defineProperty(accessor.ownership, "name", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "stolen-secret";
      },
    });
    expect(integrationManifestV1Schema.safeParse(accessor).success).toBe(false);
    expect(safeParseIntegrationManifest(accessor).success).toBe(false);
    expect(diagnoseIntegrationManifest(accessor)).toEqual([
      expect.objectContaining({
        code: "security_violation",
        path: "/ownership/name",
      }),
    ]);
    expect(getterInvoked).toBe(false);

    class ManifestOwner {
      kind = "first-party";
      name = "Prototype owner";
    }
    const prototypeBearing = { ...manifestFixture(), ownership: new ManifestOwner() };
    expectDiagnostic(prototypeBearing, "security_violation", "/ownership");

    const polluted = manifestFixture();
    Object.defineProperty(polluted.ownership, "__proto__", {
      enumerable: true,
      value: { admin: true },
    });
    expectDiagnostic(polluted, "security_violation", "/ownership/__proto__");
  });

  it("never throws when hostile proxies fail during reflection", () => {
    const hostileInputs = [
      new Proxy(manifestFixture(), {
        ownKeys() {
          throw new Error("ownKeys secret");
        },
      }),
      new Proxy(manifestFixture(), {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor secret");
        },
      }),
      new Proxy(manifestFixture(), {
        getPrototypeOf() {
          throw new Error("prototype secret");
        },
      }),
    ];

    for (const value of hostileInputs) {
      expect(() => safeParseIntegrationManifest(value)).not.toThrow();
      expect(safeParseIntegrationManifest(value).success).toBe(false);
      expect(() => diagnoseIntegrationManifest(value)).not.toThrow();
      const diagnostics = diagnoseIntegrationManifest(value);
      expect(diagnostics).toEqual([expect.objectContaining({ path: "/" })]);
      expect(["security_violation", "validation_failed"]).toContain(diagnostics[0]?.code);
      expect(JSON.stringify(diagnostics)).not.toContain("secret");
      expect(() => safeParseIntegrationManifestWithDiagnostics(value)).not.toThrow();
      expect(safeParseIntegrationManifestWithDiagnostics(value)).toEqual(
        expect.objectContaining({
          success: false,
          diagnostics: [expect.objectContaining({ path: "/" })],
        })
      );
    }

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(() => integrationManifestErrorToDiagnostics(revocable.proxy)).not.toThrow();
    expect(integrationManifestErrorToDiagnostics(revocable.proxy)).toEqual([
      expect.objectContaining({ code: "validation_failed", path: "/" }),
    ]);
  });

  it("rejects sparse, augmented, cyclic, and accessor-bearing arrays as non-plain data", () => {
    const sparse = manifestFixture();
    sparse.tools = new Array(1);
    expectDiagnostic(sparse, "security_violation", "/tools");

    const augmented = manifestFixture();
    Object.assign(augmented.tools, { extra: "hidden" });
    expectDiagnostic(augmented, "security_violation", "/tools");

    const accessorArray = manifestFixture();
    let invoked = false;
    Object.defineProperty(accessorArray.tools, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return manifestFixture().tools[0];
      },
    });
    expectDiagnostic(accessorArray, "security_violation", "/tools/0");
    expect(invoked).toBe(false);

    const cyclic = manifestFixture();
    Object.assign(cyclic, { cycle: cyclic });
    expectDiagnostic(cyclic, "security_violation", "/cycle");
  });

  it("parses only once in each structured diagnostic API", () => {
    for (const validate of [
      diagnoseIntegrationManifest,
      safeParseIntegrationManifestWithDiagnostics,
    ]) {
      let ownKeyReads = 0;
      const value = new Proxy(manifestFixture(), {
        ownKeys(target) {
          ownKeyReads += 1;
          return Reflect.ownKeys(target);
        },
      });
      const result = validate(value);
      expect(Array.isArray(result) ? result : result.diagnostics).toEqual([]);
      expect(ownKeyReads).toBe(2);
    }
  });

  it("converts Zod failures into bounded diagnostics without echoing hostile input", () => {
    const hostileKey = "bad\nfield<script>";
    const value = Object.assign(manifestFixture(), { [hostileKey]: "super-secret-value" });
    const result = safeParseIntegrationManifest(value);
    expect(result.success).toBe(false);
    if (result.success) return;

    const diagnostics = integrationManifestErrorToDiagnostics(result.error);
    expect(diagnostics[0]).toEqual({
      code: "unknown_field",
      path: "/bad_field_script_",
      message: "Unknown field is not allowed.",
      hint: "Remove the field or use a supported schema version.",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("super-secret-value");
    expect(diagnostics.every((diagnostic) => diagnostic.path.length <= 512)).toBe(true);
  });

  it("converts non-Zod failures to a safe generic diagnostic", () => {
    expect(integrationManifestErrorToDiagnostics(new Error("secret runtime detail"))).toEqual([
      {
        code: "validation_failed",
        path: "/",
        message: "Manifest validation failed.",
        hint: "Validate the document with the v1 integration-manifest schema.",
      },
    ]);
  });
});
