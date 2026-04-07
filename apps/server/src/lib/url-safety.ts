/**
 * Shared URL safety utilities — SSRF prevention for all user-provided URLs.
 *
 * A single source of truth so private-network checks can't diverge across files.
 */

/** Regex patterns matching private/internal resolved IP addresses. */
export const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
];

/** Check if a resolved IP address is private/internal. */
export function isPrivateIp(address: string): boolean {
  return PRIVATE_IP_RANGES.some((r) => r.test(address));
}

/** Check if a hostname is a private/internal network address. */
export function isPrivateHostname(host: string): boolean {
  // Normalize
  host = host.toLowerCase();

  // Loopback
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "[::1]"
  ) return true;

  // IPv6 loopback variants (expanded forms)
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    // Normalize IPv6: collapse to check if it's loopback or private
    if (/^(0+:){7}0*1$/.test(inner) || /^::0*1$/.test(inner) || inner === "::") return true;
    // IPv6 ULA (fc00::/7)
    if (/^f[cd]/i.test(inner)) return true;
    // IPv6 link-local (fe80::/10)
    if (/^fe[89ab]/i.test(inner)) return true;
  }

  // IPv4 private ranges (RFC 1918)
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (host.startsWith("169.254.")) return true; // link-local

  // 172.16.0.0 – 172.31.255.255
  if (host.startsWith("172.")) {
    const parts = host.split(".");
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) return true;
  }

  // Metadata endpoints
  if (host === "metadata.google.internal") return true;

  // .local / .internal suffixes
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;

  return false;
}

/**
 * Assert a URL is safe for server-side fetch (SSRF prevention).
 * Blocks private/internal networks, non-http(s) protocols.
 * Throws on violation.
 */
export function assertSafeUrl(rawUrl: string, label = "URL"): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid ${label}: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http:// and https:// URLs are allowed for ${label}`);
  }

  if (isPrivateHostname(parsed.hostname)) {
    throw new Error(`${label} must not point to private/internal networks`);
  }
}

/**
 * Returns true if the URL points to a local address (localhost, 127.0.0.1, ::1, .local).
 * Used to validate local-only providers like Ollama, LM Studio, vLLM.
 */
export function isLocalUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  } catch {
    return false;
  }
}

/**
 * Assert a URL points to a local address. Throws on violation.
 */
export function assertLocalUrl(base: string, providerName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`Invalid ${providerName} baseUrl: ${base}`);
  }
  const proto = parsed.protocol;
  const host = parsed.hostname.toLowerCase();
  if (
    (proto !== "http:" && proto !== "https:") ||
    !(host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local"))
  ) {
    throw new Error(`${providerName} baseUrl must be a local http(s) address, got: ${base}`);
  }
}
