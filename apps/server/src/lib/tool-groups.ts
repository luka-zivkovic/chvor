import type { Skill, Tool, ToolBagScope, ToolGroupId } from "@chvor/shared";

/**
 * Tool-group safety floor for skill-scoped tool injection (Phase C).
 *
 * - `resolveSkillBag(skills)` produces a `ToolBagScope` from a set of active
 *   skills' frontmatter declarations.
 * - `filterTools(allTools, scope)` returns the subset of MCP / synth tools
 *   that pass the scope (group match, required-tools, denied-tools).
 *
 * Native tools are filtered separately by `getNativeToolDefinitions(scope)`
 * because they live behind a module abstraction.
 */

/**
 * Build a ToolBagScope from active skills.
 *
 * Backward compatibility: if NO active skill declares any of
 * `requiredGroups` / `requiredTools` / `deniedTools`, we fall back to a
 * permissive scope (all tools), so existing user-authored skills keep
 * working until they opt in.
 *
 * `core` is always implicitly added so memory recall + diagnostics survive
 * even minimal declarations.
 */
export function resolveSkillBag(skills: Skill[]): ToolBagScope {
  const groups = new Set<ToolGroupId | "*">();
  const requiredTools = new Set<string>();
  const deniedTools = new Set<string>();
  const contributingSkills: string[] = [];

  let anyDeclared = false;

  for (const s of skills) {
    const m = s.metadata;
    const declared =
      (m.requiredGroups && m.requiredGroups.length > 0) ||
      (m.requiredTools && m.requiredTools.length > 0) ||
      (m.deniedTools && m.deniedTools.length > 0);
    if (!declared) continue;

    anyDeclared = true;
    contributingSkills.push(s.id);

    for (const g of m.requiredGroups ?? []) groups.add(g);
    for (const t of m.requiredTools ?? []) requiredTools.add(t);
    for (const t of m.deniedTools ?? []) deniedTools.add(t);
  }

  if (!anyDeclared) {
    // Permissive fallback so undeclared skills keep functioning.
    return {
      groups: new Set<ToolGroupId | "*">(["*"]),
      requiredTools,
      deniedTools,
      isPermissive: true,
      permissiveReason:
        skills.length === 0
          ? "no active skills"
          : "no active skill declared requiredGroups / requiredTools / deniedTools",
      contributingSkills,
    };
  }

  // Always implicitly include the core group.
  groups.add("core");

  return {
    groups,
    requiredTools,
    deniedTools,
    isPermissive: false,
    contributingSkills,
  };
}

/**
 * Filter MCP / synth (non-native) tools against a ToolBagScope. Operates at the
 * Tool level (the enclosing capability), NOT the per-endpoint level — endpoint
 * pruning is handled later by `applyScopeToDefs` once the full def map exists.
 *
 * Tools opt in by declaring `group:` in frontmatter; an undeclared tool is
 * treated as `integrations-other` (catch-all). Permissive scope returns the
 * input untouched.
 */
export function filterTools(allTools: Tool[], scope: ToolBagScope): Tool[] {
  if (scope.isPermissive) return allTools;

  return allTools.filter((t) => {
    const qualifiedPrefix = `${t.id}__`;
    const criticality = t.metadata.criticality ?? "normal";
    if (criticality === "always-available") return true;

    const group: ToolGroupId = t.metadata.group ?? "integrations-other";

    if (scope.groups.has("*")) return true;
    if (scope.groups.has(group)) return true;

    // Allow when ANY required-tool entry points at this tool. Per-endpoint
    // entries (`<toolId>__<endpoint>`) keep the enclosing tool alive here;
    // `applyScopeToDefs` then prunes the specific endpoints from the def map.
    for (const r of scope.requiredTools) {
      if (r === t.id || r.startsWith(qualifiedPrefix)) return true;
    }

    return false;
  });
}

/**
 * Apply per-endpoint deny / require filtering to a fully-built tool def map.
 * Native + MCP + synth defs all funnel through here as the last step before
 * being handed to the LLM.
 */
export function applyScopeToDefs<T>(
  defs: Record<string, T>,
  scope: ToolBagScope
): { defs: Record<string, T>; removed: string[] } {
  if (scope.isPermissive) return { defs, removed: [] };

  const out: Record<string, T> = {};
  const removed: string[] = [];
  for (const [name, def] of Object.entries(defs)) {
    if (scope.deniedTools.has(name)) {
      removed.push(name);
      continue;
    }
    out[name] = def;
  }
  return { defs: out, removed };
}

/** Convenience: produce a small JSON-serializable summary for canvas events. */
export function summarizeScope(scope: ToolBagScope): {
  groups: string[];
  requiredTools: string[];
  deniedTools: string[];
  isPermissive: boolean;
  contributingSkills: string[];
  permissiveReason: string | undefined;
} {
  return {
    groups: Array.from(scope.groups).sort(),
    requiredTools: Array.from(scope.requiredTools).sort(),
    deniedTools: Array.from(scope.deniedTools).sort(),
    isPermissive: scope.isPermissive,
    contributingSkills: [...scope.contributingSkills].sort(),
    permissiveReason: scope.permissiveReason,
  };
}
