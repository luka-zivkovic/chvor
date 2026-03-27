/**
 * Validates a skill markdown file for publishing to the registry.
 * Inlined from @chvor/shared for standalone npm distribution.
 */

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const REQUIRED_FIELDS = ["name", "description", "version", "author"];
const MAX_SIZE_BYTES = 50_000;

// Patterns that suggest secrets or API keys
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Parses YAML frontmatter from markdown content.
 * Lightweight parser — does not depend on gray-matter so it can run in CLI/browser.
 * Handles: scalar values, inline arrays [a, b], and multi-line list items (- item).
 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const fm: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    // Indented list item (e.g., "  - value")
    const listItemMatch = line.match(/^\s+-\s+(.+)/);
    if (listItemMatch && currentKey) {
      if (!currentList) currentList = [];
      currentList.push(listItemMatch[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    // Flush any pending list to the current key
    if (currentKey && currentList) {
      fm[currentKey] = currentList;
      currentList = null;
      currentKey = null;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    // Skip indented keys (nested objects like requires.credentials)
    if (line.match(/^\s+\S/)) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (!key) continue;

    // Inline array: [a, b, c]
    const inlineArrayMatch = rawValue.match(/^\[(.+)\]$/);
    if (inlineArrayMatch) {
      fm[key] = inlineArrayMatch[1].split(",").map((v) =>
        v.trim().replace(/^["']|["']$/g, ""),
      );
      continue;
    }

    if (rawValue) {
      fm[key] = rawValue.replace(/^["']|["']$/g, "");
    } else {
      // Empty value — might be followed by list items
      currentKey = key;
      currentList = null;
    }
  }

  // Flush final pending list
  if (currentKey && currentList) {
    fm[currentKey] = currentList;
  }

  return fm;
}

export function validateSkillForPublishing(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Size check
  const sizeBytes = new TextEncoder().encode(content).length;
  if (sizeBytes > MAX_SIZE_BYTES) {
    errors.push(`File too large: ${sizeBytes} bytes (max ${MAX_SIZE_BYTES})`);
  }

  // Frontmatter
  const fm = parseFrontmatter(content);
  if (!fm) {
    errors.push("Missing YAML frontmatter (--- block)");
    return { valid: false, errors, warnings };
  }

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!fm[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Version must be valid semver
  if (fm.version && !SEMVER_RE.test(String(fm.version))) {
    errors.push(`Invalid version "${fm.version}" — must be semver (e.g. 1.0.0)`);
  }

  // Check for secrets in content
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      errors.push("Content appears to contain a secret or API key");
      break;
    }
  }

  // Body must exist
  const bodyMatch = content.match(/^---[\s\S]*?---\r?\n([\s\S]*)$/);
  const body = bodyMatch?.[1]?.trim();
  if (!body) {
    warnings.push("Skill has no instructions body after frontmatter");
  }

  // Optional warnings
  if (!fm.category) {
    warnings.push("No category specified — skill may be harder to discover");
  }
  if (!fm.tags) {
    warnings.push("No tags specified — consider adding tags for discoverability");
  }

  return { valid: errors.length === 0, errors, warnings };
}
