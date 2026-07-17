import { z } from "zod";

/** Versioned integration-manifest compatibility boundary. */
export const INTEGRATION_MANIFEST_V1_SCHEMA_VERSION = 1 as const;
export const INTEGRATION_MANIFEST_V2_SCHEMA_VERSION = 2 as const;
export const INTEGRATION_MANIFEST_SCHEMA_VERSION = INTEGRATION_MANIFEST_V2_SCHEMA_VERSION;
export const INTEGRATION_MANIFEST_MIN_SCHEMA_VERSION = 1 as const;
export const INTEGRATION_MANIFEST_MAX_SCHEMA_VERSION = 2 as const;
export const SUPPORTED_INTEGRATION_MANIFEST_SCHEMA_VERSIONS = [1, 2] as const;
export const INTEGRATION_MANIFEST_SUPPORTED_SCHEMA_VERSIONS =
  SUPPORTED_INTEGRATION_MANIFEST_SCHEMA_VERSIONS;
export const INTEGRATION_MANIFEST_SUPPORTED_VERSIONS =
  SUPPORTED_INTEGRATION_MANIFEST_SCHEMA_VERSIONS;
export const INTEGRATION_MANIFEST_COMPATIBILITY = Object.freeze({
  current: INTEGRATION_MANIFEST_SCHEMA_VERSION,
  minimum: INTEGRATION_MANIFEST_MIN_SCHEMA_VERSION,
  maximum: INTEGRATION_MANIFEST_MAX_SCHEMA_VERSION,
  supported: SUPPORTED_INTEGRATION_MANIFEST_SCHEMA_VERSIONS,
});

export const INTEGRATION_MANIFEST_LIMITS = Object.freeze({
  id: 128,
  semver: 64,
  name: 200,
  description: 2_000,
  reference: 1_024,
  mcpOperationName: 256,
  items: 256,
  fields: 128,
  scopes: 128,
  inputDepth: 32,
  inputNodes: 20_000,
});

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?:[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const CREDENTIAL_STORAGE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;
const HOST_PATTERN =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PARAMETER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.~-]{0,127}$/;
/**
 * Static OAuth parameter values are safe to publish only for this deliberately
 * small set of protocol/provider switches. Unknown names fail closed: secrets
 * and credential-like extensions must be represented by credential references.
 */
const SAFE_STATIC_OAUTH_PARAMETER_NAMES = new Set([
  "access_type",
  "audience",
  "duration",
  "grant_type",
  "prompt",
  "resource",
]);
const UNSAFE_CREDENTIAL_STORAGE_KEYS = new Set([
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "prototype",
  "toLocaleString",
  "toString",
  "valueOf",
]);
const HTTP_PATH_VALIDATION_BASE = new URL("https://integration-manifest.invalid/");

export const integrationManifestIdSchema = z
  .string()
  .min(1)
  .max(INTEGRATION_MANIFEST_LIMITS.id)
  .regex(ID_PATTERN, "ID must be lowercase and use bounded dot, dash, or underscore segments");
export const integrationManifestSemverSchema = z
  .string()
  .min(5)
  .max(INTEGRATION_MANIFEST_LIMITS.semver)
  .regex(SEMVER_PATTERN, "version must be strict semantic versioning");
export const integrationMcpOperationNameSchema = z
  .string()
  .min(1)
  .max(INTEGRATION_MANIFEST_LIMITS.mcpOperationName);

const nameSchema = z.string().trim().min(1).max(INTEGRATION_MANIFEST_LIMITS.name);
const descriptionSchema = z.string().trim().min(1).max(INTEGRATION_MANIFEST_LIMITS.description);
const referenceSchema = z.string().trim().min(1).max(INTEGRATION_MANIFEST_LIMITS.reference);
const pathSchema = referenceSchema.refine(
  (value) => !value.includes("\0") && (value.startsWith("/") || value.startsWith("./")),
  "path must be absolute or explicitly relative and contain no NUL bytes"
);

function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

const httpsUrlSchema = z
  .string()
  .max(INTEGRATION_MANIFEST_LIMITS.reference)
  .url()
  .refine(isSecureUrl, "URL must use HTTPS and must not embed credentials or a fragment");
const endpointUrlSchema = httpsUrlSchema.refine(
  (value) => new URL(value).search === "",
  "endpoint URL must not contain query values"
);

function preservesHttpPathOrigin(value: string): boolean {
  try {
    return new URL(value, HTTP_PATH_VALIDATION_BASE).origin === HTTP_PATH_VALIDATION_BASE.origin;
  } catch {
    return false;
  }
}

