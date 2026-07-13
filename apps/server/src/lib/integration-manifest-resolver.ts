import type {
  EmbeddingProviderDef,
  ImageGenProviderDef,
  IntegrationCredential,
  IntegrationCredentialFieldRef,
  IntegrationManifestDiagnostic,
  IntegrationManifestV1,
  IntegrationOauth,
  IntegrationOwner,
  IntegrationProviderDef,
  IntegrationRequestedAccess,
  IntegrationSetupStep,
  IntegrationTool,
  LLMProviderDef,
  OAuthProviderDef,
  ProviderField,
  Tool,
} from "@chvor/shared";
import { diagnoseIntegrationManifest, safeParseIntegrationManifest } from "@chvor/shared";
import {
  EMBEDDING_PROVIDERS,
  IMAGE_GEN_PROVIDERS,
  INTEGRATION_PROVIDERS,
  LLM_PROVIDERS,
  OAUTH_PROVIDERS,
} from "./provider-registry.ts";
import { DIRECT_OAUTH_PROVIDERS } from "./oauth-providers.ts";

/** Legacy catalogs are app-coupled rather than independently versioned. */
export const LEGACY_INTEGRATION_VERSION = "0.0.0";
export const DEFAULT_REGISTRY_URL = "https://registry.chvor.ai/v1";

type LegacyVersioned<T> = T & { version?: string };
type ResolverSourceKind = "llm" | "embedding" | "integration" | "image" | "oauth" | "tool";

export interface DirectOAuthProviderConfig {
  id: string;
  name: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  extraAuthParams?: Readonly<Record<string, string>>;
  extraTokenParams?: Readonly<Record<string, string>>;
  requiresSecret?: boolean;
}

export interface IntegrationManifestResolverDiagnostic extends IntegrationManifestDiagnostic {
  severity: "warning" | "error";
  sourceKind: ResolverSourceKind;
  sourceId: string;
}

export interface IntegrationManifestResolverResult {
  manifests: IntegrationManifestV1[];
  diagnostics: IntegrationManifestResolverDiagnostic[];
}

export interface NativeToolBinding {
  /** Capability frontmatter ID that owns the native runtime operation. */
  capabilityId: string;
  /** Exact qualified operation name registered by the native runtime. */
  operation: string;
}

export interface IntegrationManifestResolverOptions {
  llmProviders?: readonly LegacyVersioned<LLMProviderDef>[];
  embeddingProviders?: readonly LegacyVersioned<EmbeddingProviderDef>[];
  integrationProviders?: readonly LegacyVersioned<IntegrationProviderDef>[];
  imageProviders?: readonly LegacyVersioned<ImageGenProviderDef>[];
  oauthProviders?: readonly LegacyVersioned<OAuthProviderDef>[];
  /** Metadata-only overrides for the built-in direct OAuth provider catalog. */
  directOAuthProviders?: readonly DirectOAuthProviderConfig[];
  /** The caller supplies the already-active/deduplicated Tool objects. */
  tools?: readonly Tool[];
  /** Runtime-native operations mapped back to their Tool capability metadata. */
  nativeToolBindings?: readonly NativeToolBinding[];
  registryUrl?: string;
}

interface BuildContext {
  kind: ResolverSourceKind;
  id: string;
  warnings: IntegrationManifestResolverDiagnostic[];
}

const FIRST_PARTY_OWNER: IntegrationOwner = { kind: "first-party", name: "Chvor" };
const EMPTY_ACCESS: IntegrationRequestedAccess = {
  network: [],
  filesystem: [],
  process: [],
  environment: [],
};
const SKIP_SOURCE = Symbol("skip-integration-manifest-source");

