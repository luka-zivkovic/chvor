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