function preservesDeclaredHttpOrigin(baseUrl: string, path: string): boolean {
  try {
    return new URL(path, baseUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export const integrationOwnerSchema = z
  .object({
    kind: z.enum(["first-party", "partner", "community"]),
    name: nameSchema,
    contact: z.string().email().max(320).optional(),
    url: httpsUrlSchema.optional(),
  })
  .strict();

const builtInSourceSchema = z
  .object({ kind: z.literal("built-in"), package: referenceSchema })
  .strict();
const registrySourceSchema = z
  .object({ kind: z.literal("registry"), registryUrl: endpointUrlSchema, package: referenceSchema })
  .strict();
const mcpSourceSchema = z
  .object({ kind: z.literal("mcp"), serverId: integrationManifestIdSchema })
  .strict();
const synthesizedSourceSchema = z
  .object({
    kind: z.literal("synthesized"),
    generator: integrationManifestIdSchema,
    generatorVersion: integrationManifestSemverSchema,
  })
  .strict();
export const integrationSourceSchema = z.discriminatedUnion("kind", [
  builtInSourceSchema,
  registrySourceSchema,
  mcpSourceSchema,
  synthesizedSourceSchema,
]);

export const integrationCredentialSensitivitySchema = z.enum(["secret", "text", "url", "path"]);
export const integrationCredentialStorageKeySchema = z
  .string()
  .min(1)
  .max(INTEGRATION_MANIFEST_LIMITS.id)
  .regex(
    CREDENTIAL_STORAGE_KEY_PATTERN,
    "storage key must use bounded alphanumeric dot, dash, or underscore segments"
  )
  .refine(
    (value) => !UNSAFE_CREDENTIAL_STORAGE_KEYS.has(value),
    "storage key must not shadow an unsafe object property"
  );
const credentialFieldV1Base = {
  id: integrationManifestIdSchema,
  label: nameSchema,
  description: descriptionSchema,
  required: z.boolean(),
};
const credentialFieldV2Base = {
  ...credentialFieldV1Base,
  storageKey: integrationCredentialStorageKeySchema.optional(),
};
function credentialFieldSchemas<T extends z.ZodRawShape>(base: T) {
  const secret = z
    .object({
      ...base,
      sensitivity: z.literal("secret"),
      default: z.never().optional(),
    })
    .strict();
  const text = z
    .object({
      ...base,
      sensitivity: z.literal("text"),
      default: z.string().max(INTEGRATION_MANIFEST_LIMITS.reference).optional(),
    })
    .strict();
  const url = z
    .object({
      ...base,
      sensitivity: z.literal("url"),
      default: httpsUrlSchema.optional(),
    })
    .strict();
  const path = z
    .object({
      ...base,
      sensitivity: z.literal("path"),
      default: pathSchema.optional(),
    })
    .strict();
  return z.discriminatedUnion("sensitivity", [secret, text, url, path]);
}

export const integrationCredentialFieldV1Schema = credentialFieldSchemas(credentialFieldV1Base);
export const integrationCredentialFieldV2Schema = credentialFieldSchemas(credentialFieldV2Base);
/** Backward-compatible unversioned alias for the original V1 field contract. */
export const integrationCredentialFieldSchema = integrationCredentialFieldV1Schema;
export const currentIntegrationCredentialFieldSchema = integrationCredentialFieldV2Schema;

function credentialSchema<T extends z.ZodTypeAny>(fieldSchema: T) {
  return z
    .object({
      id: integrationManifestIdSchema,
      name: nameSchema,
      description: descriptionSchema,
      fields: z.array(fieldSchema).min(1).max(INTEGRATION_MANIFEST_LIMITS.fields),
    })
    .strict();
}

export const integrationCredentialV1Schema = credentialSchema(integrationCredentialFieldV1Schema);
export const integrationCredentialV2Schema = credentialSchema(
  integrationCredentialFieldV2Schema
).superRefine((credential, context) => {
  const seen = new Set<string>();
  credential.fields.forEach((field, index) => {
    const effectiveStorageKey = field.storageKey ?? field.id;
    if (!integrationCredentialStorageKeySchema.safeParse(effectiveStorageKey).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields", index, field.storageKey === undefined ? "id" : "storageKey"],
        message: "Effective credential storage key is unsafe.",
        params: {
          code: "security_violation",
          hint: "Use a non-reserved alphanumeric storage key with bounded dot, dash, or underscore segments.",
        },
      });
    }
    if (seen.has(effectiveStorageKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields", index, field.storageKey === undefined ? "id" : "storageKey"],
        message: "Effective credential storage key must be unique within a credential.",
        params: {
          code: "duplicate_id",
          hint: "Choose a unique storageKey, or omit it when the normalized field ID is the runtime key.",
        },
      });
    }
    seen.add(effectiveStorageKey);
  });
});
/** Backward-compatible unversioned alias for the original V1 component contract. */
export const integrationCredentialSchema = integrationCredentialV1Schema;
export const currentIntegrationCredentialSchema = integrationCredentialV2Schema;
export const integrationCredentialFieldRefSchema = z
  .object({ credentialId: integrationManifestIdSchema, fieldId: integrationManifestIdSchema })
  .strict();

const credentialRefsSchema = z
  .array(integrationCredentialFieldRefSchema)
  .max(INTEGRATION_MANIFEST_LIMITS.fields);
const toolCommonShape = {
  id: integrationManifestIdSchema,
  name: nameSchema,
  description: descriptionSchema,
  credentialFields: credentialRefsSchema,
  oauthId: integrationManifestIdSchema.optional(),
};
const nativeToolSchema = z.object({ ...toolCommonShape, kind: z.literal("native") }).strict();
const mcpToolSchema = z
  .object({
    ...toolCommonShape,
    kind: z.literal("mcp"),
    server: integrationManifestIdSchema,
    tool: integrationMcpOperationNameSchema,
  })
  .strict();
const httpToolSchema = z
  .object({
    ...toolCommonShape,
    kind: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    baseUrl: endpointUrlSchema,
    path: z
      .string()
      .min(1)
      .max(INTEGRATION_MANIFEST_LIMITS.reference)
      .regex(/^\/(?!\/)[^\s\0]*$/, "HTTP path must be a relative URL path")
      .refine(
        (value) => !value.includes("?") && !value.includes("#"),
        "HTTP path must not contain a query or fragment"
      )
      .refine(
        (value) => !value.includes("\\") && !/%5c/i.test(value),
        "HTTP path must not contain literal or percent-encoded backslashes"
      )
      .refine(
        preservesHttpPathOrigin,
        "HTTP path resolution must preserve the declared base URL origin"
      ),
  })
  .strict();
export const integrationToolSchema = z.discriminatedUnion("kind", [
  nativeToolSchema,
  mcpToolSchema,
  httpToolSchema,
]);

const runtimeDiscoverySchema = z.object({ mode: z.literal("runtime") }).strict();
const staticDiscoverySchema = z
  .object({
    mode: z.literal("static"),
    tools: z.array(integrationMcpOperationNameSchema).min(1).max(INTEGRATION_MANIFEST_LIMITS.items),
  })
  .strict();
export const integrationMcpDiscoverySchema = z.discriminatedUnion("mode", [
  runtimeDiscoverySchema,
  staticDiscoverySchema,
]);
const mcpServerCommonShape = {
  id: integrationManifestIdSchema,
  credentialFields: credentialRefsSchema,
  discovery: integrationMcpDiscoverySchema,
};
const stdioMcpServerSchema = z
  .object({
    ...mcpServerCommonShape,
    transport: z.literal("stdio"),
    command: pathSchema,
    args: z.array(referenceSchema).max(INTEGRATION_MANIFEST_LIMITS.fields).optional(),
  })
  .strict();
const remoteMcpServerSchema = z
  .object({
    ...mcpServerCommonShape,
    transport: z.enum(["http", "sse"]),
    url: endpointUrlSchema,
  })
  .strict();
export const integrationMcpServerSchema = z.discriminatedUnion("transport", [
  stdioMcpServerSchema,
  remoteMcpServerSchema,
]);

function isSafeStaticOauthParameterName(value: string): boolean {
  return SAFE_STATIC_OAUTH_PARAMETER_NAMES.has(value);
}

const oauthParameterDataSchema = z
  .object({
    name: z.string().min(1).max(128).regex(PARAMETER_NAME_PATTERN),
    value: z.string().max(INTEGRATION_MANIFEST_LIMITS.reference),
  })
  .strict();
