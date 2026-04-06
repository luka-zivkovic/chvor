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
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport: "stdio" | "sse" | "http";
  url?: string;
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