function diagnostic(
  context: Pick<BuildContext, "kind" | "id">,
  severity: "warning" | "error",
  value: IntegrationManifestDiagnostic
): IntegrationManifestResolverDiagnostic {
  return { ...value, severity, sourceKind: context.kind, sourceId: context.id };
}
function warning(
  context: BuildContext,
  path: string,
  message: string,
  hint: string,
  code: IntegrationManifestDiagnostic["code"] = "invalid_value"
): void {
  context.warnings.push(diagnostic(context, "warning", { code, path, message, hint }));
}
function safeDiagnosticSourceId(value: unknown, fallback: string): string {
  try {
    if (typeof value !== "object" || value === null) return fallback;
    const id = Reflect.get(value, "id");
    if (typeof id !== "string") return fallback;
    const sanitized = id
      .split("")
      .map((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f ? " " : character;
      })
      .join("")
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 128);
    return sanitized || fallback;
  } catch {
    return fallback;
  }
}
function declarationId(value: string, fallback = "legacy"): string {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/[._-]{2,}/g, "-")
    .replace(/[._-]+$/, "")
    .slice(0, 110);
  return normalized || fallback;
}
function manifestId(namespace: string, value: string): string {
  return `${namespace}.${value}`;
}
function safeHttpsEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 1_024) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}
function legacyVersion(value: unknown, context: BuildContext): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  warning(
    context,
    "/version",
    `Legacy ${context.kind} entry has no independent version; using ${LEGACY_INTEGRATION_VERSION}.`,
    "Add a strict semantic version to the source declaration when it gains an independent release lifecycle."
  );
  return LEGACY_INTEGRATION_VERSION;
}
function knownSensitivity(key: string, explicitText = false): "secret" | "text" | "url" | "path" {
  const normalized = key.toLowerCase();
  if (normalized.includes("path") || normalized === "directory" || normalized === "folder") {
    return "path";
  }
  if (normalized.includes("url") || normalized === "endpoint" || normalized === "uri") {
    return "url";
  }
  if (
    explicitText ||
    ["clientid", "email", "username", "userid", "domain", "host", "port"].includes(normalized)
  ) {
    return "text";
  }
  return "secret";
}
function providerCredential(
  credentialType: string | null,
  providerName: string,
  fields: readonly ProviderField[],
  genericWhenEmpty: boolean
): IntegrationCredential[] {
  if (!credentialType || (fields.length === 0 && !genericWhenEmpty)) return [];
  const sourceFields =
    fields.length > 0 ? fields : [{ key: "apiKey", label: "API Key", type: "password" as const }];
  const manifestFields: IntegrationCredential["fields"] = sourceFields.map((field) => {
    const sensitivity =
      field.type === "password" ? ("secret" as const) : knownSensitivity(field.key, true);
    const common = {
      id: declarationId(field.key, "field"),
      label: field.label,
      description: field.helpText ?? `Credential field used by ${providerName}.`,
      required: field.optional !== true,
    };
    if (sensitivity === "secret") return { ...common, sensitivity };
    const defaultValue =
      field.defaultValue !== undefined &&
      (sensitivity !== "url" || safeHttpsEndpoint(field.defaultValue) !== undefined)
        ? { default: field.defaultValue }
        : {};
    if (sensitivity === "url") return { ...common, sensitivity, ...defaultValue };
    if (sensitivity === "path") return { ...common, sensitivity, ...defaultValue };
    return { ...common, sensitivity, ...defaultValue };
  });
  return [
    {
      id: `credential.${declarationId(credentialType)}`,
      name: `${providerName} credentials`,
      description: `Credential metadata required by ${providerName}.`,
      fields: manifestFields,
    },
  ];
}
function credentialRefs(
  credentials: readonly IntegrationCredential[]
): IntegrationCredentialFieldRef[] {
  return credentials.flatMap((credential) =>
    credential.fields.map((field) => ({
      credentialId: credential.id,
      fieldId: field.id,
    }))
  );
}
function copyCredentialRefs(
  refs: readonly IntegrationCredentialFieldRef[]
): IntegrationCredentialFieldRef[] {
  return refs.map((ref) => ({ credentialId: ref.credentialId, fieldId: ref.fieldId }));
}
function setupDeclarations(
  credentials: readonly IntegrationCredential[],
  oauth: readonly IntegrationOauth[],
  toolIds: readonly string[]
): { setup: IntegrationSetupStep[]; diagnostics: IntegrationManifestV1["diagnostics"] } {
  const setup: IntegrationSetupStep[] = [];
  const diagnostics: IntegrationManifestV1["diagnostics"] = [];
  for (const credential of credentials) {
    setup.push({
      id: `setup.${credential.id}`,
      kind: "credential",
      title: `Configure ${credential.name}`,
      credentialId: credential.id,
    });
    for (const field of credential.fields.filter((item) => item.required)) {
      const checkId = `check.${credential.id}.${field.id}`;
      diagnostics.push({
        id: checkId,
        kind: "credential",
        name: `Check ${field.label}`,
        description: `Confirm required ${field.label} metadata is available for ${credential.name}.`,
        credentialField: { credentialId: credential.id, fieldId: field.id },
      });
      setup.push({
        id: `setup.${checkId}`,
        kind: "diagnostic",
        title: `Validate ${field.label}`,
        checkId,
      });
    }
  }
  for (const declaration of oauth) {
    setup.push({
      id: `setup.${declaration.id}`,
      kind: "oauth",
      title: "Connect account",
      oauthId: declaration.id,
    });
  }
  for (const toolId of toolIds) {
    const checkId = `check.${toolId}`;
    diagnostics.push({
      id: checkId,
      kind: "tool",
      name: `Check ${toolId}`,
      description: "Confirm the declared integration tool is available to the runtime.",
      toolId,
    });
    setup.push({
      id: `setup.${checkId}`,
      kind: "diagnostic",
      title: `Validate ${toolId}`,
      checkId,
    });
  }
  return { setup, diagnostics };
}
function accessFromUrls(
  urls: readonly string[],
  enforcement: "runtime-enforced" | "declared-only"
): IntegrationRequestedAccess {
  const network: IntegrationRequestedAccess["network"] = [];
  const seen = new Set<string>();
  for (const value of urls) {
    try {
      const url = new URL(value);
      const protocol =
        url.protocol === "https:" ? "https" : url.protocol === "wss:" ? "wss" : "tcp";
      const port = url.port
        ? Number(url.port)
        : protocol === "https" || protocol === "wss"
          ? 443
          : 80;
      const key = `${url.hostname}:${protocol}:${port}`;
      if (!seen.has(key)) {
        seen.add(key);
        network.push({ host: url.hostname.toLowerCase(), protocol, ports: [port], enforcement });
      }
    } catch {
      // Candidate validation or the caller-facing adapter diagnostic handles malformed URLs.
    }
  }
  return { ...EMPTY_ACCESS, network };
}
function collectCandidate(
  result: IntegrationManifestResolverResult,
  context: BuildContext,
  candidate: unknown
): void {
  if (candidate === SKIP_SOURCE) {
    result.diagnostics.push(...context.warnings);
    return;
  }
  const parsed = safeParseIntegrationManifest(candidate);
  if (parsed.success) {
    result.manifests.push(parsed.data);
    result.diagnostics.push(...context.warnings);
    return;
  }
  result.diagnostics.push(...context.warnings);
  result.diagnostics.push(
    ...diagnoseIntegrationManifest(candidate).map((item) => diagnostic(context, "error", item))
  );
}
function adaptEach<T>(
  values: readonly T[],
  kind: ResolverSourceKind,
  result: IntegrationManifestResolverResult,
  build: (value: T, context: BuildContext) => unknown
): void {
  for (let index = 0; index < values.length; index += 1) {
    let value: T;
    try {
      value = values[index];
    } catch {
      result.diagnostics.push({
        code: "validation_failed",
        path: "/",
        message: `Legacy ${kind} entry could not be read safely.`,
        hint: `Replace the ${kind} source entry with plain metadata and retry manifest resolution.`,
        severity: "error",
        sourceKind: kind,
        sourceId: `${kind}-${index}`,
      });
      continue;
    }
    const context: BuildContext = {
      kind,
      id: safeDiagnosticSourceId(value, `${kind}-${index}`),
      warnings: [],
    };
    try {
      collectCandidate(result, context, build(value, context));
    } catch {
      result.diagnostics.push(
        diagnostic(context, "error", {
          code: "validation_failed",
          path: "/",
          message: `Legacy ${kind} entry could not be adapted safely.`,
          hint: `Correct the ${kind} source metadata and retry manifest resolution.`,
        })
      );
    }
  }
}