const oauthParameterNameGuardSchema = z.unknown().transform((parameter, context) => {
  const nameDescriptor =
    parameter !== null && typeof parameter === "object"
      ? Object.getOwnPropertyDescriptor(parameter, "name")
      : undefined;
  if (
    nameDescriptor &&
    "value" in nameDescriptor &&
    typeof nameDescriptor.value === "string" &&
    !isSafeStaticOauthParameterName(nameDescriptor.value)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: "Static OAuth parameter name is not in the non-secret allowlist.",
      params: {
        code: "security_violation",
        hint: "Reference credentials through declared credential fields instead of static OAuth parameter values.",
      },
    });
    return z.NEVER;
  }
  return parameter;
});
const oauthParameterSchema = oauthParameterNameGuardSchema.pipe(oauthParameterDataSchema);
const oauthCommonShape = {
  id: integrationManifestIdSchema,
  scopes: z.array(referenceSchema).min(1).max(INTEGRATION_MANIFEST_LIMITS.scopes),
};
const directOauthV1Schema = z
  .object({
    ...oauthCommonShape,
    mode: z.literal("direct"),
    authorizationUrl: endpointUrlSchema,
    tokenUrl: endpointUrlSchema,
    authorizationParams: z
      .array(oauthParameterSchema)
      .max(INTEGRATION_MANIFEST_LIMITS.fields)
      .optional(),
    tokenParams: z.array(oauthParameterSchema).max(INTEGRATION_MANIFEST_LIMITS.fields).optional(),
    clientId: integrationCredentialFieldRefSchema,
    clientSecret: integrationCredentialFieldRefSchema.optional(),
  })
  .strict();
const directOauthV2Schema = z
  .object({
    ...oauthCommonShape,
    mode: z.literal("direct"),
    provider: integrationManifestIdSchema,
    authorizationUrl: endpointUrlSchema,
    tokenUrl: endpointUrlSchema,
    authorizationParams: z
      .array(oauthParameterSchema)
      .max(INTEGRATION_MANIFEST_LIMITS.fields)
      .optional(),
    tokenParams: z.array(oauthParameterSchema).max(INTEGRATION_MANIFEST_LIMITS.fields).optional(),
    clientId: integrationCredentialFieldRefSchema,
    clientSecret: integrationCredentialFieldRefSchema.optional(),
  })
  .strict();
const brokerOauthSchema = z
  .object({
    ...oauthCommonShape,
    mode: z.literal("broker"),
    brokerUrl: endpointUrlSchema,
    provider: integrationManifestIdSchema,
  })
  .strict();
export const integrationOauthV1Schema = z.discriminatedUnion("mode", [
  directOauthV1Schema,
  brokerOauthSchema,
]);
export const integrationOauthV2Schema = z.discriminatedUnion("mode", [
  directOauthV2Schema,
  brokerOauthSchema,
]);
/** Backward-compatible unversioned alias for the original V1 component contract. */
export const integrationOauthSchema = integrationOauthV1Schema;
export const currentIntegrationOauthSchema = integrationOauthV2Schema;

export const integrationCapabilitySchema = z
  .object({
    id: integrationManifestIdSchema,
    name: nameSchema,
    description: descriptionSchema,
    toolIds: z.array(integrationManifestIdSchema).min(1).max(INTEGRATION_MANIFEST_LIMITS.items),
  })
  .strict();

export const integrationAccessEnforcementSchema = z.enum([
  "sandbox-enforced",
  "runtime-enforced",
  "approval-gated",
  "declared-only",
]);
const enforcementShape = { enforcement: integrationAccessEnforcementSchema };
const networkHostAccessSchema = z
  .object({
    ...enforcementShape,
    kind: z.literal("host").optional(),
    host: z.string().min(1).max(253).regex(HOST_PATTERN, "invalid network host pattern"),
    protocol: z.enum(["https", "wss", "tcp"]),
    ports: z.array(z.number().int().min(1).max(65_535)).min(1).max(64),
  })
  .strict();
const networkUnknownAccessSchema = z
  .object({ ...enforcementShape, kind: z.literal("unknown") })
  .strict();
const networkUnrestrictedAccessSchema = z
  .object({ ...enforcementShape, kind: z.literal("unrestricted") })
  .strict();
const networkCredentialAccessSchema = z
  .object({
    ...enforcementShape,
    kind: z.literal("credential-derived"),
    credentialField: integrationCredentialFieldRefSchema,
    protocols: z
      .array(z.enum(["https", "wss", "tcp"]))
      .min(1)
      .max(3),
  })
  .strict();
export const integrationNetworkAccessSchema = z.union([
  networkHostAccessSchema,
  networkUnknownAccessSchema,
  networkUnrestrictedAccessSchema,
  networkCredentialAccessSchema,
]);
const filesystemPathAccessSchema = z
  .object({
    ...enforcementShape,
    kind: z.literal("path").optional(),
    path: pathSchema,
    access: z.enum(["read", "write", "read-write"]),
  })
  .strict();
const filesystemUnknownAccessSchema = z
  .object({
    ...enforcementShape,
    kind: z.enum(["unknown", "unrestricted"]),
    access: z.enum(["read", "write", "read-write"]),
  })
  .strict();
const filesystemCredentialAccessSchema = z
  .object({
    ...enforcementShape,
    kind: z.literal("credential-derived"),
    credentialField: integrationCredentialFieldRefSchema,
    access: z.enum(["read", "write", "read-write"]),
  })
  .strict();
export const integrationFilesystemAccessSchema = z.union([
  filesystemPathAccessSchema,
  filesystemUnknownAccessSchema,
  filesystemCredentialAccessSchema,
]);
const processExecutableAccessSchema = z
  .object({
    ...enforcementShape,
    kind: z.literal("executable").optional(),
    executable: pathSchema,
    access: z.enum(["spawn", "signal"]),
  })
  .strict();
const processBroadAccessSchema = z
  .object({
    ...enforcementShape,
    kind: z.enum(["unknown", "unrestricted"]),
    access: z.enum(["spawn", "signal"]),
  })
  .strict();
export const integrationProcessAccessSchema = z.union([
  processExecutableAccessSchema,
  processBroadAccessSchema,
]);
const environmentVariableAccessSchema = z
  .object({
    ...enforcementShape,
    kind: z.literal("variable").optional(),
    variable: z.string().min(1).max(128).regex(ENVIRONMENT_NAME_PATTERN),
    access: z.enum(["read", "write"]),
  })
  .strict();
const environmentBroadAccessSchema = z
  .object({
    ...enforcementShape,
    kind: z.enum(["unknown", "unrestricted"]),
    access: z.enum(["read", "write"]),
  })
  .strict();
