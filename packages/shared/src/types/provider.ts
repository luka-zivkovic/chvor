import type { CredentialType } from "./credential.js";

export interface ProviderField {
  key: string;
  label: string;
  type: "password" | "text";
  placeholder?: string;
  helpUrl?: string;
  optional?: boolean;
  helpText?: string;
  defaultValue?: string;
}

export interface ModelCost {
  input: number;  // USD per million tokens
  output: number; // USD per million tokens
}

export type ModelCapability = "vision" | "reasoning" | "toolUse" | "code";

export interface ModelDef {
  id: string;
  name: string;
  contextWindow: number;
  supportsStreaming: boolean;
  maxTokens?: number;
  cost?: ModelCost;
  capabilities?: ModelCapability[];
}

export interface LLMProviderDef {
  id: string;
  name: string;
  icon: string;
  credentialType: CredentialType;
  requiredFields: ProviderField[];
  models: ModelDef[];
  freeTextModel?: boolean;
  isLocal?: boolean;
}

export type ModelRole = "primary" | "reasoning" | "lightweight" | "heartbeat";

export interface ModelRoleConfig {
  providerId: string;
  model: string;
}

export interface ModelRolesConfig {
  primary: ModelRoleConfig | null;
  reasoning: ModelRoleConfig | null;
  lightweight: ModelRoleConfig | null;
  heartbeat: ModelRoleConfig | null;
}

export interface RoleFallbackEntry {
  providerId: string;
  model: string;
  alias?: string;
}

export interface EmbeddingModelDef {
  id: string;
  name: string;
  dimensions: number;
}

export interface EmbeddingProviderDef {
  id: string;
  name: string;
  icon?: string;
  credentialType: CredentialType | null;
  models: EmbeddingModelDef[];
  isLocal?: boolean;
}

export interface EmbeddingConfig {
  providerId: string;
  model: string;
  dimensions: number;
}

export interface IntegrationProviderDef {
  id: string;
  name: string;
  icon: string;
  credentialType: CredentialType;
  requiredFields: ProviderField[];
  description: string;
  usageContext?: string;
}

export type AnyProviderDef = LLMProviderDef | IntegrationProviderDef;

export function isLLMProvider(p: AnyProviderDef): p is LLMProviderDef {
  return "models" in p;
}

// --- Media pipeline types ---

export type MediaModelType = "image-understanding" | "video-understanding" | "image-generation";

export interface MediaModelConfig {
  providerId: string;
  model: string;
}

export interface ImageGenModelDef {
  id: string;
  name: string;
}

export interface ImageGenProviderDef {
  id: string;
  name: string;
  credentialType: CredentialType;
  models: ImageGenModelDef[];
}

// ── OAuth Provider Definitions ──────────────────────────────────

export type OAuthMethod = "direct" | "composio";

export interface OAuthProviderDef {
  id: string;
  name: string;
  icon: string;
  method: OAuthMethod;
  category: "social" | "productivity" | "life" | "developer";
  description: string;
  /** Composio toolkit slug (only for method: "composio") */
  composioToolkit?: string;
  /** Credential type for storing the user's OAuth app credentials (only for method: "direct") */
  setupCredentialType?: string;
}

export interface OAuthConnection {
  id: string;
  platform: string;
  method: OAuthMethod;
  status: "active" | "pending" | "failed" | "expired";
  connectedAt: string;
  /** Credential ID for direct OAuth connections */
  credentialId?: string;
}

export interface MediaTypeConfig {
  enabled: boolean;
  maxSizeBytes: number;
}

export interface MediaPipelineConfig {
  image: MediaTypeConfig;
  video: MediaTypeConfig;
  audio: MediaTypeConfig;
}
