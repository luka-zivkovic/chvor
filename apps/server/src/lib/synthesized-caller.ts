/**
 * Executes a single endpoint call against a synthesized tool.
 *
 * Pipeline:
 *  1. Resolve credential + ConnectionConfig.
 *  2. Build URL from baseUrl + path + pathParams + queryParams.
 *  3. Network safety (HTTPS-only unless overridden, block private IPs after DNS resolution).
 *  4. Apply auth per connection_config.auth.scheme.
 *  5. For non-GET, go through approval-gate.requestApproval.
 *  6. Fetch with timeout. Truncate oversized responses. Classify 4xx auth failures.
 */

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Tool, SynthesizedEndpoint, ConnectionConfig } from "@chvor/shared";
import { getCredentialData, listCredentials } from "../db/credential-store.ts";
import { isPrivateIp } from "./url-safety.ts";
import { logError } from "./error-logger.ts";
import {
  requestApproval,
  recordSuccess,
  recordFailure,
  getSessionStats,
} from "./approval-gate.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 200 * 1024; // 200KB
const TRUNCATION_PREVIEW_BYTES = 4 * 1024; // 4KB
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

function findCredentialIdByType(credentialType: string): string | null {
  try {
    const creds = listCredentials();
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

export async function assertSafeSynthesizedUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`non-HTTPS blocked (got ${parsed.protocol}) — synthesized tool calls require HTTPS`);
  }
  // Block IP literals — hostname must be DNS-resolvable
  if (/^[0-9.]+$/.test(parsed.hostname) || parsed.hostname.includes(":")) {
    throw new Error(`IP literal hostname blocked: ${parsed.hostname}`);
  }
  if (!ALLOW_PRIVATE) {
    const { address } = await lookup(parsed.hostname);
    if (isPrivateIp(address)) {
      throw new Error(`private/link-local address blocked: ${parsed.hostname} → ${address}`);
    }
  }
  return parsed;
}

// ── Auth application ───────────────────────────────────────────

function applyAuth(
  headers: Headers,
  url: URL,
  auth: ConnectionConfig["auth"],
  data: Record<string, string>,
): { url: URL; headers: Headers } {
  const apiKey = data.apiKey ?? data.token ?? data.accessToken ?? "";

  const renderTemplate = (template: string | undefined, fallback: string): string => {
    const t = template ?? fallback;
    return t.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => data[k] ?? "");
  };

  switch (auth.scheme) {
    case "bearer":
      headers.set("Authorization", renderTemplate(auth.headerTemplate, `Bearer ${apiKey}`));
      break;
    case "api-key-header":
      headers.set(auth.headerName ?? "x-api-key", renderTemplate(auth.headerTemplate, apiKey));
      break;
    case "basic": {
      const user = data.username ?? "";
      const pass = data.password ?? apiKey;
      headers.set("Authorization", `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`);
      break;
    }
    case "query-param":
      url.searchParams.set(auth.queryParam ?? "api_key", apiKey);
      break;
    case "custom":
      if (auth.headerName && auth.headerTemplate) {
        headers.set(auth.headerName, renderTemplate(auth.headerTemplate, apiKey));
      }
      break;
  }

  return { url, headers };
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

  // All endpoints on this tool have failed and none have succeeded → wrong auth scheme
  if (status === 401 && stats.toolSuccessCount === 0 && stats.toolFailureCount >= 1) {
    return {
      error: "auth_failed",
      status,
      likelyCause: "wrong_auth_scheme",
      userFacingHint: `Can't authenticate to ${tool.metadata.name} with the current credential. The auth scheme in the tool config may be wrong — try calling native__repair_synthesized_tool, or check the ${tool.metadata.name} docs.`,
      aiGuidance: "Try native__repair_synthesized_tool once before asking the user to re-enter credentials.",
    };
  }

  // Some other endpoint on this tool has succeeded → scope issue, not cred issue
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

  // Resolve credential
  const credType = tool.synthesized.credentialType;
  const credId = findCredentialIdByType(credType);
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

  // Build URL + safety check
  let resolvedUrl: URL;
  try {
    const urlStr = buildUrl(connection.baseUrl, endpoint.path, pathParams, queryParams);
    resolvedUrl = await assertSafeSynthesizedUrl(urlStr);
  } catch (err) {
    return {
      ok: false,
      error: `URL safety check failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - started,
    };
  }

  // Apply auth
  const headers = new Headers();
  headers.set("Accept", "application/json");
  if (bodyValue !== undefined) headers.set("Content-Type", "application/json");
  if (connection.headers) {
    for (const [k, v] of Object.entries(connection.headers)) headers.set(k, v);
  }
  applyAuth(headers, resolvedUrl, connection.auth, cred.data);

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
      resolvedUrl: resolvedUrl.toString(),
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

  // Execute
  const callId = randomUUID();
  let response: Response;
  try {
    response = await fetch(resolvedUrl.toString(), {
      method: endpoint.method,
      headers,
      body: bodyValue !== undefined ? JSON.stringify(bodyValue) : undefined,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("mcp_crash" as const, msg, {
      kind: "synthesized_call",
      callId,
      toolId: tool.id,
      endpoint: endpoint.name,
      host: resolvedUrl.hostname,
    });
    recordFailure(context.sessionId, tool.id, endpoint.name);
    return { ok: false, error: `network error: ${msg}`, durationMs: Date.now() - started };
  }

  // Read with cap
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  if (reader) {
    try {
      while (size < MAX_RESPONSE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          size += value.byteLength;
        }
      }
      if (size >= MAX_RESPONSE_BYTES) {
        truncated = true;
        try { await reader.cancel(); } catch { /* ignore */ }
      }
    } finally {
      reader.releaseLock();
    }
  }
  const rawText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");

  logError("mcp_crash" as const, "", {
    kind: "synthesized_call",
    callId,
    toolId: tool.id,
    endpoint: endpoint.name,
    method: endpoint.method,
    host: resolvedUrl.hostname,
    status: response.status,
    durationMs: Date.now() - started,
  });

  // Parse body
  let parsed: unknown;
  const contentType = response.headers.get("content-type") ?? "";
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

  // Auth error → classify
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
      error: `${response.status} ${response.statusText}: ${typeof rawText === "string" ? rawText.slice(0, 500) : ""}`,
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