const environmentCredentialAccessSchema = z
  .object({
    ...enforcementShape,
    kind: z.literal("credential-derived"),
    credentialField: integrationCredentialFieldRefSchema,
    access: z.literal("read"),
  })
  .strict();
export const integrationEnvironmentAccessSchema = z.union([
  environmentVariableAccessSchema,
  environmentBroadAccessSchema,
  environmentCredentialAccessSchema,
]);
export const integrationRequestedAccessSchema = z
  .object({
    network: z.array(integrationNetworkAccessSchema).max(INTEGRATION_MANIFEST_LIMITS.items),
    filesystem: z.array(integrationFilesystemAccessSchema).max(INTEGRATION_MANIFEST_LIMITS.items),
    process: z.array(integrationProcessAccessSchema).max(INTEGRATION_MANIFEST_LIMITS.items),
    environment: z.array(integrationEnvironmentAccessSchema).max(INTEGRATION_MANIFEST_LIMITS.items),
  })
  .strict();

const setupCommonShape = { id: integrationManifestIdSchema, title: nameSchema };
const instructionSetupSchema = z
  .object({ ...setupCommonShape, kind: z.literal("instruction"), instructions: descriptionSchema })
  .strict();
const credentialSetupSchema = z
  .object({
    ...setupCommonShape,
    kind: z.literal("credential"),
    credentialId: integrationManifestIdSchema,
  })
  .strict();
const oauthSetupSchema = z
  .object({ ...setupCommonShape, kind: z.literal("oauth"), oauthId: integrationManifestIdSchema })
  .strict();
const diagnosticSetupSchema = z
  .object({
    ...setupCommonShape,
    kind: z.literal("diagnostic"),
    checkId: integrationManifestIdSchema,
  })
  .strict();
export const integrationSetupStepSchema = z.discriminatedUnion("kind", [
  instructionSetupSchema,
  credentialSetupSchema,
  oauthSetupSchema,
  diagnosticSetupSchema,
]);

const diagnosticCommonShape = {
  id: integrationManifestIdSchema,
  name: nameSchema,
  description: descriptionSchema,
};
const toolDiagnosticSchema = z
  .object({
    ...diagnosticCommonShape,
    kind: z.literal("tool"),
    toolId: integrationManifestIdSchema,
  })
  .strict();
const httpDiagnosticSchema = z
  .object({
    ...diagnosticCommonShape,
    kind: z.literal("http"),
    url: endpointUrlSchema,
    method: z.enum(["GET", "HEAD"]),
    expectedStatus: z.number().int().min(100).max(599),
    credentialFields: credentialRefsSchema,
  })
  .strict();
const credentialDiagnosticSchema = z
  .object({
    ...diagnosticCommonShape,
    kind: z.literal("credential"),
    credentialField: integrationCredentialFieldRefSchema,
  })
  .strict();
export const integrationDiagnosticCheckSchema = z.discriminatedUnion("kind", [
  toolDiagnosticSchema,
  httpDiagnosticSchema,
  credentialDiagnosticSchema,
]);

export const integrationQualityTierSchema = z.enum([
  "experimental",
  "bronze",
  "silver",
  "gold",
  "platinum",
]);
export const integrationQualityCriterionSchema = z.enum([
  "typed-schemas",
  "credential-setup",
  "basic-tests",
  "token-refresh",
  "retries",
  "redaction",
  "diagnostics",
  "reauthentication",
  "pagination",
  "rate-limit-handling",
  "idempotency",
  "integration-tests",
  "sandboxed",
  "observable",
  "documented",
  "maintained",
  "backup-safe",
  "migration-safe",
]);
export const integrationQualityEvidenceSchema = z
  .object({
    criterion: integrationQualityCriterionSchema,
    verification: z.enum(["self-attested", "automated", "reviewed"]),
    reference: referenceSchema,
    reviewer: nameSchema.optional(),
    verifiedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const reviewed = evidence.verification === "reviewed";
    const hasReviewer = evidence.reviewer !== undefined;
    const hasVerifiedAt = evidence.verifiedAt !== undefined;
    if (
      (reviewed && (!hasReviewer || !hasVerifiedAt)) ||
      (!reviewed && (hasReviewer || hasVerifiedAt))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: reviewed
          ? "reviewed evidence requires reviewer and verifiedAt"
          : "review metadata is only valid for reviewed evidence",
      });
    }
  });
export const integrationQualitySchema = z
  .object({
    tier: integrationQualityTierSchema,
    evidence: z.array(integrationQualityEvidenceSchema).max(INTEGRATION_MANIFEST_LIMITS.items),
  })
  .strict();

export const integrationManifestDiagnosticCodeSchema = z.enum([
  "unsupported_schema_version",
  "missing_required_field",
  "invalid_type",
  "invalid_value",
  "invalid_enum",
  "unknown_field",
  "duplicate_id",
  "duplicate_reference",
  "invalid_reference",
  "security_violation",
  "missing_quality_evidence",
  "validation_failed",
]);
export const integrationManifestDiagnosticSchema = z
  .object({
    code: integrationManifestDiagnosticCodeSchema,
    path: z.string().min(1).max(512),
    message: z.string().min(1).max(512),
    hint: z.string().min(1).max(512),
  })
  .strict();
export type IntegrationManifestDiagnosticCode = z.infer<
  typeof integrationManifestDiagnosticCodeSchema
>;

function manifestIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  code: IntegrationManifestDiagnosticCode,
  message: string,
  hint: string
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message, params: { code, hint } });
}

function duplicateIndexes(values: string[]): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  values.forEach((value, index) => (seen.has(value) ? duplicates.push(index) : seen.add(value)));
  return duplicates;
}

function refKey(ref: z.infer<typeof integrationCredentialFieldRefSchema>): string {
  return `${ref.credentialId}:${ref.fieldId}`;
}

const integrationManifestCommonShape = {
  id: integrationManifestIdSchema,
  version: integrationManifestSemverSchema,
  name: nameSchema,
  description: descriptionSchema,
  ownership: integrationOwnerSchema,
  source: integrationSourceSchema,
  mcpServers: z.array(integrationMcpServerSchema).max(INTEGRATION_MANIFEST_LIMITS.items),
  tools: z.array(integrationToolSchema).max(INTEGRATION_MANIFEST_LIMITS.items),
  capabilities: z.array(integrationCapabilitySchema).max(INTEGRATION_MANIFEST_LIMITS.items),
  requestedAccess: integrationRequestedAccessSchema,
  setup: z.array(integrationSetupStepSchema).max(INTEGRATION_MANIFEST_LIMITS.items),
  diagnostics: z.array(integrationDiagnosticCheckSchema).max(INTEGRATION_MANIFEST_LIMITS.items),
  quality: integrationQualitySchema,
};

