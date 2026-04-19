/**
 * Executes a single endpoint call against a synthesized tool.
 *
 * Pipeline:
 *  1. Resolve credential + ConnectionConfig.
 *  2. Build URL from baseUrl + path + pathParams + queryParams.
 *  3. Network safety: HTTPS-only, block private hostnames, resolve DNS once, pin the
 *     request to that resolved IP (prevents DNS-rebinding / TOCTOU).
 *  4. Apply auth per connection_config.auth.scheme (CRLF-stripped).
 *  5. For non-GET, go through approval-gate.requestApproval.
 *  6. Fetch via https.request with pre-resolved IP + SNI, then truncate + classify.
 */

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import * as https from "node:https";
import * as http from "node:http";
import type { Tool, SynthesizedEndpoint, ConnectionConfig } from "@chvor/shared";
import { getCredentialData, listCredentials } from "../db/credential-store.ts";
import { isPrivateIp, isPrivateHostname } from "./url-safety.ts";
import { logError } from "./error-logger.ts";
import {
  requestApproval,
  recordSuccess,
  recordFailure,
  getSessionStats,
} from "./approval-gate.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 200 * 1024;
const TRUNCATION_PREVIEW_BYTES = 4 * 1024;
const ALLOW_PRIVATE = process.env.CHVOR_SYNTH_ALLOW_PRIVATE === "1";

export interface CallContext {
  sessionId?: string;
  originClientId?: string;
}

export type CallResult =
  | { ok: true; status: number; body: unknown; truncated: boolean; size: number; durationMs: number }
  | { ok: false; error: string; status?: number; durationMs: number; diagnosis?: AuthDiagnosis };

export interface AuthDiagnosis {
  error: "auth_failed";
  status: number;
  likelyCause:
    | "missing_scope"
    | "expired_token"
    | "wrong_auth_scheme"
    | "endpoint_requires_oauth"
    | "rate_limited"
    | "unknown";
  userFacingHint: string;
  aiGuidance: string;
}

// ── Credential lookup ──────────────────────────────────────────

