import type { EvalFixture } from "../fixtures.ts";

export interface ToolUseScoreResult {
  score: number;
  reason: string;
  checks: {
    toolPresenceOk: boolean;
    forbidsOk: boolean;
    mustIncludeOk: boolean;
    mustNotIncludeOk: boolean;
  };
}

/**
 * Rule-based scorer for tool use + content expectations. No LLM call.
 * Deterministic, cheap, and the half of the eval harness that must work even
 * if Mastra's LLM scorers don't come online during the spike.
 */
export function scoreToolUse(fixture: EvalFixture, output: string): ToolUseScoreResult {
  const { expectations, toolsCalled } = fixture;
  const reasons: string[] = [];

  let toolPresenceOk = true;
  if (expectations.requiresAnyOf?.length) {
    const hit = expectations.requiresAnyOf.some((t) => toolsCalled.includes(t));
    toolPresenceOk = hit;
    if (!hit) {
      reasons.push(
        `expected a tool from [${expectations.requiresAnyOf.join(", ")}], got [${toolsCalled.join(", ") || "none"}]`,
      );
    }
  }

  let forbidsOk = true;
  if (expectations.forbidsTools && toolsCalled.length > 0) {
    forbidsOk = false;
    reasons.push(`expected no tool calls, got [${toolsCalled.join(", ")}]`);
  }

  const lowered = output.toLowerCase();
  let mustIncludeOk = true;
  if (expectations.mustInclude?.length) {
    const missing = expectations.mustInclude.filter((s) => !lowered.includes(s.toLowerCase()));
    if (missing.length) {
      mustIncludeOk = false;
      reasons.push(`missing required substrings: ${missing.map((s) => JSON.stringify(s)).join(", ")}`);
    }
  }

  let mustNotIncludeOk = true;
  if (expectations.mustNotInclude?.length) {
    const present = expectations.mustNotInclude.filter((s) => lowered.includes(s.toLowerCase()));
    if (present.length) {
      mustNotIncludeOk = false;
      reasons.push(`contains forbidden substrings: ${present.map((s) => JSON.stringify(s)).join(", ")}`);
    }
  }

  const passed = [toolPresenceOk, forbidsOk, mustIncludeOk, mustNotIncludeOk].filter(Boolean).length;
  const score = passed / 4;

  return {
    score,
    reason: reasons.length ? reasons.join("; ") : "all checks passed",
    checks: { toolPresenceOk, forbidsOk, mustIncludeOk, mustNotIncludeOk },
  };
}