const integrationManifestV1BaseSchema = z
  .object({
    schemaVersion: z.literal(INTEGRATION_MANIFEST_V1_SCHEMA_VERSION),
    ...integrationManifestCommonShape,
    credentials: z.array(integrationCredentialV1Schema).max(INTEGRATION_MANIFEST_LIMITS.items),
    oauth: z.array(integrationOauthV1Schema).max(INTEGRATION_MANIFEST_LIMITS.items),
  })
  .strict();
const integrationManifestV2BaseSchema = z
  .object({
    schemaVersion: z.literal(INTEGRATION_MANIFEST_V2_SCHEMA_VERSION),
    ...integrationManifestCommonShape,
    credentials: z.array(integrationCredentialV2Schema).max(INTEGRATION_MANIFEST_LIMITS.items),
    oauth: z.array(integrationOauthV2Schema).max(INTEGRATION_MANIFEST_LIMITS.items),
  })
  .strict();

type ManifestData =
  | z.infer<typeof integrationManifestV1BaseSchema>
  | z.infer<typeof integrationManifestV2BaseSchema>;
type CredentialField = z.infer<typeof integrationCredentialFieldSchema>;
type CredentialRef = z.infer<typeof integrationCredentialFieldRefSchema>;

function hostMatches(pattern: string, host: string): boolean {
  return (
    pattern === host ||
    (pattern.startsWith("*.") && host.endsWith(pattern.slice(1)) && host !== pattern.slice(2))
  );
}

function urlHasDeclaredAccess(manifest: ManifestData, value: string): boolean {
  const url = new URL(value);
  const port = Number(url.port || "443");
  return manifest.requestedAccess.network.some(
    (entry) =>
      entry.kind === "unrestricted" ||
      ("host" in entry &&
        entry.protocol === "https" &&
        entry.ports.includes(port) &&
        hostMatches(entry.host, url.hostname.toLowerCase()))
  );
}

