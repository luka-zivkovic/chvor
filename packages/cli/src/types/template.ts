/**
 * Template types inlined from @chvor/shared for standalone npm distribution.
 * Keep in sync with packages/shared/src/types/template.ts
 */

export interface TemplateCredentialField {
  name: string;
  label: string;
  secret?: boolean;
}

export interface TemplateCredentialDef {
  type: string;
  name: string;
  description: string;
  fields: TemplateCredentialField[];
}

export interface TemplateScheduleDef {
  name: string;
  cronExpression: string;
  prompt: string;
  oneShot?: boolean;
}

export type CommunicationStyle = "concise" | "balanced" | "detailed";

export interface ExampleResponse {
  user: string;
  assistant: string;
}

export interface TemplatePersonaDef {
  profile?: string;
  directives?: string;
  aiName?: string;
  tone?: string;
  boundaries?: string;
  communicationStyle?: CommunicationStyle;
  exampleResponses?: ExampleResponse[];
}

export interface TemplateSkillOverride {
  skillId: string;
  instructions: string;
}

export interface TemplateManifest {
  name: string;
  description: string;
  version: string;
  author?: string;
  icon?: string;
  tags?: string[];
  persona?: TemplatePersonaDef;
  skillOverrides?: TemplateSkillOverride[];
  credentials?: TemplateCredentialDef[];
  schedules?: TemplateScheduleDef[];
  pipeline?: { nodes: unknown[]; edges: unknown[] };
}

export interface TemplateIndexEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  icon?: string;
  tags?: string[];
  path: string;
}