function findCredentialId(credentialType: string, pinnedId?: string): string | null {
  try {
    const creds = listCredentials();
    if (pinnedId) {
      const pinned = creds.find((c) => c.id === pinnedId && c.type === credentialType);
      if (pinned) return pinned.id;
      // Fall through to type-match if the pinned id no longer exists / was replaced.
    }
    const match = creds.find((c) => c.type === credentialType);
    return match?.id ?? null;
  } catch (err) {
    console.warn("[synthesized-caller] listCredentials failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── URL construction ───────────────────────────────────────────

function substitutePathParams(
  path: string,
  pathParams: Record<string, string | number>,
): string {
  return path.replace(/\{([^}]+)\}/g, (match, key: string) => {
    const k = key.trim();
    if (!(k in pathParams)) return match;
    return encodeURIComponent(String(pathParams[k]));
  });
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function buildUrl(
  baseUrl: string,
  endpointPath: string,
  pathParams: Record<string, string | number>,
  queryParams: Record<string, string | number | boolean>,
): string {
  const path = substitutePathParams(endpointPath, pathParams);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(normalizeBaseUrl(baseUrl) + normalizedPath);
  for (const [key, value] of Object.entries(queryParams)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

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
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`non-HTTPS blocked (got ${parsed.protocol}) — synthesized tool calls require HTTPS`);
  }
  const hostname = parsed.hostname;
  // Block IP literals — hostname must be DNS-resolvable
  if (/^[0-9.]+$/.test(hostname) || hostname.includes(":")) {
    throw new Error(`IP literal hostname blocked: ${hostname}`);
  }
  if (!ALLOW_PRIVATE && isPrivateHostname(hostname)) {
    throw new Error(`private/internal hostname blocked: ${hostname}`);
  }
  const { address } = await lookup(hostname);
  if (!ALLOW_PRIVATE && isPrivateIp(address)) {
    throw new Error(`private/link-local address blocked: ${hostname} → ${address}`);
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

// ── Auth application ───────────────────────────────────────────

/** Strip CR/LF to prevent header injection via credential values or templates. */
function stripCrlf(input: string): string {
  return input.replace(/[\r\n]+/g, "");
}

function applyAuth(
  headers: Record<string, string>,
  url: URL,
  auth: ConnectionConfig["auth"],
  data: Record<string, string>,
): void {
  const apiKey = data.apiKey ?? data.token ?? data.accessToken ?? "";

  const renderTemplate = (template: string | undefined, fallback: string): string => {
    const t = template ?? fallback;
    const rendered = t.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => data[k] ?? "");
    return stripCrlf(rendered);
  };

  switch (auth.scheme) {
    case "bearer":
      headers["Authorization"] = renderTemplate(auth.headerTemplate, `Bearer ${apiKey}`);
      break;
    case "api-key-header":
      headers[stripCrlf(auth.headerName ?? "x-api-key")] = renderTemplate(auth.headerTemplate, apiKey);
      break;
    case "basic": {
      const user = data.username ?? "";
      const pass = data.password ?? apiKey;
      headers["Authorization"] = `Basic ${Buffer.from(`${stripCrlf(user)}:${stripCrlf(pass)}`).toString("base64")}`;
      break;
    }
    case "query-param":
      url.searchParams.set(auth.queryParam ?? "api_key", apiKey);
      break;
    case "custom":
      if (auth.headerName && auth.headerTemplate) {
        headers[stripCrlf(auth.headerName)] = renderTemplate(auth.headerTemplate, apiKey);
      }
      break;
  }
}

// ── Auth diagnostics ───────────────────────────────────────────

function diagnoseAuthError(args: {
  status: number;
  responseBody: string;
  tool: Tool;
  endpoint: SynthesizedEndpoint;
  sessionId?: string;
}): AuthDiagnosis {
  const { status, responseBody, tool, endpoint, sessionId } = args;
  const body = responseBody.toLowerCase();
  const stats = getSessionStats(sessionId, tool.id, endpoint.name);

  if (status === 429 || /rate.?limit|too many requests/.test(body)) {
    return {
      error: "auth_failed",
      status,
      likelyCause: "rate_limited",
      userFacingHint: `${tool.metadata.name} rate-limited this call. Wait a minute and try again.`,
      aiGuidance: "Do not ask the user to re-enter credentials. Back off and retry later.",
    };
  }

  if (/expired|invalid_token|token revoked|jwt exp|token.* (expired|revoked)/.test(body)) {
    return {
      error: "auth_failed",
      status,
      likelyCause: "expired_token",
      userFacingHint: `Your ${tool.metadata.name} credential looks expired. Generate a fresh token and re-enter it.`,
      aiGuidance: "Call native__request_credential with existingCredentialId set so the user can refresh the token.",
    };
  }

  if (/scope|permission|insufficient|not authorized for this action|forbidden/.test(body)) {
    return {
      error: "auth_failed",
      status,
      likelyCause: "missing_scope",
      userFacingHint: `Your ${tool.metadata.name} credential is valid but lacks a scope/permission this endpoint (${endpoint.name}) needs. Check the ${tool.metadata.name} API docs for the required scope, then generate a new token with it.`,
      aiGuidance: "Do not prompt for credential re-entry. Relay userFacingHint and suggest a read-only alternative or different endpoint.",
    };
  }

  if (status === 401 && stats.toolSuccessCount === 0 && stats.toolFailureCount >= 1) {
    return {
      error: "auth_failed",
      status,
      likelyCause: "wrong_auth_scheme",
      userFacingHint: `Can't authenticate to ${tool.metadata.name} with the current credential. The auth scheme in the tool config may be wrong — try calling native__repair_synthesized_tool, or check the ${tool.metadata.name} docs.`,
      aiGuidance: "Try native__repair_synthesized_tool once before asking the user to re-enter credentials.",
    };
  }

  if (stats.toolSuccessCount > 0) {
    return {
      error: "auth_failed",
      status,
      likelyCause: "missing_scope",
      userFacingHint: `Your ${tool.metadata.name} credential works for other endpoints but not ${endpoint.name} — the token is missing a scope this action requires. Check the API docs for the required scope.`,
      aiGuidance: "Do not prompt for credential re-entry. Relay userFacingHint.",
    };
  }

  return {
    error: "auth_failed",
    status,
    likelyCause: "unknown",
    userFacingHint: `${tool.metadata.name} rejected the call (${status}). Double-check that the credential is correct and has the needed permissions.`,
    aiGuidance: "Consider native__repair_synthesized_tool before prompting for credential re-entry.",
  };
}

// ── Main entry ─────────────────────────────────────────────────

function resolveTimeoutMs(tool: Tool): number {
  const configured = tool.synthesized?.timeoutMs;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(configured), 1_000), MAX_TIMEOUT_MS);
}

export async function callSynthesizedEndpoint(
  tool: Tool,
  endpointName: string,
  args: Record<string, unknown>,
  context: CallContext = {},
): Promise<CallResult> {
  const started = Date.now();

  if (!tool.synthesized || !tool.endpoints) {
    return { ok: false, error: "tool is not a synthesized tool", durationMs: 0 };
  }

  const endpoint = tool.endpoints.find((e) => e.name === endpointName);
  if (!endpoint) {
    return {
      ok: false,
      error: `endpoint "${endpointName}" not found on tool ${tool.id}. Available: ${tool.endpoints.map((e) => e.name).join(", ")}`,
      durationMs: Date.now() - started,
    };
  }

  // Resolve credential (optionally pinned by id)
  const credType = tool.synthesized.credentialType;
  const credId = findCredentialId(credType, tool.synthesized.credentialId);
  if (!credId) {
    return {
      ok: false,
      error: `no credential of type "${credType}" found — ask the user to add one via native__request_credential`,
      durationMs: Date.now() - started,
    };
  }
  const cred = getCredentialData(credId);
  if (!cred) {
    return {
      ok: false,
      error: `credential ${credId} could not be decrypted`,
      durationMs: Date.now() - started,
    };
  }

  const connection = cred.cred.connectionConfig;
  if (!connection?.baseUrl) {
    return {
      ok: false,
      error: `credential "${credType}" has no connectionConfig.baseUrl — cannot call endpoint`,
      durationMs: Date.now() - started,
    };
  }

  // Partition args into pathParams, queryParams, body
  const pathParams: Record<string, string | number> = {};
  for (const p of endpoint.pathParams ?? []) {
    const v = args[p.name];
    if (v === undefined || v === null) {
      if (p.required) {
        return { ok: false, error: `missing required path param: ${p.name}`, durationMs: Date.now() - started };
      }
      continue;
    }
    pathParams[p.name] = p.type === "integer" ? Number(v) : String(v);
  }

  const queryParams: Record<string, string | number | boolean> = {};
  for (const p of endpoint.queryParams ?? []) {
    const v = args[p.name];
    if (v === undefined || v === null) {
      if (p.required) {
        return { ok: false, error: `missing required query param: ${p.name}`, durationMs: Date.now() - started };
      }
      continue;
    }
    if (p.type === "boolean") queryParams[p.name] = Boolean(v);
    else if (p.type === "integer" || p.type === "number") queryParams[p.name] = Number(v);
    else queryParams[p.name] = String(v);
  }

  let bodyValue: unknown;
  if (endpoint.bodySchema && endpoint.method !== "GET") {
    const bodyArg = args.body ?? args;
    if (bodyArg && typeof bodyArg === "object") bodyValue = bodyArg;
  }

  // Build + resolve target (DNS lookup happens once here)
  let target: ResolvedTarget;
  try {
    const urlStr = buildUrl(connection.baseUrl, endpoint.path, pathParams, queryParams);
    target = await resolveSafeSynthesizedTarget(urlStr);
  } catch (err) {
    return {
      ok: false,
      error: `URL safety check failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - started,
    };
  }

  // Apply auth + headers
  const headersObj: Record<string, string> = {
    "Accept": "application/json",
  };
  if (bodyValue !== undefined) headersObj["Content-Type"] = "application/json";
  if (connection.headers) {
    for (const [k, v] of Object.entries(connection.headers)) {
      headersObj[stripCrlf(k)] = stripCrlf(v);
    }
  }
  applyAuth(headersObj, target.url, connection.auth, cred.data);

  // Non-GET approval gate
  if (endpoint.method !== "GET") {
    const argsPreview = JSON.stringify({
      path: pathParams,
      query: queryParams,
      body: bodyValue,
    }, null, 2).slice(0, 2000);

    const approval = await requestApproval({
      sessionId: context.sessionId,
      originClientId: context.originClientId,
      toolId: tool.id,
      toolName: tool.metadata.name,
      endpointName: endpoint.name,
      method: endpoint.method,
      path: endpoint.path,
      resolvedUrl: target.url.toString(),
      argsPreview,
      verified: tool.synthesized.verified,
      source: tool.synthesized.source,
    });

    if (!approval.allowed) {
      return {
        ok: false,
        error: approval.reason === "denied"
          ? "user denied execution"
          : approval.reason === "no-ws"
          ? "cannot prompt for approval — no active UI connection"
          : "approval timed out",
        durationMs: Date.now() - started,
      };
    }
  }

  // Execute via pinned-IP HTTPS request
  const callId = randomUUID();
  const timeoutMs = resolveTimeoutMs(tool);
  let response: PinnedResponse;
  try {
    response = await pinnedHttpsRequest({
      target,
      method: endpoint.method,
      headers: headersObj,
      body: bodyValue !== undefined ? Buffer.from(JSON.stringify(bodyValue), "utf-8") : undefined,
      timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("mcp_crash" as const, msg, {
      kind: "synthesized_call",
      callId,
      toolId: tool.id,
      endpoint: endpoint.name,
      host: target.hostname,
    });
    recordFailure(context.sessionId, tool.id, endpoint.name);
    return { ok: false, error: `network error: ${msg}`, durationMs: Date.now() - started };
  }

  const rawText = response.body.toString("utf-8");
  const truncated = response.truncated;
  const size = response.size;

  logError("mcp_crash" as const, "", {
    kind: "synthesized_call",
    callId,
    toolId: tool.id,
    endpoint: endpoint.name,
    method: endpoint.method,
    host: target.hostname,
    status: response.status,
    durationMs: Date.now() - started,
  });

  // Parse body
  let parsed: unknown;
  const contentType = response.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    try { parsed = JSON.parse(rawText); } catch { parsed = rawText; }
  } else {
    parsed = rawText;
  }

  const finalBody = truncated
    ? {
        truncated: true as const,
        preview: rawText.slice(0, TRUNCATION_PREVIEW_BYTES),
        size,
      }
    : parsed;

  if (response.status === 401 || response.status === 403 || response.status === 429) {
    recordFailure(context.sessionId, tool.id, endpoint.name);
    const diagnosis = diagnoseAuthError({
      status: response.status,
      responseBody: rawText,
      tool,
      endpoint,
      sessionId: context.sessionId,
    });
    return {
      ok: false,
      status: response.status,
      error: `${response.status} ${response.statusText}: ${diagnosis.userFacingHint}`,
      durationMs: Date.now() - started,
      diagnosis,
    };
  }

  if (response.status >= 400) {
    recordFailure(context.sessionId, tool.id, endpoint.name);
    return {
      ok: false,
      status: response.status,
      error: `${response.status} ${response.statusText}: ${rawText.slice(0, 500)}`,
      durationMs: Date.now() - started,
    };
  }

  recordSuccess(context.sessionId, tool.id, endpoint.name);
  return {
    ok: true,
    status: response.status,
    body: finalBody,
    truncated,
    size,
    durationMs: Date.now() - started,
  };
}