function validateManifestSemantics(manifest: ManifestData, context: z.RefinementCtx): void {
  const collections = [
    ["mcpServers", manifest.mcpServers],
    ["tools", manifest.tools],
    ["credentials", manifest.credentials],
    ["oauth", manifest.oauth],
    ["capabilities", manifest.capabilities],
    ["setup", manifest.setup],
    ["diagnostics", manifest.diagnostics],
  ] as const;
  const globalIds = new Map<string, string>();
  for (const [collection, entries] of collections) {
    for (const index of duplicateIndexes(entries.map((entry) => entry.id))) {
      manifestIssue(
        context,
        [collection, index, "id"],
        "duplicate_id",
        `Duplicate ${collection} ID.`,
        "Use a unique ID for every declaration."
      );
    }
    entries.forEach((entry, index) => {
      const previous = globalIds.get(entry.id);
      if (previous !== undefined && previous !== collection) {
        manifestIssue(
          context,
          [collection, index, "id"],
          "duplicate_id",
          "ID is already used by another declaration.",
          "Use globally unique declaration IDs."
        );
      } else globalIds.set(entry.id, collection);
    });
  }

  const credentials = new Map<string, Map<string, CredentialField>>(
    manifest.credentials.map((credential) => [
      credential.id,
      new Map(credential.fields.map((field) => [field.id, field])),
    ])
  );
  manifest.credentials.forEach((credential, credentialIndex) => {
    for (const index of duplicateIndexes(credential.fields.map((field) => field.id))) {
      manifestIssue(
        context,
        ["credentials", credentialIndex, "fields", index, "id"],
        "duplicate_id",
        "Duplicate credential field ID.",
        "Use a unique field ID within each credential."
      );
    }
  });
  const checkCredentialRef = (
    ref: CredentialRef,
    path: (string | number)[]
  ): CredentialField | undefined => {
    const field = credentials.get(ref.credentialId)?.get(ref.fieldId);
    if (!field)
      manifestIssue(
        context,
        path,
        "invalid_reference",
        "Credential field reference does not resolve.",
        "Reference an existing credential and field ID."
      );
    return field;
  };
  const checkCredentialRefs = (refs: CredentialRef[], path: (string | number)[]): void => {
    for (const index of duplicateIndexes(refs.map(refKey))) {
      manifestIssue(
        context,
        [...path, index],
        "duplicate_reference",
        "Credential field reference is duplicated.",
        "Declare each credential field reference once."
      );
    }
    refs.forEach((ref, index) => checkCredentialRef(ref, [...path, index]));
  };

  const mcpServers = new Map(manifest.mcpServers.map((server) => [server.id, server]));
  manifest.mcpServers.forEach((server, index) => {
    checkCredentialRefs(server.credentialFields, ["mcpServers", index, "credentialFields"]);
    if (server.discovery.mode === "static") {
      for (const duplicate of duplicateIndexes(server.discovery.tools)) {
        manifestIssue(
          context,
          ["mcpServers", index, "discovery", "tools", duplicate],
          "duplicate_reference",
          "Discovered MCP tool is duplicated.",
          "Declare each discovered MCP tool once."
        );
      }
    }
    if (server.transport !== "stdio" && !urlHasDeclaredAccess(manifest, server.url)) {
      manifestIssue(
        context,
        ["mcpServers", index, "url"],
        "security_violation",
        "MCP server destination is not declared in requested network access.",
        "Declare its HTTPS host and port or explicit unrestricted access."
      );
    }
  });
  if (manifest.source.kind === "mcp" && !mcpServers.has(manifest.source.serverId)) {
    manifestIssue(
      context,
      ["source", "serverId"],
      "invalid_reference",
      "MCP source server does not resolve.",
      "Reference a declared MCP server ID."
    );
  }

  const oauthIds = new Set(manifest.oauth.map((oauth) => oauth.id));
  manifest.oauth.forEach((oauth, index) => {
    for (const scopeIndex of duplicateIndexes(oauth.scopes)) {
      manifestIssue(
        context,
        ["oauth", index, "scopes", scopeIndex],
        "duplicate_reference",
        "OAuth scope is duplicated.",
        "Declare each OAuth scope once."
      );
    }
    if (oauth.mode === "direct") {
      const clientId = checkCredentialRef(oauth.clientId, ["oauth", index, "clientId"]);
      if (clientId?.sensitivity === "secret") {
        manifestIssue(
          context,
          ["oauth", index, "clientId"],
          "security_violation",
          "OAuth client ID cannot reference a secret field.",
          "Use a non-secret text credential field for the client ID."
        );
      }
      if (oauth.clientSecret) {
        const secret = checkCredentialRef(oauth.clientSecret, ["oauth", index, "clientSecret"]);
        if (refKey(oauth.clientId) === refKey(oauth.clientSecret)) {
          manifestIssue(
            context,
            ["oauth", index, "clientSecret"],
            "duplicate_reference",
            "OAuth client ID and secret reference the same field.",
            "Reference distinct credential fields."
          );
        }
        if (secret && secret.sensitivity !== "secret") {
          manifestIssue(
            context,
            ["oauth", index, "clientSecret"],
            "security_violation",
            "OAuth client secret must reference a secret field.",
            "Mark the referenced field sensitivity as secret."
          );
        }
      }
      for (const [field, params] of [
        ["authorizationParams", oauth.authorizationParams],
        ["tokenParams", oauth.tokenParams],
      ] as const) {
        if (!params) continue;
        for (const duplicate of duplicateIndexes(params.map((parameter) => parameter.name))) {
          manifestIssue(
            context,
            ["oauth", index, field, duplicate, "name"],
            "duplicate_reference",
            "OAuth parameter is duplicated.",
            "Declare each static OAuth parameter once."
          );
        }
      }
      for (const field of ["authorizationUrl", "tokenUrl"] as const) {
        if (!urlHasDeclaredAccess(manifest, oauth[field])) {
          manifestIssue(
            context,
            ["oauth", index, field],
            "security_violation",
            "OAuth destination is not declared in requested network access.",
            "Declare its HTTPS host and port."
          );
        }
      }
    } else if (!urlHasDeclaredAccess(manifest, oauth.brokerUrl)) {
      manifestIssue(
        context,
        ["oauth", index, "brokerUrl"],
        "security_violation",
        "OAuth broker destination is not declared in requested network access.",
        "Declare its HTTPS host and port."
      );
    }
  });

  const toolIds = new Set(manifest.tools.map((tool) => tool.id));
  manifest.tools.forEach((tool, index) => {
    checkCredentialRefs(tool.credentialFields, ["tools", index, "credentialFields"]);
    if (tool.oauthId !== undefined && !oauthIds.has(tool.oauthId)) {
      manifestIssue(
        context,
        ["tools", index, "oauthId"],
        "invalid_reference",
        "Tool OAuth reference does not resolve.",
        "Reference a declared OAuth configuration."
      );
    }
    if (tool.kind === "mcp") {
      const server = mcpServers.get(tool.server);
      if (!server) {
        manifestIssue(
          context,
          ["tools", index, "server"],
          "invalid_reference",
          "MCP tool server reference does not resolve.",
          "Reference a declared MCP server ID."
        );
      } else if (
        server.discovery.mode === "static" &&
        !server.discovery.tools.includes(tool.tool)
      ) {
        manifestIssue(
          context,
          ["tools", index, "tool"],
          "invalid_reference",
          "MCP tool is absent from static discovery.",
          "Reference a tool listed by the server discovery declaration."
        );
      }
    } else if (tool.kind === "http") {
      if (!urlHasDeclaredAccess(manifest, tool.baseUrl)) {
        manifestIssue(
          context,
          ["tools", index, "baseUrl"],
          "security_violation",
          "HTTP tool destination is not declared in requested network access.",
          "Declare its HTTPS host and port."
        );
      }
      if (!preservesDeclaredHttpOrigin(tool.baseUrl, tool.path)) {
        manifestIssue(
          context,
          ["tools", index, "path"],
          "security_violation",
          "HTTP path resolution changes the declared base URL origin.",
          "Use a same-origin path beginning with exactly one forward slash."
        );
      }
    }
  });

  manifest.capabilities.forEach((capability, index) => {
    for (const duplicate of duplicateIndexes(capability.toolIds)) {
      manifestIssue(
        context,
        ["capabilities", index, "toolIds", duplicate],
        "duplicate_reference",
        "Capability tool target is duplicated.",
        "Map each capability to a tool only once."
      );
    }
    capability.toolIds.forEach((toolId, targetIndex) => {
      if (!toolIds.has(toolId))
        manifestIssue(
          context,
          ["capabilities", index, "toolIds", targetIndex],
          "invalid_reference",
          "Capability target does not resolve to a tool.",
          "Reference a declared tool ID."
        );
    });
  });

  const checkIds = new Set(manifest.diagnostics.map((check) => check.id));
  manifest.diagnostics.forEach((check, index) => {
    if (check.kind === "tool" && !toolIds.has(check.toolId)) {
      manifestIssue(
        context,
        ["diagnostics", index, "toolId"],
        "invalid_reference",
        "Diagnostic tool reference does not resolve.",
        "Reference a declared tool ID."
      );
    } else if (check.kind === "http") {
      checkCredentialRefs(check.credentialFields, ["diagnostics", index, "credentialFields"]);
      check.credentialFields.forEach((ref, refIndex) => {
        if (credentials.get(ref.credentialId)?.get(ref.fieldId)?.sensitivity === "secret") {
          manifestIssue(
            context,
            ["diagnostics", index, "credentialFields", refIndex],
            "security_violation",
            "Raw HTTP diagnostics cannot reference secret credentials.",
            "Use a tool diagnostic that delegates authentication to its runtime."
          );
        }
      });
      if (!urlHasDeclaredAccess(manifest, check.url)) {
        manifestIssue(
          context,
          ["diagnostics", index, "url"],
          "security_violation",
          "HTTP diagnostic destination is not declared in requested network access.",
          "Declare its HTTPS host and port."
        );
      }
    } else if (check.kind === "credential") {
      checkCredentialRef(check.credentialField, ["diagnostics", index, "credentialField"]);
    }
  });

  manifest.setup.forEach((step, index) => {
    const valid =
      step.kind === "instruction" ||
      (step.kind === "credential" && credentials.has(step.credentialId)) ||
      (step.kind === "oauth" && oauthIds.has(step.oauthId)) ||
      (step.kind === "diagnostic" && checkIds.has(step.checkId));
    if (!valid) {
      const field =
        step.kind === "credential" ? "credentialId" : step.kind === "oauth" ? "oauthId" : "checkId";
      manifestIssue(
        context,
        ["setup", index, field],
        "invalid_reference",
        "Setup step reference does not resolve.",
        "Reference a declaration present in this manifest."
      );
    }
  });

  for (const index of duplicateIndexes(manifest.quality.evidence.map((entry) => entry.criterion))) {
    manifestIssue(
      context,
      ["quality", "evidence", index, "criterion"],
      "duplicate_reference",
      "Quality criterion evidence is duplicated.",
      "Provide one evidence claim per criterion."
    );
  }
  const trustedBuiltIn =
    manifest.ownership.kind === "first-party" && manifest.source.kind === "built-in";
  const trustedSynthesized =
    manifest.source.kind === "synthesized" && manifest.source.generator.startsWith("chvor.");
  for (const [category, entries] of Object.entries(manifest.requestedAccess)) {
    entries.forEach((entry, index) => {
      if (
        entry.enforcement === "sandbox-enforced" ||
        (entry.enforcement !== "declared-only" &&
          !trustedBuiltIn &&
          !(trustedSynthesized && entry.enforcement === "runtime-enforced"))
      ) {
        manifestIssue(
          context,
          ["requestedAccess", category, index, "enforcement"],
          "security_violation",
          "Strong access enforcement claim is not supported by this declaration source.",
          "Use declared-only unless a trusted runtime supplies the enforcement boundary."
        );
      }
      if ("credentialField" in entry) {
        const field = checkCredentialRef(entry.credentialField, [
          "requestedAccess",
          category,
          index,
          "credentialField",
        ]);
        const expectedSensitivity =
          category === "network" ? "url" : category === "filesystem" ? "path" : undefined;
        if (field && expectedSensitivity && field.sensitivity !== expectedSensitivity) {
          manifestIssue(
            context,
            ["requestedAccess", category, index, "credentialField"],
            "security_violation",
            `Credential-derived ${category} access must reference a ${expectedSensitivity} field.`,
            `Use a credential field with ${expectedSensitivity} sensitivity.`
          );
        }
      }
    });
  }
}