type ProviderKind = "llm" | "embedding" | "integration" | "image";
type ProviderValue =
  | LegacyVersioned<LLMProviderDef>
  | LegacyVersioned<EmbeddingProviderDef>
  | LegacyVersioned<IntegrationProviderDef>
  | LegacyVersioned<ImageGenProviderDef>;

function providerAccess(
  provider: ProviderValue,
  kind: ProviderKind,
  fields: readonly ProviderField[],
  credentials: readonly IntegrationCredential[]
): IntegrationRequestedAccess {
  const usageUrls =
    kind === "integration" && "usageContext" in provider
      ? (provider.usageContext?.match(/https:\/\/[^\s,;)]+/g) ?? []).map((url) =>
          url.replace(/[.!?:]+$/, "")
        )
      : [];
  const defaultUrls = fields.flatMap((field) =>
    field.defaultValue && knownSensitivity(field.key, true) === "url" ? [field.defaultValue] : []
  );
  const access = accessFromUrls([...usageUrls, ...defaultUrls], "declared-only");
  const refs = credentialRefs(credentials);
  for (const field of fields) {
    const destinationField = knownSensitivity(field.key, true) === "url";
    if (
      !destinationField ||
      (field.defaultValue &&
        accessFromUrls([field.defaultValue], "declared-only").network.length > 0)
    )
      continue;
    const ref = refs.find((item) => item.fieldId === declarationId(field.key, "field"));
    if (ref) {
      access.network.push({
        kind: "credential-derived",
        credentialField: { ...ref },
        protocols:
          knownSensitivity(field.key, true) === "url" ? ["https", "tcp"] : ["tcp", "https"],
        enforcement: "declared-only",
      });
    }
  }
  const localWithoutNetwork =
    "isLocal" in provider && provider.isLocal === true && access.network.length === 0;
  const filesystemOnly =
    kind === "integration" &&
    fields.length > 0 &&
    fields.every((field) => knownSensitivity(field.key, true) === "path");
  if (access.network.length === 0 && !localWithoutNetwork && !filesystemOnly) {
    access.network.push({ kind: "unknown", enforcement: "declared-only" });
  }
  return access;
}
function providerManifest(
  provider: ProviderValue,
  kind: ProviderKind,
  context: BuildContext
): IntegrationManifestV1 {
  const providerFields = "requiredFields" in provider ? provider.requiredFields : [];
  const credentials = providerCredential(
    provider.credentialType,
    provider.name,
    providerFields,
    kind !== "integration" && provider.credentialType !== null
  );
  const refs = credentialRefs(credentials);
  const runtimeId = `runtime.${kind}`;
  const integrationSetupOnly = kind === "integration";
  const tools: IntegrationTool[] = integrationSetupOnly
    ? []
    : [
        {
          id: runtimeId,
          kind: "native",
          name: `${provider.name} ${kind} runtime`,
          description: `Use the built-in ${provider.name} ${kind} provider.`,
          credentialFields: copyCredentialRefs(refs),
        },
      ];
  const declarations = setupDeclarations(credentials, [], integrationSetupOnly ? [] : [runtimeId]);
  return {
    schemaVersion: 1,
    id: manifestId(`provider.${kind}`, provider.id),
    version: legacyVersion(provider.version, context),
    name: provider.name,
    description:
      kind === "integration" && "description" in provider
        ? provider.description
        : `Legacy ${provider.name} ${kind} provider compatibility manifest.`,
    ownership: FIRST_PARTY_OWNER,
    source: { kind: "built-in", package: `@chvor/server/provider-registry/${kind}` },
    mcpServers: [],
    tools,
    credentials,
    oauth: [],
    capabilities: integrationSetupOnly
      ? []
      : [
          {
            id: `capability.${kind}`,
            name: `${provider.name} ${kind}`,
            description: `Provides the legacy ${provider.name} ${kind} integration surface.`,
            toolIds: [runtimeId],
          },
        ],
    requestedAccess: providerAccess(provider, kind, providerFields, credentials),
    ...declarations,
    quality: { tier: "experimental", evidence: [] },
  };
}
export function adaptProviderDefinitions(
  options: Pick<
    IntegrationManifestResolverOptions,
    "llmProviders" | "embeddingProviders" | "integrationProviders" | "imageProviders"
  > = {}
): IntegrationManifestResolverResult {
  const result: IntegrationManifestResolverResult = { manifests: [], diagnostics: [] };
  adaptEach(options.llmProviders ?? LLM_PROVIDERS, "llm", result, (value, context) =>
    providerManifest(value, "llm", context)
  );
  adaptEach(
    options.embeddingProviders ?? EMBEDDING_PROVIDERS,
    "embedding",
    result,
    (value, context) => providerManifest(value, "embedding", context)
  );
  adaptEach(
    options.integrationProviders ?? INTEGRATION_PROVIDERS,
    "integration",
    result,
    (value, context) => providerManifest(value, "integration", context)
  );
  adaptEach(options.imageProviders ?? IMAGE_GEN_PROVIDERS, "image", result, (value, context) =>
    providerManifest(value, "image", context)
  );
  return result;
}
function oauthManifest(
  provider: LegacyVersioned<OAuthProviderDef>,
  direct: DirectOAuthProviderConfig | undefined,
  integrationProviders: readonly LegacyVersioned<IntegrationProviderDef>[],
  context: BuildContext
): IntegrationManifestV1 {
  const setupProvider =
    integrationProviders.find((item) => item.credentialType === provider.setupCredentialType) ??
    integrationProviders.find((item) => item.credentialType === "composio");
  const credentials = setupProvider
    ? providerCredential(
        setupProvider.credentialType,
        setupProvider.name,
        setupProvider.requiredFields,
        false
      )
    : [];
  const refs = credentialRefs(credentials);
  const oauth: IntegrationOauth[] = [];
  if (provider.method === "direct") {
    if (!direct) {
      warning(
        context,
        "/oauth",
        "Direct OAuth metadata was not supplied by the caller, so no OAuth declaration was joined.",
        "Pass the matching direct OAuth config explicitly; do not read client secrets or runtime flow state."
      );
    } else {
      const clientId = refs.find((ref) => ref.fieldId === "client-id");
      const clientSecret = refs.find((ref) => ref.fieldId === "client-secret");
      if (!clientId) {
        throw new Error("Direct OAuth config has no client ID credential field");
      }
      if (direct.requiresSecret && !clientSecret) {
        throw new Error("Direct OAuth config requires a client secret credential field");
      }
      oauth.push({
        id: "oauth.direct",
        mode: "direct",
        authorizationUrl: direct.authUrl,
        tokenUrl: direct.tokenUrl,
        scopes: [...direct.scopes],
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
        clientId: { ...clientId },
        ...(clientSecret ? { clientSecret: { ...clientSecret } } : {}),
      });
    }
  } else {
    oauth.push({
      id: "oauth.broker",
      mode: "broker",
      brokerUrl: "https://backend.composio.dev/api/v3",
      provider: declarationId(provider.composioToolkit ?? provider.id),
      scopes: [`provider:${provider.composioToolkit ?? provider.id}`],
    });
  }
  const runtimeId = "runtime.oauth";
  const tools: IntegrationTool[] = [
    {
      id: runtimeId,
      kind: "native",
      name: `${provider.name} OAuth connection`,
      description: provider.description,
      credentialFields: copyCredentialRefs(refs),
      ...(oauth[0] ? { oauthId: oauth[0].id } : {}),
    },
  ];
  const declarations = setupDeclarations(credentials, oauth, [runtimeId]);
  const oauthUrls = oauth.flatMap((item) =>
    item.mode === "direct" ? [item.authorizationUrl, item.tokenUrl] : [item.brokerUrl]
  );
  return {
    schemaVersion: 1,
    id: manifestId("oauth", provider.id),
    version: legacyVersion(provider.version, context),
    name: provider.name,
    description: provider.description,
    ownership: FIRST_PARTY_OWNER,
    source: { kind: "built-in", package: "@chvor/server/provider-registry/oauth" },
    mcpServers: [],
    tools,
    credentials,
    oauth,
    capabilities: [
      {
        id: "capability.oauth",
        name: `${provider.name} OAuth`,
        description: `Connect an account through the cataloged ${provider.name} OAuth flow.`,
        toolIds: [runtimeId],
      },
    ],
    requestedAccess: accessFromUrls(oauthUrls, "declared-only"),
    ...declarations,
    quality: { tier: "experimental", evidence: [] },
  };
}
export function adaptOAuthProviders(
  options: Pick<
    IntegrationManifestResolverOptions,
    "oauthProviders" | "directOAuthProviders" | "integrationProviders"
  > = {}
): IntegrationManifestResolverResult {
  const result: IntegrationManifestResolverResult = { manifests: [], diagnostics: [] };
  const direct = new Map<string, DirectOAuthProviderConfig>(
    DIRECT_OAUTH_PROVIDERS.map((item) => [item.id, item])
  );
  const suppliedDirect = options.directOAuthProviders ?? [];
  for (let index = 0; index < suppliedDirect.length; index += 1) {
    let item: DirectOAuthProviderConfig;
    try {
      item = suppliedDirect[index];
      if (typeof item.id !== "string") throw new TypeError("invalid direct OAuth provider ID");
      direct.set(item.id, item);
    } catch {
      result.diagnostics.push({
        code: "validation_failed",
        path: "/",
        message: "Direct OAuth metadata entry could not be read safely.",
        hint: "Replace the direct OAuth source entry with plain non-secret metadata.",
        severity: "error",
        sourceKind: "oauth",
        sourceId: `oauth-direct-${index}`,
      });
    }
  }
  const suppliedIntegrations: LegacyVersioned<IntegrationProviderDef>[] = [];
  const suppliedTypes = new Set<string>();
  for (const item of options.integrationProviders ?? []) {
    try {
      suppliedTypes.add(item.credentialType);
      suppliedIntegrations.push(item);
    } catch {
      // Provider adaptation emits the source-kind-specific diagnostic for this entry.
    }
  }
  const integrations = [
    ...suppliedIntegrations,
    ...INTEGRATION_PROVIDERS.filter((item) => !suppliedTypes.has(item.credentialType)),
  ];
  adaptEach(options.oauthProviders ?? OAUTH_PROVIDERS, "oauth", result, (value, context) =>
    oauthManifest(value, direct.get(value.id), integrations, context)
  );
  return result;
}
function toolCredentials(tool: Tool): IntegrationCredential[] {
  const schema = tool.metadata.credentialSchema;
  const requiredTypes = new Set(tool.metadata.requires?.credentials ?? []);
  if (tool.synthesized?.credentialType) requiredTypes.add(tool.synthesized.credentialType);
  const credentials: IntegrationCredential[] = [];
  for (const credentialType of requiredTypes) {
    const matchesSchema = schema?.type === credentialType;
    const fields = matchesSchema
      ? schema.fields
      : [{ key: "apiKey", label: "API Key", required: true }];
    credentials.push({
      id: `credential.${declarationId(credentialType)}`,
      name: matchesSchema ? schema.name : `${tool.metadata.name} credentials`,
      description: `Credential metadata required by ${tool.metadata.name}.`,
      fields: fields.map((field) => ({
        id: declarationId(field.key, "field"),
        label: field.label,
        description: field.helpText ?? `Credential field used by ${tool.metadata.name}.`,
        sensitivity:
          field.secret === true ? "secret" : knownSensitivity(field.key, field.secret === false),
        required: field.required !== false,
      })),
    });
  }
  return credentials;
}
function toolOwner(tool: Tool): IntegrationOwner {
  if (tool.source === "bundled") return FIRST_PARTY_OWNER;
  return {
    kind: "community",
    name:
      tool.metadata.author?.trim() ||
      (tool.source === "registry" ? "Registry publisher" : "Local user"),
  };
}
function toolSource(
  tool: Tool,
  version: string,
  registryUrl: string
): IntegrationManifestV1["source"] {
  if (tool.mcpServer?.transport === "synthesized") {
    return {
      kind: "synthesized",
      generator: `chvor.${declarationId(tool.synthesized?.source ?? "legacy")}`,
      generatorVersion: version,
    };
  }
  if (tool.source === "bundled") {
    return { kind: "built-in", package: `@chvor/server/bundled-tools/${tool.id}` };
  }
  if (tool.source === "registry") {
    return { kind: "registry", registryUrl, package: tool.id };
  }
  return { kind: "mcp", serverId: "server.mcp" };
}
function stdioAccess(tool: Tool, context: BuildContext): IntegrationRequestedAccess {
  warning(
    context,
    "/requestedAccess/network",
    "Legacy stdio MCP runs as the current user with unrestricted network access.",
    "The declared command is resolved through PATH; treat access as advisory until the process is sandboxed.",
    "security_violation"
  );
  warning(
    context,
    "/requestedAccess",
    "Legacy stdio MCP has broad same-user filesystem and environment access.",
    "Run the MCP process with filesystem and environment allowlists.",
    "security_violation"
  );
  return {
    network: [{ kind: "unrestricted", enforcement: "declared-only" }],
    filesystem: [{ kind: "unrestricted", access: "read-write", enforcement: "declared-only" }],
    process: [{ kind: "unknown", access: "spawn", enforcement: "declared-only" }],
    environment: [{ kind: "unrestricted", access: "read", enforcement: "declared-only" }],
  };
}
function remoteMcpUrl(tool: Tool): string {
  const url = safeHttpsEndpoint(tool.mcpServer?.url);
  if (!url) throw new Error("Remote MCP declaration has no safe HTTPS endpoint");
  return url;
}
function remoteMcpAccess(url: string): IntegrationRequestedAccess {
  const access = accessFromUrls([url], "declared-only");
  if (access.network.length === 0) throw new Error("Remote MCP tool URL is invalid");
  return access;
}
function toolCapabilities(
  tool: Tool,
  tools: readonly IntegrationTool[]
): IntegrationManifestV1["capabilities"] {
  const provided = Object.keys(tool.metadata.provides ?? {});
  if (provided.length === tools.length && provided.length > 0) {
    return provided.map((capability, index) => ({
      id: `capability.${declarationId(capability, `tool-${index}`)}`,
      name: capability,
      description: `Provides ${capability} through ${tool.metadata.name}.`,
      toolIds: [tools[index].id],
    }));
  }
  if (tools.length === 0) return [];
  return [
    {
      id: "capability.tool",
      name: tool.metadata.name,
      description: tool.metadata.description,
      toolIds: tools.map((item) => item.id),
    },
  ];
}
function mcpTools(
  tool: Tool,
  refs: IntegrationCredentialFieldRef[],
  provided: readonly (readonly [string, string])[]
): IntegrationTool[] {
  if (provided.length === 0) return [];
  return provided.map(([capability, mcpTool], index) => ({
    id: `tool.${declarationId(capability, `mcp-${index}`)}`,
    kind: "mcp" as const,
    name: `${tool.metadata.name}: ${capability}`,
    description: `Invoke ${mcpTool} through the ${tool.metadata.name} MCP server.`,
    credentialFields: copyCredentialRefs(refs),
    server: "server.mcp",
    tool: mcpTool,
  }));
}
function mcpServerDeclaration(
  tool: Tool,
  refs: IntegrationCredentialFieldRef[],
  provided: readonly (readonly [string, string])[]
) {
  const server = tool.mcpServer!;
  const operationNames = provided.map(([, operation]) => operation);
  const discovery: IntegrationManifestV1["mcpServers"][number]["discovery"] =
    operationNames.length === 0
      ? { mode: "runtime" }
      : { mode: "static", tools: [...operationNames] };
  if (server.transport === "stdio") {
    if (!server.command) throw new Error("Stdio MCP declaration has no PATH command");
    const resolvesThroughPath = !server.command.startsWith("/") && !server.command.startsWith("./");
    return {
      id: "server.mcp",
      transport: "stdio" as const,
      // The manifest schema requires an executable path. `/usr/bin/env <command>`
      // truthfully preserves legacy PATH resolution instead of pretending the
      // bare command lives in the working directory.
      command: resolvesThroughPath ? "/usr/bin/env" : server.command,
      ...(resolvesThroughPath
        ? { args: [server.command, ...(server.args ?? [])] }
        : server.args
          ? { args: [...server.args] }
          : {}),
      credentialFields: copyCredentialRefs(refs),
      discovery,
    };
  }
  if (server.transport === "synthesized") {
    throw new Error("Synthesized HTTP runtime is not an MCP server");
  }
  return {
    id: "server.mcp",
    transport: server.transport,
    url: remoteMcpUrl(tool),
    credentialFields: copyCredentialRefs(refs),
    discovery,
  };
}
function synthesizedTools(
  tool: Tool,
  refs: IntegrationCredentialFieldRef[]
): {
  tools: IntegrationTool[];
  access: IntegrationRequestedAccess;
} {
  const tools = (tool.endpoints ?? []).map((endpoint, index) => ({
    id: `tool.${declarationId(endpoint.name, `endpoint-${index}`)}`,
    kind: "native" as const,
    name: `${tool.metadata.name}: ${endpoint.name}`,
    description: `${endpoint.description} Runtime operation: ${endpoint.method} ${endpoint.path}.`,
    credentialFields: copyCredentialRefs(refs),
  }));
  if (tools.length === 0) throw new Error("Synthesized tool has no endpoints");
  const destination = credentialsUrlRef(tool, refs);
  const access: IntegrationRequestedAccess = {
    ...EMPTY_ACCESS,
    network: destination
      ? [
          {
            kind: "credential-derived",
            credentialField: { ...destination },
            protocols: ["https"],
            enforcement: "runtime-enforced",
          },
        ]
      : [{ kind: "unknown", enforcement: "runtime-enforced" }],
  };
  return { tools, access };
}

