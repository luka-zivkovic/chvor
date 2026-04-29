/**
 * Tool groups — the safety floor for skill-scoped tool injection.
 *
 * Skills declare `requiredGroups` in frontmatter. The orchestrator's bag for
 * a turn = union of active skills' groups (∪ explicit `requiredTools`,
 * minus `deniedTools`). The Cognitive Tool Graph (later) optimizes within
 * the bag; groups define the floor.
 *
 * `core` is always implicitly included so a skill that needs nothing extra
 * still has memory recall, diagnostics, and basic safety tools.
 */
export type ToolGroupId =
  | "core"
  | "web"
  | "browser"
  | "pc"
  | "files"
  | "knowledge"
  | "daemon"
  | "credentials"
  | "shell"
  | "sandbox"
  | "image"
  | "skill-mgmt"
  | "registry"
  | "a2ui"
  | "webhook"
  | "model"
  | "social"
  | "git"
  | "crm"
  | "comms"
  | "dev"
  | "data"
  | "integrations-other";

/**
 * The complete list of group IDs in canonical order. Use this in UIs, the
 * security audit, and validation paths instead of duplicating the union.
 */
export const ALL_TOOL_GROUPS: ToolGroupId[] = [
  "core",
  "web",
  "browser",
  "pc",
  "files",
  "knowledge",
  "daemon",
  "credentials",
  "shell",
  "sandbox",
  "image",
  "skill-mgmt",
  "registry",
  "a2ui",
  "webhook",
  "model",
  "social",
  "git",
  "crm",
  "comms",
  "dev",
  "data",
  "integrations-other",
];

export function isToolGroupId(s: unknown): s is ToolGroupId {
  return typeof s === "string" && (ALL_TOOL_GROUPS as readonly string[]).includes(s);
}

/**
 * Tool-call authority criticality. Tools tagged `always-available` survive
 * every filter (decay, group scoping, denied list). Use sparingly — it's
 * the Cognitive Tool Graph's safety net.
 */
export type ToolCriticality = "always-available" | "normal";

/**
 * Resolved scope for a single turn — what the orchestrator hands to
 * tool-builder + system-prompt. Computed from the active skills.
 */
export interface ToolBagScope {
  /** Active groups (may include synthetic "*" for permissive fallback). */
  groups: Set<ToolGroupId | "*">;
  /** Explicit tools the skill demands regardless of group membership. */
  requiredTools: Set<string>;
  /** Tools that must be excluded even if their group is active. */
  deniedTools: Set<string>;
  /** True when no active skill declared scoping → fall back to legacy
   *  inject-all behaviour for backward compatibility. */
  isPermissive: boolean;
  /** Why this scope was permissive — populated only when isPermissive=true. */
  permissiveReason?: string;
  /** IDs of the active skills whose declarations contributed to this scope. */
  contributingSkills: string[];
  /** Credential types active skills allow this turn. Undefined/empty ⇒ legacy unscoped. */
  allowedCredentialTypes?: Set<string>;
}