const integrationManifestV1DataSchema =
  integrationManifestV1BaseSchema.superRefine(validateManifestSemantics);
const integrationManifestV2DataSchema =
  integrationManifestV2BaseSchema.superRefine(validateManifestSemantics);
const integrationManifestDataSchema = z
  .discriminatedUnion("schemaVersion", [
    integrationManifestV1BaseSchema,
    integrationManifestV2BaseSchema,
  ])
  .superRefine(validateManifestSemantics);

interface CloneState {
  seen: Set<object>;
  nodes: number;
}
type CloneResult = { success: true; data: unknown } | { success: false; path: (string | number)[] };

function isOauthParameterPath(path: (string | number)[]): boolean {
  return (
    path.length === 4 &&
    path[0] === "oauth" &&
    typeof path[1] === "number" &&
    (path[2] === "authorizationParams" || path[2] === "tokenParams") &&
    typeof path[3] === "number"
  );
}

function clonePlainInput(
  value: unknown,
  state: CloneState = { seen: new Set(), nodes: 0 },
  path: (string | number)[] = [],
  depth = 0
): CloneResult {
  try {
    return clonePlainInputUnchecked(value, state, path, depth);
  } catch {
    return { success: false, path };
  }
}

function clonePlainInputUnchecked(
  value: unknown,
  state: CloneState,
  path: (string | number)[],
  depth: number
): CloneResult {
  state.nodes += 1;
  if (
    depth > INTEGRATION_MANIFEST_LIMITS.inputDepth ||
    state.nodes > INTEGRATION_MANIFEST_LIMITS.inputNodes
  ) {
    return { success: false, path };
  }
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return { success: true, data: value };
  if (typeof value === "number")
    return Number.isFinite(value) ? { success: true, data: value } : { success: false, path };
  if (typeof value !== "object" || state.seen.has(value)) return { success: false, path };
  state.seen.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) return { success: false, path };
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.keys(descriptors);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      names.length !== lengthDescriptor.value + 1
    ) {
      return { success: false, path };
    }
    const output: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return { success: false, path: [...path, index] };
      const cloned = clonePlainInput(descriptor.value, state, [...path, index], depth + 1);
      if (!cloned.success) return cloned;
      output.push(cloned.data);
    }
    return { success: true, data: output };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { success: false, path };
  if (isOauthParameterPath(path)) {
    const nameDescriptor = Object.getOwnPropertyDescriptor(value, "name");
    if (
      nameDescriptor &&
      "value" in nameDescriptor &&
      nameDescriptor.enumerable &&
      typeof nameDescriptor.value === "string" &&
      !isSafeStaticOauthParameterName(nameDescriptor.value)
    ) {
      return { success: true, data: { name: nameDescriptor.value } };
    }
  }
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (
      ["__proto__", "prototype", "constructor"].includes(key) ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return { success: false, path: [...path, key] };
    }
    const cloned = clonePlainInput(descriptor.value, state, [...path, key], depth + 1);
    if (!cloned.success) return cloned;
    output[key] = cloned.data;
  }
  return { success: true, data: output };
}

const integrationManifestPlainInputSchema = z.unknown().transform((value, context) => {
  const cloned = clonePlainInput(value);
  if (!cloned.success) {
    manifestIssue(
      context,
      cloned.path,
      "security_violation",
      "Manifest input must be plain data without accessors or custom prototypes.",
      "Decode the manifest as ordinary JSON data before validation."
    );
    return z.NEVER;
  }
  return cloned.data;
});

export const integrationManifestV1Schema = integrationManifestPlainInputSchema.pipe(
  integrationManifestV1DataSchema
);
export const integrationManifestV2Schema = integrationManifestPlainInputSchema.pipe(
  integrationManifestV2DataSchema
);
export const integrationManifestSchema = integrationManifestPlainInputSchema.pipe(
  integrationManifestDataSchema
);
export const currentIntegrationManifestSchema = integrationManifestV2Schema;

export type IntegrationOwner = z.infer<typeof integrationOwnerSchema>;
export type IntegrationSource = z.infer<typeof integrationSourceSchema>;
export type IntegrationCredentialV1 = z.infer<typeof integrationCredentialV1Schema>;
export type IntegrationCredentialV2 = z.infer<typeof integrationCredentialV2Schema>;
export type IntegrationCredential = IntegrationCredentialV1;
export type CurrentIntegrationCredential = IntegrationCredentialV2;
export type IntegrationCredentialFieldRef = z.infer<typeof integrationCredentialFieldRefSchema>;
export type IntegrationTool = z.infer<typeof integrationToolSchema>;
export type IntegrationMcpServer = z.infer<typeof integrationMcpServerSchema>;
export type IntegrationOauthV1 = z.infer<typeof integrationOauthV1Schema>;
export type IntegrationOauthV2 = z.infer<typeof integrationOauthV2Schema>;
export type IntegrationOauth = IntegrationOauthV1;
export type CurrentIntegrationOauth = IntegrationOauthV2;
export type IntegrationCapability = z.infer<typeof integrationCapabilitySchema>;
export type IntegrationRequestedAccess = z.infer<typeof integrationRequestedAccessSchema>;
export type IntegrationSetupStep = z.infer<typeof integrationSetupStepSchema>;
export type IntegrationDiagnosticCheck = z.infer<typeof integrationDiagnosticCheckSchema>;
export type IntegrationQuality = z.infer<typeof integrationQualitySchema>;
export type IntegrationManifestDiagnostic = z.infer<typeof integrationManifestDiagnosticSchema>;
export type IntegrationManifestV1 = z.infer<typeof integrationManifestV1Schema>;
export type IntegrationManifestV2 = z.infer<typeof integrationManifestV2Schema>;
export type IntegrationManifest = IntegrationManifestV1 | IntegrationManifestV2;
export type CurrentIntegrationManifest = IntegrationManifestV2;

