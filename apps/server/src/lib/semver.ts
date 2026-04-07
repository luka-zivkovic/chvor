const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Parse a strict semver string (major.minor.patch) into numeric parts.
 * Strips pre-release suffixes (e.g. "1.0.0-beta" → treats as "1.0.0")
 * and warns if the input is not strict semver.
 */
function parseSemver(v: string): [number, number, number] {
  // Strip pre-release/build metadata for comparison
  const clean = v.split("-")[0].split("+")[0];
  if (!SEMVER_RE.test(clean)) {
    console.warn(`[semver] non-standard version "${v}" — expected major.minor.patch`);
  }
  const parts = clean.split(".").map((x) => {
    const n = parseInt(x, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Compare two semver strings (major.minor.patch). Returns positive if a > b, negative if a < b, 0 if equal. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = pa[i] - pb[i];
    if (diff !== 0) return diff;
  }
  return 0;
}
