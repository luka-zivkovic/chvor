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
import { getCredentialData, listCredentials, updateCredential } from "../db/credential-store.ts";
import { isPrivateIp, isPrivateHostname } from "./url-safety.ts";
import { logError } from "./error-logger.ts";
import { insertActivity } from "../db/activity-store.ts";
import {
  requestApproval,
  recordSuccess,
  recordFailure,
  getSessionStats,
} from "./approval-gate.ts";
import { refreshAccessToken, type OAuthProviderConfig } from "./oauth-engine.ts";
import { getDirectOAuthProvider } from "./oauth-providers.ts";
import { SynthesizedToolError } from "./errors.ts";
import { pickCredential, type PickResult } from "./credential-picker.ts";
import {
  extractSecretValues,
  redactKnownSecrets,
  withSecretSeal,
} from "./credential-injector.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 200 * 1024;
const TRUNCATION_PREVIEW_BYTES = 4 * 1024;
const ALLOW_PRIVATE = process.env.CHVOR_SYNTH_ALLOW_PRIVATE === "1";

export interface CallContext {
  sessionId?: string;
  originClientId?: string;
  /** Skill-aggregated `preferredUsageContext` used by the multi-credential picker. */
  preferredUsageContext?: string[];
  /** Optional sink for picker rationale; orchestrator wires this to a canvas event. */
  onCredentialResolved?: (info: {
    credentialType: string;
    credentialId: string;
    credentialName: string;
    reason: PickResult["reason"];
    candidateCount: number;
    detail?: string;
  }) => void;
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

function pickCredentialForCall(
  credentialType: string,
  context: CallContext,
  toolPinnedId?: string
): PickResult | null {
  try {
    return pickCredential(credentialType, {
      sessionId: context.sessionId ?? null,
      toolPinnedId,
      preferredUsageContext: context.preferredUsageContext,
    });
  } catch (err) {
    console.warn(
      "[synthesized-caller] pickCredential failed:",
      err instanceof Error ? err.message : String(err)
    );
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
    throw new SynthesizedToolError(`invalid URL: ${rawUrl}`, {
      code: "synth.url_blocked",
      context: { rawUrl, reason: "parse_failed" },
      userFacing: true,
    });
  }
  if (parsed.protocol !== "https:") {
    throw new SynthesizedToolError(
      `non-HTTPS blocked (got ${parsed.protocol}) — synthesized tool calls require HTTPS`,
      { code: "synth.url_blocked", context: { rawUrl, reason: "non_https" }, userFacing: true },
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
    throw new SynthesizedToolError(
      `private/link-local address blocked: ${hostname} → ${address}`,
      {
        code: "synth.url_blocked",
        context: { hostname, address, reason: "private_resolution" },
        userFacing: true,
      },
    );
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

// ── OAuth refresh-token rotation (Track 0.7) ───────────────────
//
// When a synthesized OAuth call returns 401 and the credential has both a
// refreshToken and a tokenUrl (set by /oauth/synthesized/initiate or by the
// built-in OAuth flow), rotate transparently and let the caller retry once.
// Returns the refreshed credential data on success, null on any failure
// (token expired beyond refresh, network error, missing fields).

interface RefreshResult {
  data: Record<string, string>;
}

async function tryRefreshOAuthToken(
  credId: string,
  credName: string,
  data: Record<string, string>,
): Promise<RefreshResult | null> {
  const refreshToken = data.refreshToken;
  const clientId = data.clientId;
  if (!refreshToken || !clientId) return null;

  // Two paths: synthesized OAuth (tokenUrl persisted on the cred itself) or
  // built-in OAuth (look up the static provider config + setup credential
  // for the client_secret).
  let providerConfig: OAuthProviderConfig | null = null;
  let clientSecret: string | undefined = data.clientSecret;
  if (data.tokenUrl) {
    providerConfig = {
      id: data.provider ?? "synthesized",
      name: credName,
      authUrl: data.authUrl ?? "",
      tokenUrl: data.tokenUrl,
      scopes: data.scopes ? data.scopes.split(/\s+/).filter(Boolean) : [],
    };
  } else if (data.provider) {
    const builtin = getDirectOAuthProvider(data.provider);
    if (builtin) {
      providerConfig = builtin;
      try {
        const { getClientSecretForProvider } = await import("../routes/oauth.ts");
        clientSecret = clientSecret ?? getClientSecretForProvider(data.provider);
      } catch { /* best-effort */ }
    }
  }
  if (!providerConfig || !providerConfig.tokenUrl) return null;

  try {
    const tokens = await refreshAccessToken(providerConfig, refreshToken, clientId, clientSecret);
    const updated: Record<string, string> = {
      ...data,
      accessToken: tokens.accessToken,
    };
    if (tokens.refreshToken) updated.refreshToken = tokens.refreshToken;
    if (tokens.expiresAt) updated.expiresAt = tokens.expiresAt;
    if (tokens.scope) updated.scope = tokens.scope;
    updateCredential(credId, credName, updated);
    return { data: updated };
  } catch (err) {
    console.warn("[synthesized-caller] OAuth refresh failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Audit logging for mutating calls (Track 0.11) ──────────────
//
// Whenever a non-GET synthesized call returns 2xx we record one entry in
// activity_log so the user can see — after the fact — what their AI changed
// in third-party services on their behalf. This is best-effort: any failure
// here is swallowed so the actual tool result is still returned to the user.

const MAX_AUDIT_BODY_PREVIEW = 2_000;

function previewForAudit(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") {
    return value.length > MAX_AUDIT_BODY_PREVIEW
      ? value.slice(0, MAX_AUDIT_BODY_PREVIEW) + "…"
      : value;
  }
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > MAX_AUDIT_BODY_PREVIEW
      ? json.slice(0, MAX_AUDIT_BODY_PREVIEW) + "…"
      : json;
  } catch {
    return null;
  }
}

function recordSynthesizedMutationAudit(args: {
  tool: Tool;
  endpoint: SynthesizedEndpoint;
  resolvedUrl: string;
  pathParams: Record<string, string | number>;
  queryParams: Record<string, string | number | boolean>;
  body: unknown;
  responseStatus: number;
  responseBody: unknown;
  durationMs: number;
}): void {
  try {
    const lines: string[] = [];
    lines.push(`${args.endpoint.method} ${args.resolvedUrl}`);
    lines.push(`status: ${args.responseStatus} · duration: ${args.durationMs}ms`);
    if (Object.keys(args.pathParams).length > 0) {
      lines.push(`path params: ${JSON.stringify(args.pathParams)}`);
    }
    if (Object.keys(args.queryParams).length > 0) {
      lines.push(`query: ${JSON.stringify(args.queryParams)}`);
    }
    const bodyPreview = previewForAudit(args.body);
    if (bodyPreview) {
      lines.push(`request body:\n${bodyPreview}`);
    }
    const respPreview = previewForAudit(args.responseBody);
    if (respPreview) {
      lines.push(`response:\n${respPreview}`);
    }
    insertActivity({
      source: "synthesized-write",
      title: `${args.tool.metadata.name} · ${args.endpoint.name}`,
      // Phase E2 — defensive scrub of any credential value that somehow
      // landed in the request/response preview. The seal opened by the
      // caller registers the active credential's secret values; this strips
      // them before the activity row hits disk.
      content: redactKnownSecrets(lines.join("\n")),
    });
  } catch (err) {
    console.warn(
      "[synthesized-caller] audit log insert failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
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

  // Resolve credential via tiered picker (Phase E).
  const credType = tool.synthesized.credentialType;
  const pick = pickCredentialForCall(credType, context, tool.synthesized.credentialId);
  if (!pick) {
    return {
      ok: false,
      error: `no credential of type "${credType}" found — ask the user to add one via native__request_credential`,
      durationMs: Date.now() - started,
    };
  }
  const credId = pick.credentialId;
  const cred = getCredentialData(credId);
  if (!cred) {
    return {
      ok: false,
      error: `credential ${credId} could not be decrypted`,
      durationMs: Date.now() - started,
    };
  }
  // Surface rationale so the orchestrator can emit a canvas event.
  // We pass the credential NAME (safe — UI shows it already) but never
  // values. listCredentials() returns the name without decrypting.
  if (context.onCredentialResolved) {
    try {
      const summary = listCredentials().find((c) => c.id === credId);
      context.onCredentialResolved({
        credentialType: credType,
        credentialId: credId,
        credentialName: summary?.name ?? credId,
        reason: pick.reason,
        candidateCount: pick.candidateCount,
        detail: pick.detail,
      });
    } catch (err) {
      console.warn(
        "[synthesized-caller] credential rationale callback failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  const connection = cred.cred.connectionConfig;
  if (!connection?.baseUrl) {
    return {
      ok: false,
      error: `credential "${credType}" has no connectionConfig.baseUrl — cannot call endpoint`,
      durationMs: Date.now() - started,
    };
  }

  // Capture narrowed values so the closure below doesn't relose the types
  // when TS treats `tool` / `connection` as potentially-mutated closures.
  const baseUrl = connection.baseUrl;
  const synth = tool.synthesized;

  // Phase E2 — seal raw credential values for the duration of the call.
  // Anywhere downstream that calls `redactKnownSecrets` (event store, audit
  // log, error context) sees them replaced with «credential» so a stray
  // value never leaks into a persisted row.
  return withSecretSeal(extractSecretValues(cred.data), async () => {

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
    const urlStr = buildUrl(baseUrl, endpoint.path, pathParams, queryParams);
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
      pathParams: Object.keys(pathParams).length > 0 ? pathParams : undefined,
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
      body: bodyValue,
      verified: synth.verified,
      source: synth.source,
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

  // Track 0.7: transparent OAuth refresh on 401 — applies to both bearer
  // and api-key-header (some providers carry the access token in a custom
  // header rather than Authorization). One retry max, only if a refresh
  // token is present and the refresh exchange succeeds.
  if (response.status === 401 && cred.data.refreshToken) {
    const refreshed = await tryRefreshOAuthToken(credId, cred.cred.name, cred.data);
    if (refreshed) {
      // Rebuild headers with the new access token and re-fire the request
      // against the same already-resolved target (no second DNS round-trip,
      // so SSRF gates remain enforced from the original lookup).
      const retryHeaders: Record<string, string> = {
        "Accept": "application/json",
      };
      if (bodyValue !== undefined) retryHeaders["Content-Type"] = "application/json";
      if (connection.headers) {
        for (const [k, v] of Object.entries(connection.headers)) {
          retryHeaders[stripCrlf(k)] = stripCrlf(v);
        }
      }
      applyAuth(retryHeaders, target.url, connection.auth, refreshed.data);

      try {
        response = await pinnedHttpsRequest({
          target,
          method: endpoint.method,
          headers: retryHeaders,
          body: bodyValue !== undefined ? Buffer.from(JSON.stringify(bodyValue), "utf-8") : undefined,
          timeoutMs,
          maxBytes: MAX_RESPONSE_BYTES,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordFailure(context.sessionId, tool.id, endpoint.name);
        return { ok: false, error: `network error after token refresh: ${msg}`, durationMs: Date.now() - started };
      }

      const refreshedRawText = response.body.toString("utf-8");
      const refreshedTruncated = response.truncated;
      const refreshedSize = response.size;
      const refreshedContentType = response.headers["content-type"] ?? "";
      let refreshedParsed: unknown;
      if (refreshedContentType.includes("application/json")) {
        try { refreshedParsed = JSON.parse(refreshedRawText); } catch { refreshedParsed = refreshedRawText; }
      } else {
        refreshedParsed = refreshedRawText;
      }
      const refreshedFinalBody = refreshedTruncated
        ? { truncated: true as const, preview: refreshedRawText.slice(0, TRUNCATION_PREVIEW_BYTES), size: refreshedSize }
        : refreshedParsed;

      logError("mcp_crash" as const, "", {
        kind: "synthesized_call",
        callId,
        toolId: tool.id,
        endpoint: endpoint.name,
        method: endpoint.method,
        host: target.hostname,
        status: response.status,
        durationMs: Date.now() - started,
        refreshed: true,
      });

      if (response.status >= 200 && response.status < 300) {
        recordSuccess(context.sessionId, tool.id, endpoint.name);
        if (endpoint.method !== "GET") {
          recordSynthesizedMutationAudit({
            tool,
            endpoint,
            resolvedUrl: target.url.toString(),
            pathParams,
            queryParams,
            body: bodyValue,
            responseStatus: response.status,
            responseBody: refreshedFinalBody,
            durationMs: Date.now() - started,
          });
        }
        return {
          ok: true,
          status: response.status,
          body: refreshedFinalBody,
          truncated: refreshedTruncated,
          size: refreshedSize,
          durationMs: Date.now() - started,
        };
      }
      // Refresh succeeded but the retry still failed — fall through to the
      // standard error pipeline so the user gets a real diagnosis.
    }
  }

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
  if (endpoint.method !== "GET") {
    recordSynthesizedMutationAudit({
      tool,
      endpoint,
      resolvedUrl: target.url.toString(),
      pathParams,
      queryParams,
      body: bodyValue,
      responseStatus: response.status,
      responseBody: finalBody,
      durationMs: Date.now() - started,
    });
  }
  return {
    ok: true,
    status: response.status,
    body: finalBody,
    truncated,
    size,
    durationMs: Date.now() - started,
  };
  });
}

// ── Generic credential probe (Track 0.3) ───────────────────────

export interface ProbeResult {
  ok: boolean;
  status?: number;
  /** Resolved URL we actually called (helps diagnose typos in baseUrl). */
  probedUrl?: string;
  /** Short body preview when failing. */
  bodyPreview?: string;
  error?: string;
  durationMs: number;
}

/**
 * Probes a service with a candidate ConnectionConfig + credential data, before
 * the credential is saved. Useful as a pre-save sanity check so users find out
 * about wrong baseUrls / auth-scheme mismatches immediately rather than minutes
 * later when the AI tries to use the credential.
 *
 * Strategy: a single GET against `probePath` (or `/` if omitted) on baseUrl, with
 * full SSRF gates and the same auth pipeline as live calls. Any 2xx/3xx is a
 * pass; 401/403 is a fail with the diagnosis carried in the body preview.
 *
 * Note: many APIs serve a 404 at root but a 200 at e.g. `/v1/me`. Callers
 * should pass a `probePath` when known. Without one, a 404 is treated as
 * "host reachable but path unknown" and reported as ambiguous — not a hard
 * failure — because the credential may still be valid for actual endpoints.
 */
export async function probeCredentialConfig(args: {
  connection: ConnectionConfig;
  data: Record<string, string>;
  probePath?: string;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const started = Date.now();
  const { connection, data, probePath } = args;
  const timeoutMs = Math.min(args.timeoutMs ?? 15_000, MAX_TIMEOUT_MS);

  if (!connection.baseUrl) {
    return { ok: false, error: "connectionConfig.baseUrl is required for probe", durationMs: 0 };
  }
  const baseUrl = connection.baseUrl;

  return withSecretSeal(extractSecretValues(data), async () => {
  const path = probePath && probePath.trim() ? probePath.trim() : "/";
  let target: ResolvedTarget;
  try {
    const urlStr = buildUrl(baseUrl, path, {}, {});
    target = await resolveSafeSynthesizedTarget(urlStr);
  } catch (err) {
    return {
      ok: false,
      error: `URL safety check failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - started,
    };
  }

  const headersObj: Record<string, string> = { Accept: "application/json" };
  if (connection.headers) {
    for (const [k, v] of Object.entries(connection.headers)) {
      headersObj[stripCrlf(k)] = stripCrlf(v);
    }
  }
  applyAuth(headersObj, target.url, connection.auth, data);

  let response: PinnedResponse;
  try {
    response = await pinnedHttpsRequest({
      target,
      method: "GET",
      headers: headersObj,
      timeoutMs,
      maxBytes: 64 * 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      probedUrl: target.url.toString(),
      error: `network error: ${msg}`,
      durationMs: Date.now() - started,
    };
  }

  const bodyPreview = response.body.toString("utf-8").slice(0, 500);
  const status = response.status;
  const probedUrl = target.url.toString();

  if (status >= 200 && status < 400) {
    return { ok: true, status, probedUrl, durationMs: Date.now() - started };
  }
  // 404 with no probePath: ambiguous — the host responded, the credential may still be valid.
  if (status === 404 && !probePath) {
    return {
      ok: true,
      status,
      probedUrl,
      bodyPreview: "host reachable, root path returned 404 — credential not validated, but baseUrl works",
      durationMs: Date.now() - started,
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status,
      probedUrl,
      bodyPreview,
      error: `auth rejected (${status}) — check the credential value and auth scheme`,
      durationMs: Date.now() - started,
    };
  }
  return {
    ok: false,
    status,
    probedUrl,
    bodyPreview,
    error: `HTTP ${status} ${response.statusText}`,
    durationMs: Date.now() - started,
  };
  });
}
