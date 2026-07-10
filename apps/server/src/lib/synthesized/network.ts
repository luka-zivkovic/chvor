import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { SynthesizedToolError } from "../errors.ts";
import { isPrivateHostname, isPrivateIp } from "../url-safety.ts";

const ALLOW_PRIVATE = process.env.CHVOR_SYNTH_ALLOW_PRIVATE === "1";

// ── Network safety ─────────────────────────────────────────────

export interface ResolvedTarget {
  url: URL;
  resolvedIp: string;
  hostname: string;
}

/**
 * Validate the URL and resolve the hostname exactly once.
 * The returned resolvedIp is what the HTTP request will actually connect to,
 * preventing a second DNS lookup that could rebind to a private address.
 */
export async function resolveSafeSynthesizedTarget(rawUrl: string): Promise<ResolvedTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SynthesizedToolError(`invalid URL: ${rawUrl}`, {
      code: "synth.url_blocked",
      context: { rawUrl, reason: "parse_failed" },
      userFacing: true,
    });
  }
  if (parsed.protocol !== "https:") {
    throw new SynthesizedToolError(
      `non-HTTPS blocked (got ${parsed.protocol}) — synthesized tool calls require HTTPS`,
      { code: "synth.url_blocked", context: { rawUrl, reason: "non_https" }, userFacing: true }
    );
  }
  const hostname = parsed.hostname;
  // Block IP literals — hostname must be DNS-resolvable
  if (/^[0-9.]+$/.test(hostname) || hostname.includes(":")) {
    throw new SynthesizedToolError(`IP literal hostname blocked: ${hostname}`, {
      code: "synth.url_blocked",
      context: { hostname, reason: "ip_literal" },
      userFacing: true,
    });
  }
  if (!ALLOW_PRIVATE && isPrivateHostname(hostname)) {
    throw new SynthesizedToolError(`private/internal hostname blocked: ${hostname}`, {
      code: "synth.url_blocked",
      context: { hostname, reason: "private_hostname" },
      userFacing: true,
    });
  }
  const { address } = await lookup(hostname);
  if (!ALLOW_PRIVATE && isPrivateIp(address)) {
    throw new SynthesizedToolError(`private/link-local address blocked: ${hostname} → ${address}`, {
      code: "synth.url_blocked",
      context: { hostname, address, reason: "private_resolution" },
      userFacing: true,
    });
  }
  return { url: parsed, resolvedIp: address, hostname };
}

/** Legacy alias kept for spec-fetcher callers. */
export async function assertSafeSynthesizedUrl(rawUrl: string): Promise<URL> {
  const { url } = await resolveSafeSynthesizedTarget(rawUrl);
  return url;
}

// ── Pinned-IP HTTPS request ────────────────────────────────────

export interface PinnedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  size: number;
}

/**
 * HTTPS request where the connection is pinned to `target.resolvedIp`, while
 * SNI and the `Host:` header preserve the original hostname so TLS cert
 * validation + virtual hosting still work. This closes the DNS-rebinding
 * window between the safety check and the actual connection.
 */
export async function pinnedHttpsRequest(args: {
  target: ResolvedTarget;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
  maxBytes: number;
}): Promise<PinnedResponse> {
  const { target, method, headers, body, timeoutMs, maxBytes } = args;
  const { url, resolvedIp, hostname } = target;

  return await new Promise<PinnedResponse>((resolve, reject) => {
    const options: https.RequestOptions = {
      method,
      host: resolvedIp,
      servername: hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, Host: hostname },
      timeout: timeoutMs,
    };
    const req = https.request(options, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (size + c.byteLength > maxBytes) {
          const remaining = maxBytes - size;
          if (remaining > 0) chunks.push(c.subarray(0, remaining));
          size = maxBytes;
          truncated = true;
          req.destroy();
          return;
        }
        chunks.push(c);
        size += c.byteLength;
      });
      res.on("end", () => {
        const headersOut: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headersOut[k.toLowerCase()] = v;
          else if (Array.isArray(v)) headersOut[k.toLowerCase()] = v.join(", ");
        }
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          headers: headersOut,
          body: Buffer.concat(chunks),
          truncated,
          size,
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}
