/** Open-ended credential type — any string identifier (e.g., "github", "stripe", "my-crm"). */
export type CredentialType = string;

/** Structured connection configuration — how to authenticate and call a service's API. */
export interface ConnectionConfig {
  auth: {
    scheme: "bearer" | "api-key-header" | "basic" | "query-param" | "custom";
    /** Header name, e.g. "Authorization", "x-api-key", "xc-token" */
    headerName?: string;
    /** Template with placeholder, e.g. "Bearer {{apiKey}}", "token {{apiKey}}" */
    headerTemplate?: string;
    /** Query parameter name for query-param scheme */
    queryParam?: string;
  };
  /** Normalized base URL for API calls */
  baseUrl?: string;
  /** Extra required headers, e.g. { "Notion-Version": "2022-06-28" } */
  headers?: Record<string, string>;
  /** API version string, e.g. "v1", "v3" */
  apiVersion?: string;
  /** How the config was determined */
  source: "builtin" | "probed" | "llm-researched" | "user-provided";
  /** Confidence in the resolved config */
  confidence: "high" | "medium" | "low";
  /** Human-readable summary of how to connect */
  summary?: string;
}

export interface Credential {
  id: string;
  name: string;
  type: CredentialType;
  encryptedData: string;
  usageContext?: string;
  connectionConfig?: ConnectionConfig;
  createdAt: string;
  updatedAt: string;
  lastTestedAt?: string;
  testStatus?: "success" | "failed" | "untested";
}

export interface CredentialData {
  [key: string]: string;
}

export interface CredentialSummary {
  id: string;
  name: string;
  type: CredentialType;
  testStatus?: "success" | "failed" | "untested";
  createdAt: string;
  redactedFields: Record<string, string>;
  usageContext?: string;
  connectionConfig?: ConnectionConfig;
}

/** Schema for credential fields — embedded in registry tool definitions or from AI research. */
export interface CredentialSchema {
  type: string;
  name: string;
  fields: import("./provider.js").ProviderField[];
}

/** Result of the three-tier integration resolution. */
export interface IntegrationResolution {
  source: "provider-registry" | "chvor-registry" | "ai-research";
  name: string;
  credentialType: string;
  fields: import("./provider.js").ProviderField[];
  registryEntryId?: string;
  registryToolInstalled?: boolean;
  proposal?: ProviderProposal;
  existingCredentialId?: string;
}

// ── Catalog (browseable list of integrations Chvor can connect to) ──

export type IntegrationCategory =
  | "llm"
  | "embedding"
  | "integration"
  | "image-gen"
  | "oauth"
  | "registry";

export interface IntegrationCatalogEntry {
  /** Stable id — for built-in providers this is the provider id, for registry entries the registry entry id. */
  id: string;
  source: "provider-registry" | "chvor-registry";
  name: string;
  description: string;
  icon?: string;
  category: IntegrationCategory;
  credentialType?: string;
  /** True iff a credential of this type already exists locally. */
  installed: boolean;
  /** OAuth-supported (direct or via Composio bridge). */
  oauth?: boolean;
  /** Tags from the chvor registry — used for client-side filtering. */
  tags?: string[];
}

export interface IntegrationCatalogResponse {
  entries: IntegrationCatalogEntry[];
  /** Total entries returned, for the header counter. */
  total: number;
}

/** AI-researched integration proposal (Tier 3). */
export interface ProviderProposal {
  name: string;
  credentialType: string;
  fields: import("./provider.js").ProviderField[];
  baseUrl?: string;
  authScheme?: string;
  helpText?: string;
  /**
   * - "researched": web-scrape + LLM extraction (most reliable)
   * - "inferred": pure LLM guess from training data (medium reliability)
   * - "fallback": no info found, generic apiKey+baseUrl form (low reliability — manual entry)
   */
  confidence: "researched" | "inferred" | "fallback";
  /** URL to an OpenAPI/Swagger spec if the service publishes one. */
  specUrl?: string;
  /**
   * True if `specUrl` was probed and returned a valid OpenAPI document.
   * False/absent means the URL is unverified (likely an LLM guess).
   */
  specVerified?: boolean;
  /**
   * Optional path on baseUrl that returns 2xx with a valid credential
   * (e.g. `/v1/me`, `/account`). Used by the credential modal's "Test
   * connection" probe to give the user immediate feedback.
   */
  probePath?: string;
  /** OAuth2 authorization endpoint (when authScheme === "oauth2"). */
  authUrl?: string;
  /** OAuth2 token-exchange endpoint (when authScheme === "oauth2"). */
  tokenUrl?: string;
  /** Default OAuth2 scopes (when authScheme === "oauth2"). */
  scopes?: string[];
}
