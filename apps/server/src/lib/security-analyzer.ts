import type {
  AggregatedSecurityVerdict,
  SecurityActionContext,
  SecurityRisk,
  SecurityVerdict,
} from "@chvor/shared";

/**
 * Pluggable security analyzer registry (Phase D1).
 *
 * - Each analyzer inspects a {@link SecurityActionContext} and returns a
 *   {@link SecurityVerdict} (or `null` to abstain).
 * - {@link analyzeAction} runs every registered analyzer and returns the
 *   maximum risk across them. Policy decides what to do with HIGH risk
 *   (block, ask user, etc.) — that lives in the orchestrator.
 * - Built-ins live below; tests can inject custom analyzers via
 *   {@link registerAnalyzer} without touching this file.
 */

export interface SecurityAnalyzer {
  /** Stable identifier. Shows up in audit logs + canvas events. */
  id: string;
  /** Returns a verdict, or `null` to abstain (analyzer not applicable). */
  analyze(action: SecurityActionContext): SecurityVerdict | null | Promise<SecurityVerdict | null>;
}

const RISK_ORDER: Record<SecurityRisk, number> = { low: 0, medium: 1, high: 2 };

function maxRisk(a: SecurityRisk, b: SecurityRisk): SecurityRisk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

const registry = new Map<string, SecurityAnalyzer>();

export function registerAnalyzer(a: SecurityAnalyzer): void {
  registry.set(a.id, a);
}

export function unregisterAnalyzer(id: string): void {
  registry.delete(id);
}

export function listAnalyzers(): SecurityAnalyzer[] {
  return Array.from(registry.values());
}

/** Strip every registered analyzer + reset the built-in init flag. Useful in tests. */
export function clearAnalyzers(): void {
  registry.clear();
  initialised = false;
}

/**
 * Run every registered analyzer over an action and aggregate verdicts.
 * Errors inside an analyzer are logged + skipped (a buggy analyzer must
 * never block legitimate tool calls).
 */
export async function analyzeAction(
  action: SecurityActionContext
): Promise<AggregatedSecurityVerdict> {
  const verdicts: SecurityVerdict[] = [];
  for (const analyzer of registry.values()) {
    try {
      const result = await analyzer.analyze(action);
      if (result) verdicts.push({ ...result, analyzer: result.analyzer ?? analyzer.id });
    } catch (err) {
      console.warn(
        `[security-analyzer] ${analyzer.id} threw — skipping:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  if (verdicts.length === 0) {
    return { risk: "low", verdicts: [], highest: [], blocked: false };
  }

  const risk = verdicts.reduce<SecurityRisk>((acc, v) => maxRisk(acc, v.risk), "low");
  const highest = verdicts.filter((v) => v.risk === risk);
  return { risk, verdicts, highest, blocked: false };
}

/** Convenience for tests / direct callers. */
export function getRiskOrder(r: SecurityRisk): number {
  return RISK_ORDER[r];
}

// ---------------------------------------------------------------------------
// Built-in analyzers
// ---------------------------------------------------------------------------

/**
 * Static-rule analyzer — flags shell-style danger patterns in args, even
 * when the action isn't a shell call. Defends against tool-call payloads
 * that ferry destructive shell strings through other surfaces.
 */
export const staticRulesAnalyzer: SecurityAnalyzer = {
  id: "static-rules",
  analyze(action) {
    const blob = JSON.stringify(action.args ?? {}).toLowerCase();
    const reasons: string[] = [];
    let risk: SecurityRisk = "low";

    const HIGH_PATTERNS: Array<[RegExp, string]> = [
      [/\brm\s+-rf\b/, "rm -rf in args"],
      // classic fork bomb: ":(){ :|:& };:" — no word boundary anchors because
      // `:` isn't a word character.
      [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "fork bomb"],
      [/\bdrop\s+(table|database)\b/, "DROP TABLE/DATABASE in args"],
      [/\bmkfs(\.|\s)/, "mkfs in args"],
      [/\bdd\s+if=.*of=\/dev\//, "raw disk write (dd if=…of=/dev/…)"],
      [/\b(eval|exec)\s*\(/, "eval()/exec() invocation"],
      [/\b(curl|wget)\s+[^|&;`]*\|\s*(sh|bash|zsh|python)\b/, "pipe-to-shell from network"],
      [/--privileged\b/, "--privileged flag"],
    ];
    for (const [re, label] of HIGH_PATTERNS) {
      if (re.test(blob)) {
        reasons.push(label);
        risk = "high";
      }
    }

    if (risk !== "high") {
      const MED_PATTERNS: Array<[RegExp, string]> = [
        [/\b(ssh-keygen|chmod\s+777)\b/, "credential or perms-loosening op"],
        [/\b(sudo|su\s+-)\b/, "privilege escalation"],
        [/\b(\.\.\/){2,}/, "path traversal in args"],
        [/file:\/\//, "file:// URL"],
      ];
      for (const [re, label] of MED_PATTERNS) {
        if (re.test(blob)) {
          reasons.push(label);
          risk = "medium";
        }
      }
    }

    if (risk === "low") return null;
    return {
      analyzer: "static-rules",
      risk,
      reason: reasons.join("; "),
      details: { matches: reasons },
    };
  },
};

