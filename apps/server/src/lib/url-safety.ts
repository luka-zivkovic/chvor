/**
 * Shared URL safety utilities — SSRF prevention for all user-provided URLs.
 *
 * A single source of truth so private-network checks can't diverge across files.
 */

import { isIPv4, isIPv6 } from "node:net";

/**
 * Legacy regex patterns matching private/internal IPv4 addresses. Retained as a
 * defensive fallback for inputs that are not valid IP literals. The numeric
 * checks below are the real boundary.
 */
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

function ipv4Octets(addr: string): number[] | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets;
}

function isPrivateIPv4(addr: string): boolean {
  const o = ipv4Octets(addr);
  if (!o) return false;
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast + reserved (224.0.0.0+)
  return false;
}

/**
 * Expand any valid IPv6 literal (compressed, with embedded IPv4, or zone id) to
 * its 16 bytes. Returns null if the input is not a parseable IPv6 address.
 */
function ipv6ToBytes(input: string): number[] | null {
  let addr = input;
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);

  // Convert a trailing embedded IPv4 (e.g. ::ffff:1.2.3.4) into two hextets.
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = ipv4Octets(v4[1]);
    if (!o) return null;
    const hex = `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
    addr = addr.slice(0, v4.index) + hex;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];

  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function isPrivateIPv6(addr: string): boolean {
  const b = ipv6ToBytes(addr);
  if (!b) return false;

  const allZeroExceptLast = b.slice(0, 15).every((x) => x === 0);
  if (allZeroExceptLast && b[15] === 1) return true; // ::1 loopback
  if (b.every((x) => x === 0)) return true; // :: unspecified

  // Embedded IPv4 in the ::/96 space — check the trailing 4 bytes as IPv4:
  //   - IPv4-mapped     ::ffff:a.b.c.d  (bytes[10..11] == 0xff)
  //   - IPv4-compatible ::a.b.c.d       (bytes[10..11] == 0, deprecated but
  //     still resolvable; routability is OS-dependent, so treat as the v4)
  // :: and ::1 are handled above, so the compatible branch can't swallow them.
  if (b.slice(0, 10).every((x) => x === 0)) {
    if (b[10] === 0xff && b[11] === 0xff) {
      return isPrivateIPv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
    }
    if (b[10] === 0 && b[11] === 0) {
      return isPrivateIPv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
    }
  }
  if ((b[0] & 0xfe) === 0xfc) return true; // ULA fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (b[0] === 0xff) return true; // multicast ff00::/8
  return false;
}

/**
 * Check if a resolved IP address is private/internal. This is the SSRF boundary
 * applied to the address DNS actually resolved to, so it must understand every
 * shape `dns.lookup` can return — IPv4, IPv6, and IPv4-mapped IPv6.
 */
export function isPrivateIp(address: string): boolean {
  if (!address) return false;
  const addr = address.trim().toLowerCase();
  if (isIPv4(addr)) return isPrivateIPv4(addr);
  if (isIPv6(addr)) return isPrivateIPv6(addr);
  // Not a recognized IP literal — fall back to the legacy regexes defensively.
  return PRIVATE_IP_RANGES.some((r) => r.test(addr));
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

  // Bracketed IPv6 literal — defer to the numeric isPrivateIp so this branch
  // can't drift from the real post-DNS boundary (catches mapped/compatible
  // v4, full fc00::/7, fe80::/10, etc.).
  if (host.startsWith("[") && host.endsWith("]")) {
    if (isPrivateIp(host.slice(1, -1))) return true;
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