export function parseIntegrationManifest(value: unknown): IntegrationManifest {
  return integrationManifestSchema.parse(value);
}

function unexpectedValidationError(): z.ZodError {
  return new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: [],
      message: "Manifest validation failed safely.",
      params: {
        code: "validation_failed",
        hint: "Decode the manifest as ordinary JSON data before validation.",
      },
    },
  ]);
}

export function safeParseIntegrationManifest(
  value: unknown
): ReturnType<typeof integrationManifestSchema.safeParse> {
  try {
    return integrationManifestSchema.safeParse(value);
  } catch {
    return { success: false, error: unexpectedValidationError() };
  }
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const sanitized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 512);
  return sanitized || fallback;
}

function diagnosticPath(path: (string | number)[]): string {
  if (path.length === 0) return "/";
  return `/${path
    .map(
      (part) =>
        String(part)
          .replace(/[^A-Za-z0-9._-]/g, "_")
          .slice(0, 128) || "_"
    )
    .join("/")}`.slice(0, 512);
}

function diagnosticFromIssue(issue: z.ZodIssue): IntegrationManifestDiagnostic[] {
  if (issue.code === z.ZodIssueCode.invalid_union) {
    const nested = issue.unionErrors.flatMap((error) => error.issues);
    const mostSpecific = nested.filter((candidate) => candidate.path.length > issue.path.length);
    return (mostSpecific.length > 0 ? mostSpecific : nested).flatMap(diagnosticFromIssue);
  }
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return issue.keys.map((key) => ({
      code: "unknown_field",
      path: diagnosticPath([...issue.path, key]),
      message: "Unknown field is not allowed.",
      hint: "Remove the field or use a supported schema version.",
    }));
  }
  if (issue.code === z.ZodIssueCode.custom) {
    const params = issue.params as { code?: unknown; hint?: unknown } | undefined;
    const codeResult = integrationManifestDiagnosticCodeSchema.safeParse(params?.code);
    return [
      {
        code: codeResult.success ? codeResult.data : "invalid_value",
        path: diagnosticPath(issue.path),
        message: safeText(issue.message, "Manifest value is invalid."),
        hint: safeText(params?.hint, "Correct the value at this path and try again."),
      },
    ];
  }
  if (
    issue.code === z.ZodIssueCode.invalid_type &&
    issue.expected === "never" &&
    issue.path.at(-1) === "default"
  ) {
    return [
      {
        code: "security_violation",
        path: diagnosticPath(issue.path),
        message: "Secret credential fields cannot declare defaults.",
        hint: "Collect the secret during setup and keep its value outside the manifest.",
      },
    ];
  }
  const missing = issue.code === z.ZodIssueCode.invalid_type && issue.received === "undefined";
  const invalidEnum = issue.code === z.ZodIssueCode.invalid_enum_value;
  return [
    {
      code: missing
        ? "missing_required_field"
        : invalidEnum
          ? "invalid_enum"
          : issue.code === z.ZodIssueCode.invalid_type
            ? "invalid_type"
            : "invalid_value",
      path: diagnosticPath(issue.path),
      message: missing
        ? "Required field is missing."
        : invalidEnum
          ? "Value is not one of the allowed enum members."
          : issue.code === z.ZodIssueCode.invalid_type
            ? "Value has the wrong type."
            : "Value does not satisfy the manifest contract.",
      hint: "Use a supported integration-manifest schema for the value at this path.",
    },
  ];
}

export function integrationManifestErrorToDiagnostics(
  error: unknown
): IntegrationManifestDiagnostic[] {
  try {
    if (!(error instanceof z.ZodError)) {
      return [
        {
          code: "validation_failed",
          path: "/",
          message: "Manifest validation failed.",
          hint: "Validate the document with a supported integration-manifest schema.",
        },
      ];
    }
    return error.issues.flatMap(diagnosticFromIssue);
  } catch {
    return [
      {
        code: "validation_failed",
        path: "/",
        message: "Manifest validation failed.",
        hint: "Validate the document with a supported integration-manifest schema.",
      },
    ];
  }
}

function isUnsupportedVersionError(error: z.ZodError): boolean {
  return error.issues.some(
    (issue) =>
      issue.path.length === 1 &&
      issue.path[0] === "schemaVersion" &&
      (issue.code === z.ZodIssueCode.invalid_literal ||
        issue.code === z.ZodIssueCode.invalid_union_discriminator)
  );
}

function unsupportedVersionDiagnostic(): IntegrationManifestDiagnostic {
  return {
    code: "unsupported_schema_version",
    path: "/schemaVersion",
    message: "Integration manifest schema version is unsupported.",
    hint: `Use schemaVersion ${INTEGRATION_MANIFEST_SCHEMA_VERSION} for new manifests; supported versions are ${SUPPORTED_INTEGRATION_MANIFEST_SCHEMA_VERSIONS.join(", ")}.`,
  };
}

export function diagnoseIntegrationManifest(value: unknown): IntegrationManifestDiagnostic[] {
  const result = safeParseIntegrationManifest(value);
  if (result.success) return [];
  return isUnsupportedVersionError(result.error)
    ? [unsupportedVersionDiagnostic()]
    : integrationManifestErrorToDiagnostics(result.error);
}

export const toIntegrationManifestDiagnostics = integrationManifestErrorToDiagnostics;

export function safeParseIntegrationManifestWithDiagnostics(
  value: unknown
):
  | { success: true; data: IntegrationManifest; diagnostics: [] }
  | { success: false; diagnostics: IntegrationManifestDiagnostic[] } {
  const result = safeParseIntegrationManifest(value);
  if (result.success) return { success: true, data: result.data, diagnostics: [] };
  return {
    success: false,
    diagnostics: isUnsupportedVersionError(result.error)
      ? [unsupportedVersionDiagnostic()]
      : integrationManifestErrorToDiagnostics(result.error),
  };
}
