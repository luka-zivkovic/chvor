// ---------------------------------------------------------------------------
// Workflow parameter resolution (shared between run-workflow + scheduler)
// ---------------------------------------------------------------------------

interface WorkflowParamDef {
  name: string;
  description?: string;
  required: boolean;
  default?: unknown;
}

export interface ResolvedWorkflowParams {
  resolved: Record<string, string>;
  missing: string[];
}

/**
 * Resolves workflow parameters and substitutes {{placeholders}} in instructions.
 * Uses single-pass regex replacement to prevent double-substitution attacks
 * (e.g. a param value containing "{{other_param}}" is NOT re-expanded).
 */
export function resolveWorkflowParams(
  definedParams: WorkflowParamDef[],
  inputParams: Record<string, string>,
  instructions: string
): { resolved: Record<string, string>; missing: string[]; instructions: string } {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const param of definedParams) {
    if (inputParams[param.name] !== undefined) {
      resolved[param.name] = inputParams[param.name];
    } else if (param.default !== undefined) {
      resolved[param.name] = String(param.default);
    } else if (param.required) {
      missing.push(param.name);
    }
  }

  // Single-pass substitution to prevent double-expansion
  const substituted = instructions.replace(
    /\{\{([^}]+)\}\}/g,
    (match, key: string) => {
      const trimmed = key.trim();
      return trimmed in resolved ? resolved[trimmed] : match;
    }
  );

  return { resolved, missing, instructions: substituted };
}
