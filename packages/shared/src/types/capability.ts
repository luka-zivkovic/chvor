export type SkillCategory =
  | "ai"
  | "communication"
  | "data"
  | "developer"
  | "file"
  | "productivity"
  | "web";

export type SkillType = "prompt" | "workflow";

export interface CapabilityParam {
  name: string;
  type: "string" | "number" | "boolean" | "json" | "file";
  description: string;
  required: boolean;
  default?: unknown;
}

export interface SkillConfigParam {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  default?: unknown;
}

export interface CapabilityMetadata {
  name: string;
  description: string;
  version: string;
  author?: string;
  category?: SkillCategory;
  icon?: string;
  tags?: string[];
  license?: string;
  requires?: {
    env?: string[];
    credentials?: string[];
  };
  inputs?: CapabilityParam[];
  outputs?: CapabilityParam[];
  config?: SkillConfigParam[];
  dependencies?: string[];
  /**
   * Capabilities this tool provides.
   * Maps capability ID to MCP tool name, e.g. { "twitter:post": "TWITTER_CREATE_TWEET" }.
   * Only meaningful for tools, not skills.
   */
  provides?: Record<string, string>;
  /**
   * Capabilities this skill needs (abstract references resolved before prompt).
   * Array of capability IDs like ["twitter:post", "social:connect"].
   * Only meaningful for skills, not tools.
   */
  needs?: string[];
  /**
   * Whether this capability is enabled by default when first loaded.
   * Defaults to true if not specified. Set to false for opt-in skills.
   */
  defaultEnabled?: boolean;
  /**
   * Credential schema describing what fields the user must fill in to connect.
   * Only meaningful for tools with requires.credentials.
   */
  credentialSchema?: CredentialFieldSchema;

  // -------------------------------------------------------------------------
  // Tool-bag scoping (Phase C — skill-scoped injection).
  // Skills declare which tool groups + specific tools they need. Tools declare
  // which group they belong to + their criticality.
  // -------------------------------------------------------------------------

  /** Skill-only — tool groups this skill needs. Union of active skills'
   *  requiredGroups forms the floor of the per-turn tool bag. */
  requiredGroups?: import("./tool-group.js").ToolGroupId[];

  /** Skill-only — explicit tool IDs (qualified names, e.g. "native__web_search")
   *  that must be in the bag regardless of group membership. */
  requiredTools?: string[];

  /** Skill-only — tool IDs explicitly excluded from the bag even when their
   *  group is otherwise active. */
  deniedTools?: string[];

  /** Skill-only — credential types this skill is allowed to use. Acts as a
   *  whitelist for the credential-resolver (Phase E). Empty/undefined ⇒ no
   *  scoping (matches today's behavior). */
  allowedCredentialTypes?: string[];

  /** Skill-only — context hints used to disambiguate when multiple credentials
   *  share a type (matched against `usage_context` on credentials). */
  preferredUsageContext?: string[];

  /** Tool-only — group this tool belongs to. Used for skill-scoped filtering. */
  group?: import("./tool-group.js").ToolGroupId;

  /** Tool-only — when set, tool survives every scope filter (decay, group
   *  scoping, denied list). Use sparingly. */
  criticality?: import("./tool-group.js").ToolCriticality;

  /** Tool-only — risk classification used by the emotion-modulated gate
   *  (Phase H). Defaults are derived from the tool's group when omitted;
   *  override here when a single tool in a moderate group does something
   *  destructive (or vice versa). */
  riskTag?: import("./emotion-gate.js").RiskTag;
}

export interface CredentialFieldSchema {
  type: string;
  name: string;
  fields: Array<{
    key: string;
    label: string;
    required?: boolean;
    secret?: boolean;
    helpText?: string;
  }>;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport: "stdio" | "sse" | "http" | "synthesized";
  url?: string;
}

export interface SynthesizedToolConfig {
  source: "openapi" | "ai-draft";
  verified: boolean;
  specUrl?: string;
  generatedAt: string;
  credentialType: string;
  /** If set, pins the synthesized tool to a specific saved credential by ID.
   *  Falls back to first-of-type lookup when omitted. */
  credentialId?: string;
  /** Per-tool HTTP call timeout in milliseconds. Defaults to 60 s, capped at 600 s. */
  timeoutMs?: number;
}

export interface SynthesizedEndpointParam {
  name: string;
  type: "string" | "integer" | "boolean" | "number";
  required: boolean;
  description?: string;
}

export interface SynthesizedEndpoint {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  pathParams?: SynthesizedEndpointParam[];
  queryParams?: SynthesizedEndpointParam[];
  bodySchema?: Record<string, unknown> | null;
}

interface BaseCapability {
  id: string;
  metadata: CapabilityMetadata;
  instructions: string;
  source: "bundled" | "user" | "registry";
  path: string;
}

export interface Skill extends BaseCapability {
  kind: "skill";
  skillType: SkillType;
}

export interface Tool extends BaseCapability {
  kind: "tool";
  mcpServer?: McpServerConfig;
  builtIn: boolean;
  synthesized?: SynthesizedToolConfig;
  endpoints?: SynthesizedEndpoint[];
}

export type Capability = Skill | Tool;

// --- Registry types ---

export type RegistryEntryKind = "skill" | "tool" | "template";

export interface RegistryEntry {
  id: string;
  kind: RegistryEntryKind;
  name: string;
  description: string;
  version: string;
  author?: string;
  category?: SkillCategory;
  tags?: string[];
  license?: string;
  downloads?: number;
  sha256: string;
  requires?: { env?: string[]; credentials?: string[] };
  credentials?: {
    type: string;
    name: string;
    fields: Array<{
      key: string;
      label: string;
      required?: boolean;
      secret?: boolean;
      helpText?: string;
    }>;
  };
  dependencies?: string[];
  /** For templates: IDs of skills/tools included in the template */
  includes?: string[];
  /** Whether this entry should be highlighted in onboarding / first-run prompts */
  featured?: boolean;
}

/** @deprecated Use RegistryEntry */
export type RegistrySkillEntry = RegistryEntry;

export interface RegistryIndex {
  version: number;
  updatedAt: string;
  entries: RegistryEntry[];
}

export interface InstalledRegistryEntry {
  kind: RegistryEntryKind;
  version: string;
  installedAt: string;
  sha256: string;
  source: "registry";
  userModified: boolean;
  /** True when this registry entry overrides a bundled skill/tool of the same ID */
  shadowsBundled?: boolean;
  /** Template-only: IDs of skills/tools installed as part of this template */
  includedEntries?: string[];
  /** Template-only: IDs of schedules provisioned by this template */
  provisionedScheduleIds?: string[];
  /** Template-only: workspace ID of the pipeline provisioned by this template */
  provisionedPipelineId?: string;
  /** Template-only: snapshot of persona config before template applied changes */
  previousPersona?: Record<string, unknown>;
  /** Template-only: previous instruction overrides before template applied its own */
  previousSkillOverrides?: Record<string, string | null>;
}

/** @deprecated Use InstalledRegistryEntry */
export type InstalledRegistrySkill = InstalledRegistryEntry;

export interface RegistryLock {
  installed: Record<string, InstalledRegistryEntry>;
  registryUrl: string;
  lastChecked: string;
}

// Deprecated aliases for backward compat during migration
/** @deprecated Use CapabilityParam */
export type SkillParam = CapabilityParam;
/** @deprecated Use CapabilityMetadata */
export type SkillMetadata = CapabilityMetadata;
