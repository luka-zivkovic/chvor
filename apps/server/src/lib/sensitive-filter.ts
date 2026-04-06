/** Patterns that match sensitive data — API keys, tokens, passwords, etc. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(sk-[a-zA-Z0-9]{20,})/i,            // OpenAI / Anthropic keys
  /\b(xoxb-[a-zA-Z0-9-]+)/i,             // Slack bot tokens
  /\b(xoxp-[a-zA-Z0-9-]+)/i,             // Slack user tokens
  /\b(xapp-[a-zA-Z0-9-]+)/i,             // Slack app tokens
  /\b([0-9]{8,}:[\w-]{35,})/,            // Telegram bot tokens
  /\b(ghp_[a-zA-Z0-9]{36,})/,            // GitHub PATs (classic)
  /\b(github_pat_[a-zA-Z0-9_]{20,})/,    // GitHub PATs (fine-grained)
  /\b(gsk_[a-zA-Z0-9]{20,})/i,           // Groq keys
  /\b(key-[a-zA-Z0-9]{20,})/i,           // Generic API keys
  /\b(Bearer\s+[a-zA-Z0-9._+/=-]{20,})/i, // Bearer tokens (including JWT chars)
  /\b(ntn_[a-zA-Z0-9]{20,})/,            // Notion integration tokens
  /\b(secret_[a-zA-Z0-9]{20,})/,         // Notion / generic secret tokens
  /\b(sk_live_[a-zA-Z0-9]{20,})/,        // Stripe live secret keys
  /\b(pk_live_[a-zA-Z0-9]{20,})/,        // Stripe live publishable keys
  /\b(xi-[a-zA-Z0-9]{20,})/,             // ElevenLabs keys
  /\b(AKIA[0-9A-Z]{16})/,               // AWS access keys
  /\b(eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,})/, // JWT tokens
  /\b((?:postgres|mysql|mongodb|redis)(?:ql)?:\/\/[^\s"']+)/i, // Database connection URLs
  /password\s*[:=]\s*\S+/i,              // password assignments (shell/ini)
  /"password"\s*:\s*"[^"]+"/i,           // password in JSON
  /api[_-]?key\s*[:=]\s*\S+/i,           // api key assignments (shell/ini)
  /"api[_-]?key"\s*:\s*"[^"]+"/i,        // api key in JSON
  /secret[_-]?key\s*[:=]\s*\S+/i,        // secret key assignments (shell/ini)
];

/** Pre-compiled global variants for redaction (avoids new RegExp per call). */
const SENSITIVE_PATTERNS_GLOBAL: RegExp[] = SENSITIVE_PATTERNS.map(
  (p) => new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g")
);

/** Dynamic set of known secret values (populated when credentials are decrypted). */
const knownSecrets = new Set<string>();

/** Register secret values for exact-match redaction. Called when credentials are decrypted. */
export function registerSecretValues(values: string[]): void {
  for (const v of values) {
    if (v.length >= 4) knownSecrets.add(v);
  }
}

/** Clear all registered secrets. Call at session boundaries to prevent unbounded growth. */
export function clearSecrets(): void {
  knownSecrets.clear();
}

/** Check if text contains sensitive credentials or secrets. */
export function containsSensitiveData(text: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(text));
}

/** Replace known credential patterns in text with [REDACTED]. Best-effort — won't catch all custom keys. */
export function redactSensitiveData(text: string): string {
  let result = text;

  // Pattern-based redaction
  for (const pattern of SENSITIVE_PATTERNS_GLOBAL) {
    result = result.replace(pattern, "[REDACTED]");
  }

  // Exact-match redaction for known credential values
  for (const secret of knownSecrets) {
    if (result.includes(secret)) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
  }

  return result;
}

/**
 * Strip [Tool: xxx → summary] annotations that the LLM may echo from session history.
 * These are injected by sessionToMessages() for LLM context but should never reach users.
 */
const TOOL_ANNOTATION_RE = /\[Tool:\s*[\w-]+\s*(?:→|->)\s*[^\]]*\]/gs;

export function stripToolAnnotations(text: string): string {
  return text.replace(TOOL_ANNOTATION_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}
