/** Open-ended credential type — any string identifier (e.g., "github", "stripe", "my-crm"). */
export type CredentialType = string;

export interface Credential {
  id: string;
  name: string;
  type: CredentialType;
  encryptedData: string;
  usageContext?: string;
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
}