/**
 * MCP heuristic analyzer — when an MCP tool name itself implies destruction
 * (delete/drop/wipe/destroy/force/admin/purge) we raise a yellow flag so the
 * orchestrator can require approval before we hand the call to a third-party
 * MCP server we don't fully trust.
 */
// `_` is a JS word character, so `\b` doesn't break on it. Use explicit
// "word boundary OR `_`" anchors so `delete_repo` and `force_push` match.
const SEP = "(?:^|[^A-Za-z0-9])";
const SEP_END = "(?:[^A-Za-z0-9]|$)";
const MCP_DESTRUCTIVE_PATTERN = new RegExp(
  `${SEP}(delete|drop|destroy|wipe|purge|force[_-]?push|admin[_-]?reset)${SEP_END}`,
  "i"
);

export const mcpHeuristicAnalyzer: SecurityAnalyzer = {
  id: "mcp-heuristic",
  analyze(action) {
    if (action.kind !== "mcp") return null;

    // Inspect the endpoint/method name first (more precise) then full tool name.
    const candidates = [action.endpointName, action.toolName].filter(
      (s): s is string => typeof s === "string"
    );
    for (const name of candidates) {
      const m = name.match(MCP_DESTRUCTIVE_PATTERN);
      if (m) {
        return {
          analyzer: "mcp-heuristic",
          risk: "medium",
          reason: `MCP method name suggests destructive op: "${m[0]}" in "${name}"`,
          details: { matchedTerm: m[0], scannedName: name },
        };
      }
    }
    return null;
  },
};

/**
 * Argument-leak analyzer — flags args that look like they're carrying a raw
 * secret (PAT, OAuth bearer, OpenAI key) into a tool call. Most tools should
 * receive credential _references_ via the resolver, never the secret itself.
 */
const SECRET_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{36,}/,
  /sk-[A-Za-z0-9]{32,}/,
  /xoxb-[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/, // AWS access key
];

export const argLeakAnalyzer: SecurityAnalyzer = {
  id: "arg-leak",
  analyze(action) {
    const blob = JSON.stringify(action.args ?? {});
    for (const re of SECRET_PATTERNS) {
      const m = blob.match(re);
      if (m) {
        return {
          analyzer: "arg-leak",
          risk: "high",
          reason: "tool call args appear to contain a raw secret",
          details: { matchedPrefix: m[0].slice(0, 8) + "…" },
        };
      }
    }
    return null;
  },
};

let initialised = false;

/**
 * Idempotent — registers the built-in analyzers exactly once. Tests that need
 * a clean registry should call {@link clearAnalyzers} first.
 */
export function ensureBuiltinAnalyzersRegistered(): void {
  if (initialised) return;
  registerAnalyzer(staticRulesAnalyzer);
  registerAnalyzer(mcpHeuristicAnalyzer);
  registerAnalyzer(argLeakAnalyzer);
  initialised = true;
}

// ---------------------------------------------------------------------------
// Settings — controlled via env so users can disable the gate without UI.
// ---------------------------------------------------------------------------

/** Whether the orchestrator should block HIGH-risk actions outright. */
export function isBlockHighRiskEnabled(): boolean {
  // Default ON. Users opt out with CHVOR_SECURITY_BLOCK_HIGH=0|false|off.
  const raw = (process.env.CHVOR_SECURITY_BLOCK_HIGH ?? "1").toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

/** Whether to emit security.verdict events even for LOW-risk passes. */
export function isVerdictEventVerbose(): boolean {
  const raw = (process.env.CHVOR_SECURITY_VERDICT_VERBOSE ?? "0").toLowerCase();
  return ["1", "true", "on", "yes"].includes(raw);
}