function nativeTools(
  tool: Tool,
  refs: readonly IntegrationCredentialFieldRef[],
  bindings: readonly NativeToolBinding[]
): IntegrationTool[] {
  return bindings
    .filter((binding) => binding.capabilityId === tool.id)
    .map((binding, index) => ({
      id: `tool.${declarationId(binding.operation, `native-${index}`)}`,
      kind: "native" as const,
      name: binding.operation,
      description: `Invoke the ${binding.operation} native runtime operation for ${tool.metadata.name}.`,
      credentialFields: copyCredentialRefs(refs),
    }));
}

function nativeToolAccess(context: BuildContext): IntegrationRequestedAccess {
  warning(
    context,
    "/requestedAccess",
    "Legacy native tool metadata does not describe its complete runtime access.",
    "Treat each access category as advisory and unknown until the native module publishes explicit policy metadata.",
    "security_violation"
  );
  return {
    network: [{ kind: "unknown", enforcement: "declared-only" }],
    filesystem: [
      { kind: "unknown", access: "read-write", enforcement: "declared-only" },
    ],
    process: [{ kind: "unknown", access: "spawn", enforcement: "declared-only" }],
    environment: [{ kind: "unknown", access: "read", enforcement: "declared-only" }],
  };
}

function mergeRequestedAccess(
  first: IntegrationRequestedAccess,
  second: IntegrationRequestedAccess
): IntegrationRequestedAccess {
  return {
    network: [...first.network, ...second.network],
    filesystem: [...first.filesystem, ...second.filesystem],
    process: [...first.process, ...second.process],
    environment: [...first.environment, ...second.environment],
  };
}
function credentialsUrlRef(
  tool: Tool,
  refs: readonly IntegrationCredentialFieldRef[]
): IntegrationCredentialFieldRef | undefined {
  const schema = tool.metadata.credentialSchema;
  if (!schema) return undefined;
  const urlField = schema.fields.find(
    (field) =>
      field.secret !== true && knownSensitivity(field.key, field.secret === false) === "url"
  );
  if (!urlField) return undefined;
  const fieldId = declarationId(urlField.key, "field");
  return refs.find(
    (ref) =>
      ref.credentialId === `credential.${declarationId(schema.type)}` && ref.fieldId === fieldId
  );
}
function activeToolManifest(
  tool: Tool,
  context: BuildContext,
  registryUrl: string,
  nativeToolBindings: readonly NativeToolBinding[]
): IntegrationManifestV1 | typeof SKIP_SOURCE {
  const metadata = tool.metadata;
  if (!metadata || typeof metadata.name !== "string" || typeof metadata.description !== "string") {
    throw new Error("Active Tool metadata is incomplete");
  }
  const version = legacyVersion(tool.metadata.version, context);
  const credentials = toolCredentials(tool);
  const refs = credentialRefs(credentials);
  const boundNativeTools = nativeTools(tool, refs, nativeToolBindings);
  const boundNativeAccess =
    boundNativeTools.length > 0 ? nativeToolAccess(context) : EMPTY_ACCESS;
  const synthesized = tool.mcpServer?.transport === "synthesized";
  const declaration = !tool.mcpServer
    ? (() => {
        if (boundNativeTools.length === 0) {
          warning(
            context,
            "/tools",
            "Tool metadata has no MCP, synthesized, or native runtime binding and was omitted.",
            "Add an executable runtime binding or publish this metadata as a skill instead of a tool."
          );
          return SKIP_SOURCE;
        }
        return { tools: boundNativeTools, mcpServers: [], access: boundNativeAccess };
      })()
    : synthesized
      ? (() => {
          const synthesizedDeclaration = synthesizedTools(tool, refs);
          return {
            tools: [...synthesizedDeclaration.tools, ...boundNativeTools],
            mcpServers: [],
            access: mergeRequestedAccess(synthesizedDeclaration.access, boundNativeAccess),
          };
        })()
      : (() => {
        const provided = Object.entries(tool.metadata.provides ?? {});
        const server = mcpServerDeclaration(tool, refs, provided);
        const serverAccess =
          tool.mcpServer!.transport === "stdio"
            ? stdioAccess(tool, context)
            : remoteMcpAccess(server.transport === "stdio" ? "" : server.url);
        return {
          mcpServers: [server],
          tools: [...mcpTools(tool, refs, provided), ...boundNativeTools],
          access: mergeRequestedAccess(serverAccess, boundNativeAccess),
        };
        })();
  if (declaration === SKIP_SOURCE) return SKIP_SOURCE;
  const toolIds = declaration.tools.map((item) => item.id);
  const capabilities = toolCapabilities(tool, declaration.tools);
  const declarations = setupDeclarations(credentials, [], toolIds);
  const rawSpecUrl = synthesized ? tool.synthesized?.specUrl : undefined;
  const specUrl = safeHttpsEndpoint(rawSpecUrl);
  if (rawSpecUrl !== undefined && specUrl === undefined) {
    warning(
      context,
      "/quality/evidence",
      "Synthesized specification evidence URL was omitted because it is not a safe HTTPS reference.",
      "Use an HTTPS specification URL without userinfo, query parameters, or a fragment.",
      "security_violation"
    );
  }
  const evidence =
    synthesized && tool.synthesized?.source === "openapi" && tool.synthesized.verified && specUrl
      ? [
          {
            criterion: "typed-schemas" as const,
            verification: "automated" as const,
            reference: specUrl,
          },
        ]
      : [];
  return {
    schemaVersion: 1,
    id: manifestId("tool", tool.id),
    version,
    name: tool.metadata.name,
    description: tool.metadata.description,
    ownership: toolOwner(tool),
    source: toolSource(tool, version, registryUrl),
    mcpServers: declaration.mcpServers,
    tools: declaration.tools,
    credentials,
    oauth: [],
    capabilities,
    requestedAccess: declaration.access,
    ...declarations,
    quality: { tier: "experimental", evidence },
  };
}
export function adaptActiveTools(
  options: Pick<
    IntegrationManifestResolverOptions,
    "tools" | "nativeToolBindings" | "registryUrl"
  > = {}
): IntegrationManifestResolverResult {
  const result: IntegrationManifestResolverResult = { manifests: [], diagnostics: [] };
  const registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
  adaptEach(options.tools ?? [], "tool", result, (value, context) =>
    activeToolManifest(value, context, registryUrl, options.nativeToolBindings ?? [])
  );
  return result;
}
export function resolveIntegrationManifests(
  options: IntegrationManifestResolverOptions = {}
): IntegrationManifestResolverResult {
  const providerResult = adaptProviderDefinitions(options);
  const oauthResult = adaptOAuthProviders(options);
  const toolResult = adaptActiveTools(options);
  return {
    manifests: [...providerResult.manifests, ...oauthResult.manifests, ...toolResult.manifests],
    diagnostics: [
      ...providerResult.diagnostics,
      ...oauthResult.diagnostics,
      ...toolResult.diagnostics,
    ],
  };
}
